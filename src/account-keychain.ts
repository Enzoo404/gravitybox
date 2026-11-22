import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { bt } from './i18n.js';
import { isLinux } from './platform.js';

const execFileAsync = promisify(execFile);

export interface KeychainAdapter {
  readPassword(service: string, account: string): Promise<string | null>;
  writePassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<void>;
}

const LINUX_LIBSECRET_PY = `
import sys
import gi
gi.require_version('Secret', '1')
from gi.repository import Secret

schema = Secret.Schema.new(
    'org.freedesktop.Secret.Generic',
    Secret.SchemaFlags.NONE,
    {
        'service': Secret.SchemaAttributeType.STRING,
        'username': Secret.SchemaAttributeType.STRING,
    },
)
op = sys.argv[1]
service = sys.argv[2]
account = sys.argv[3]
attrs = {'service': service, 'username': account}
if op == 'read':
    val = Secret.password_lookup_sync(schema, attrs, None)
    if val is not None:
        sys.stdout.write(val)
elif op == 'write':
    secret = sys.stdin.read()
    label = f"Password for '{account}' on '{service}'"
    ok = Secret.password_store_sync(schema, attrs, Secret.COLLECTION_DEFAULT, label, secret, None)
    if not ok:
        sys.exit(1)
elif op == 'delete':
    Secret.password_clear_sync(schema, attrs, None)
else:
    sys.exit(2)
`;

function resolveLinuxPythonBinary(): string | null {
  for (const p of ['/usr/bin/python3', '/usr/local/bin/python3']) {
    if (existsSync(p)) return p;
  }
  return null;
}

function resolveSecretToolBinary(): string | null {
  for (const p of ['/usr/bin/secret-tool', '/usr/local/bin/secret-tool']) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Linux Freedesktop Secret Service adapter (gnome-keyring / KWallet) compatible with `zalando/go-keyring`
 * (`org.freedesktop.Secret.Generic`, attributes `service` + `username`).
 * Credentials are passed exclusively via stdin/stdout and never placed in argv.
 */
export class LinuxSecretServiceKeychainAdapter implements KeychainAdapter {
  private runWithStdin(bin: string, args: string[], stdinPayload: string, errKey: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(stdout);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish(new Error(bt(errKey === 'keychain.err.write' ? 'keychain.err.write_timeout' : errKey)));
      }, 5000);
      child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => {});
      child.stdin.end(stdinPayload, 'utf8');
      child.on('close', code => {
        if (code === 0) finish();
        else finish(new Error(bt(errKey)));
      });
      child.on('error', () => finish(new Error(bt(errKey))));
    });
  }

  async readPassword(service: string, account: string): Promise<string | null> {
    const py = resolveLinuxPythonBinary();
    if (py) {
      try {
        const { stdout } = await execFileAsync(py, ['-c', LINUX_LIBSECRET_PY, 'read', service, account], { timeout: 5000 });
        return stdout.trim() || null;
      } catch {}
    }
    const secretTool = resolveSecretToolBinary();
    if (secretTool) {
      try {
        const { stdout } = await execFileAsync(secretTool, ['lookup', 'service', service, 'username', account], { timeout: 5000 });
        return stdout.trim() || null;
      } catch (error) {
        if ((error as { code?: number }).code === 1) return null;
        throw new Error(bt('keychain.err.read'));
      }
    }
    throw new Error(bt('keychain.err.read'));
  }

  async writePassword(service: string, account: string, password: string): Promise<void> {
    const py = resolveLinuxPythonBinary();
    if (py) {
      try {
        await this.runWithStdin(py, ['-c', LINUX_LIBSECRET_PY, 'write', service, account], password, 'keychain.err.write');
        return;
      } catch {}
    }
    const secretTool = resolveSecretToolBinary();
    if (secretTool) {
      await this.runWithStdin(
        secretTool,
        ['store', `--label=Password for '${account}' on '${service}'`, 'service', service, 'username', account],
        password,
        'keychain.err.write',
      );
      return;
    }
    throw new Error(bt('keychain.err.write'));
  }

  async deletePassword(service: string, account: string): Promise<void> {
    const py = resolveLinuxPythonBinary();
    if (py) {
      try {
        await execFileAsync(py, ['-c', LINUX_LIBSECRET_PY, 'delete', service, account], { timeout: 5000 });
        return;
      } catch {}
    }
    const secretTool = resolveSecretToolBinary();
    if (secretTool) {
      try {
        await execFileAsync(secretTool, ['clear', 'service', service, 'username', account], { timeout: 5000 });
        return;
      } catch {
        throw new Error(bt('keychain.err.delete'));
      }
    }
    throw new Error(bt('keychain.err.delete'));
  }
}

export class SystemKeychainAdapter implements KeychainAdapter {
  private readonly linuxAdapter = isLinux ? new LinuxSecretServiceKeychainAdapter() : null;

  async readPassword(service: string, account: string): Promise<string | null> {
    if (this.linuxAdapter) return this.linuxAdapter.readPassword(service, account);
    try {
      const { stdout } = await execFileAsync('/usr/bin/security', [
        'find-generic-password',
        '-s',
        service,
        '-a',
        account,
        '-w',
      ], { timeout: 5000 });
      return stdout.trim() || null;
    } catch (error) {
      if ((error as { code?: number }).code === 44) return null;
      throw new Error(bt('keychain.err.read'));
    }
  }

  async writePassword(service: string, account: string, password: string): Promise<void> {
    if (this.linuxAdapter) return this.linuxAdapter.writePassword(service, account, password);
    return new Promise((resolve, reject) => {
      const q = (val: string) => `"${String(val).replace(/[\\"\r\n]/g, m => (m === '\r' || m === '\n' ? '' : `\\${m}`))}"`;
      // 通过 security -i 批处理从 stdin 传入完整命令与密码，既不在 argv 暴露凭据，也不触发 /dev/tty getpass() 阻塞
      const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish(new Error(bt('keychain.err.write_timeout')));
      }, 5000);

      child.stdin.on('error', () => {});
      child.stdin.end(`add-generic-password -U -s ${q(service)} -a ${q(account)} -w ${q(password)}\n`);

      child.stderr.on('data', () => {});
      child.on('close', code => {
        if (code === 0) finish();
        else finish(new Error(bt('keychain.err.write')));
      });
      child.on('error', () => {
        finish(new Error(bt('keychain.err.write')));
      });
    });
  }

  async deletePassword(service: string, account: string): Promise<void> {
    if (this.linuxAdapter) return this.linuxAdapter.deletePassword(service, account);
    try {
      await execFileAsync('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', account], { timeout: 5000 });
    } catch (error) { if ((error as { code?: number }).code !== 44) throw new Error(bt('keychain.err.delete')); }
  }
}

export class MockKeychainAdapter implements KeychainAdapter {
  private store = new Map<string, string>();

  async readPassword(service: string, account: string): Promise<string | null> {
    return this.store.get(`${service}:${account}`) ?? null;
  }

  async writePassword(service: string, account: string, password: string): Promise<void> {
    this.store.set(`${service}:${account}`, password);
  }

  async deletePassword(service: string, account: string): Promise<void> {
    this.store.delete(`${service}:${account}`);
  }
}

export interface KeychainSyncAccount {
  email: string;
  token: {
    access_token: string;
    token_type?: string;
    refresh_token: string;
    expiry_timestamp: number;
    expires_in?: number;
    project_id?: string | null;
    is_gcp_tos?: boolean;
    id_token?: string | null;
  };
}

/**
 * 构造官方 Go 端 (macOS Keychain & agy CLI) 通用 oauth2.Token JSON 载荷
 */
export function buildGoOauthPayload(acc: KeychainSyncAccount): string {
  // 官方 Go 端按 oauth2.Token 解析：缺少 `expiry` 会被视为永不过期，从而永不刷新（约 1 小时后 401 并跳登录页）。
  // 因此必须写入 RFC3339 `expiry`；旧字段保留供 GravityBox 自身读取与回滚。
  const expirySec = Number(acc.token.expiry_timestamp);
  const expiry = Number.isFinite(expirySec) && expirySec > 0 ? new Date(expirySec * 1000).toISOString() : new Date(0).toISOString();
  const expiresIn = expirySec > 0 ? Math.max(0, Math.floor(expirySec - Date.now() / 1000)) : (acc.token.expires_in ?? 0);
  const accessToken = acc.token.access_token && acc.token.access_token !== 'pending_refresh' ? acc.token.access_token : '';
  return JSON.stringify({
    token: {
      access_token: accessToken,
      token_type: acc.token.token_type || 'Bearer',
      refresh_token: acc.token.refresh_token,
      expiry,
      expires_in: expiresIn,
      expiry_timestamp: Number.isFinite(expirySec) && expirySec > 0 ? expirySec : 0,
      email: acc.email,
      project_id: acc.token.project_id,
      is_gcp_tos: acc.token.is_gcp_tos,
      id_token: acc.token.id_token,
    },
    ...(acc.token.is_gcp_tos ? {} : { auth_method: 'consumer' }),
    id_token_email: acc.email,
  });
}

/**
 * 将指定账号写入系统 Keychain (gemini/antigravity) 免密持久化
 */
export async function syncAccountToKeychain(
  acc: KeychainSyncAccount,
  keychain: KeychainAdapter = new SystemKeychainAdapter()
): Promise<void> {
  const payload = buildGoOauthPayload(acc);
  const b64 = Buffer.from(payload, 'utf8').toString('base64');
  await keychain.writePassword('gemini', 'antigravity', `go-keyring-base64:${b64}`);
}
