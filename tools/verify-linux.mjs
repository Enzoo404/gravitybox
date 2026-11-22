import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectReleaseArtifacts, sourceDigest } from './release-integrity.mjs';
import { recordedScopeFields, resolveValidationScope } from './release-scope.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

async function step(name, binary, args, opts = {}) {
  const started = performance.now();
  process.stdout.write(`[verify-linux] -> ${name}\n`);
  await run(binary, args, { cwd: root, maxBuffer: 20 * 1024 * 1024, ...opts });
  const ms = Math.round(performance.now() - started);
  process.stdout.write(`[verify-linux] ok ${name} (${ms}ms)\n`);
  return { name, ms };
}

async function main() {
  if (process.platform !== 'linux') {
    throw new Error('verify-linux 仅适用于 Linux 平台');
  }
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const version = pkg.version;
  const initialDigest = await sourceDigest(root);
  const timings = [];

  timings.push(await step('隐私安全门禁', process.execPath, [join(root, 'tools/check-privacy.mjs')]));
  timings.push(await step('构建 TypeScript 与运行时', 'npm', ['run', 'build']));
  timings.push(await step('同步价格目录', process.execPath, [join(root, 'tools/sync-pricing-feed.mjs')]));
  timings.push(await step('Python PyQt5 语法检查', '/usr/bin/python3', [
    '-m', 'py_compile',
    'linux/gravitybox/__init__.py',
    'linux/gravitybox/__main__.py',
    'linux/gravitybox/paths.py',
    'linux/gravitybox/l10n.py',
    'linux/gravitybox/backend.py',
    'linux/gravitybox/antigravity_ctl.py',
    'linux/gravitybox/theme.py',
    'linux/gravitybox/widgets.py',
    'linux/gravitybox/dialogs.py',
    'linux/gravitybox/pages.py',
    'linux/gravitybox/app.py',
  ]));
  timings.push(await step('单元与集成测试 (--fast)', process.execPath, [join(root, 'tools/run-tests.mjs'), '--fast']));

  const { SUPPORTED_BUNDLES } = await import(pathToFileURL(join(root, 'dist', 'bundle.js')).href);
  const supportedVersions = [...SUPPORTED_BUNDLES.keys()];
  const scope = resolveValidationScope([], supportedVersions);

  const digest = await sourceDigest(root);
  if (digest !== initialDigest) {
    throw new Error('验证期间源码发生变化，请重新运行 npm run verify:linux');
  }

  await mkdir(join(root, '.cache'), { recursive: true });
  await writeFile(
    join(root, '.cache', 'verified-linux-release.json'),
    JSON.stringify({
      platform: 'linux',
      arch: process.arch,
      digest,
      artifacts: await collectReleaseArtifacts(root),
      at: new Date().toISOString(),
      version,
      timings,
      ...recordedScopeFields(scope),
    }, null, 2) + '\n',
    'utf8',
  );
  process.stdout.write(`[verify-linux] 全部 Linux 验证门禁通过 (v${version}, digest=${digest.slice(0, 12)})\n`);
}

const invokedDirectly = typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(error => {
    console.error(`[verify-linux] ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
