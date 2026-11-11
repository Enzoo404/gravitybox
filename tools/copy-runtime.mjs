import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';

/**
 * 由 runtime/ 合并生成到 dist/ 的产物（无 src/*.ts 对应）。
 * tools/clean-dist.mjs 必须保留这些文件，不能当作孤儿删除。
 */
export const GENERATED_DIST_FILES = ['engine.js'];

const HUD_RUNTIME_FILES = [
  'hud-styles.js',
  'hud-popover.js',
  'hud-instance.js',
  'hud-manager.js',
];

/**
 * 将支持 Node.js ESM import 的 runtime/hud-*.js 转换为可在 CDP Isolated World 经典脚本上下文直接执行的 IIFE
 */
function stripEsmForClassicRuntime(code) {
  return code
    .replace(/^\s*import\s+[^;]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*export\s+(?=(?:const|let|var|function|class)\s+)/gm, '')
    .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '');
}

export async function copyRuntime(distUrl = new URL('../dist/', import.meta.url)) {
  const baseSources = await Promise.all(
    ['engine.js', 'deep-scan.js'].map((name) =>
      readFile(new URL('../runtime/' + name, import.meta.url), 'utf8')
    )
  );
  const hudSources = await Promise.all(
    HUD_RUNTIME_FILES.map(async (name) => {
      const raw = await readFile(new URL('../runtime/' + name, import.meta.url), 'utf8');
      return stripEsmForClassicRuntime(raw);
    })
  );
  const formatSource = stripEsmForClassicRuntime(await readFile(new URL('metric-format.js', distUrl), 'utf8'));
  const hudBundle = `(function bootstrapGravityBoxHud() {\n'use strict';\n${formatSource}\n${hudSources.join('\n')}\n})();`;
  const mergedSource = [...baseSources, hudBundle].join('\n');
  new Script(mergedSource, { filename: 'GravityBox-runtime.js' });
  await writeFile(new URL('engine.js', distUrl), mergedSource);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await copyRuntime();
