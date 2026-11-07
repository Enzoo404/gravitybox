import { createWriteStream, existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fileSha256 } from './release-integrity.mjs';

// Update version and both hashes together after checking Google's Chrome for Testing download.
export const TEST_CHROME_VERSION = '157.0.8103.38';
const archiveHash = 'e6a6b13551aa12f951d0891d79282606b13742837c8fa0505e1272bae116ce82';
const binaryHash = 'ed0e3d67ce3cc2528acb7290ebe86181c144890ff7f610e86268317c6139d518';
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = join(root, '.cache', `test-chrome-${TEST_CHROME_VERSION}-mac-arm64`);
export const TEST_CHROME_PATH = join(destination, 'chrome-headless-shell');

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('固定测试浏览器目前支持 macOS ARM64；其他环境请通过 CHROME_BIN 指定兼容的测试浏览器');
  if (!existsSync(TEST_CHROME_PATH)) {
    await mkdir(join(root, '.cache'), { recursive: true });
    const stage = await mkdtemp(join(root, '.cache', 'chrome-download-'));
    try {
      const archive = join(stage, 'chrome.zip');
      const url = `https://storage.googleapis.com/chrome-for-testing-public/${TEST_CHROME_VERSION}/mac-arm64/chrome-headless-shell-mac-arm64.zip`;
      const response = await fetch(url, { signal: AbortSignal.timeout(120000), redirect: 'error' });
      if (!response.ok || !response.body) throw Error(`Chrome for Testing 下载失败 (${response.status})`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
      if (await fileSha256(archive) !== archiveHash) throw Error('测试浏览器压缩包 SHA-256 不符，已拒绝安装');
      await promisify(execFile)('/usr/bin/unzip', ['-q', archive, '-d', stage]);
      if (await fileSha256(join(stage, 'chrome-headless-shell-mac-arm64/chrome-headless-shell')) !== binaryHash) throw Error('测试浏览器二进制 SHA-256 不符');
      await rename(join(stage, 'chrome-headless-shell-mac-arm64'), destination);
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  if (await fileSha256(TEST_CHROME_PATH) !== binaryHash) throw Error('缓存的测试浏览器已变化；请核对缓存，不会自动覆盖');
  if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `CHROME_BIN=${TEST_CHROME_PATH}\n`);
  console.log(`Chrome Headless Shell ${TEST_CHROME_VERSION} 已校验：${TEST_CHROME_PATH}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(`[test-browser] ${error.message}`); process.exitCode = 1; });
