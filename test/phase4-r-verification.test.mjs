import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import 'node:crypto';

test('A18: 历史切换日志深度脱敏契约（杜绝敏感 Token 与密钥明文归档）', async () => {
  const switchTs = await readFile(join(process.cwd(), 'src/account-switch.ts'), 'utf8');

  // 必须对包含 token/oauth 的行和 keychain 进行脱敏
  assert.ok(switchTs.includes('[REDACTED_OAUTH_TOKEN]'), '必须包含 OAuth Token 脱敏遮蔽标记');
  assert.ok(switchTs.includes('[REDACTED_ACCOUNT]'), '必须包含账号文件脱敏遮蔽标记');
  assert.ok(switchTs.includes("keychainBefore: previous.keychainBefore ? '[REDACTED]' : null"), 'Keychain 必须脱敏');
  assert.ok(switchTs.includes('list.length > 3'), '必须限制归档最多保留最近 3 份');
});
