import { readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);

/** UI harness and release binary use the same optimized native build settings. */
export async function nativeBuildArgs(root, output, { uiTest = false, typecheck = false } = {}) {
  const sources = (await readdir(join(root, 'native')))
    .filter(name => name.endsWith('.swift')).sort().map(name => join(root, 'native', name));
  return [
    ...(typecheck ? ['-typecheck'] : ['-O', '-whole-module-optimization']),
    ...(uiTest ? ['-D', 'NATIVE_UI_TEST'] : []),
    '-parse-as-library', '-target', 'arm64-apple-macosx14.0',
    ...['Cocoa', 'ServiceManagement', 'Security', 'ApplicationServices'].flatMap(name => ['-framework', name]),
    ...sources,
    ...(uiTest ? [join(root, 'test/native-ui.swift')] : []),
    ...(typecheck || !output ? [] : ['-o', output]),
  ];
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const uiTest = process.argv.includes('--ui-test');
  const typecheck = process.argv.includes('--typecheck');
  if (!typecheck) {
    console.error('用法: node tools/native-build.mjs --typecheck [--ui-test]');
    process.exit(1);
  }
  const started = performance.now();
  const args = await nativeBuildArgs(root, undefined, { typecheck: true, uiTest });
  await run('/usr/bin/swiftc', args, { cwd: root, maxBuffer: 4e6 });
  console.log(`Swift 类型检查通过（${((performance.now() - started) / 1000).toFixed(2)} 秒）`);
}
