import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface KeychainAdapter {
  readPassword(service: string, account: string): Promise<string | null>;
  writePassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<void>;
}

export class SystemKeychainAdapter implements KeychainAdapter {
  async readPassword(service: string, account: string): Promise<string | null> {
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
      throw new Error('无法读取账号钥匙串，请检查本机访问权限');
    }
  }

  async writePassword(service: string, account: string, password: string): Promise<void> {
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
        finish(new Error('无法保存账号钥匙串，访问超时'));
      }, 5000);

      child.stdin.on('error', () => {});
      child.stdin.end(`add-generic-password -U -s ${q(service)} -a ${q(account)} -w ${q(password)}\n`);

      child.stderr.on('data', () => {});
      child.on('close', code => {
        if (code === 0) finish();
        else finish(new Error('无法保存账号钥匙串，原凭据访问权限可能受限'));
      });
      child.on('error', () => {
        finish(new Error('无法保存账号钥匙串，原凭据访问权限可能受限'));
      });
    });
  }

  async deletePassword(service: string, account: string): Promise<void> {
    try {
      await execFileAsync('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', account], { timeout: 5000 });
    } catch (error) { if ((error as { code?: number }).code !== 44) throw new Error('无法恢复账号钥匙串'); }
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
 * 将指定账号写入系统 Keychain (gemini/antigravity) 免密持久化
 */
export async function syncAccountToKeychain(
  acc: KeychainSyncAccount,
  keychain: KeychainAdapter = new SystemKeychainAdapter()
): Promise<void> {
  // 官方 Go 端按 oauth2.Token 解析：缺少 `expiry` 会被视为永不过期，从而永不刷新（约 1 小时后 401 并跳登录页）。
  // 因此必须写入 RFC3339 `expiry`；旧字段保留供 GravityBox 自身读取与回滚。
  const expirySec = Number(acc.token.expiry_timestamp);
  const expiry = Number.isFinite(expirySec) && expirySec > 0 ? new Date(expirySec * 1000).toISOString() : undefined;
  const expiresIn = expirySec > 0 ? Math.max(0, Math.floor(expirySec - Date.now() / 1000)) : acc.token.expires_in;
  const payload = JSON.stringify({
    token: {
      access_token: acc.token.access_token,
      token_type: acc.token.token_type || 'Bearer',
      refresh_token: acc.token.refresh_token,
      expiry,
      expires_in: expiresIn,
      expiry_timestamp: acc.token.expiry_timestamp,
      email: acc.email,
      project_id: acc.token.project_id,
      is_gcp_tos: acc.token.is_gcp_tos,
      id_token: acc.token.id_token,
    },
    ...(acc.token.is_gcp_tos ? {} : { auth_method: 'consumer' }),
    id_token_email: acc.email,
  });
  const b64 = Buffer.from(payload, 'utf8').toString('base64');
  await keychain.writePassword('gemini', 'antigravity', `go-keyring-base64:${b64}`);
}
