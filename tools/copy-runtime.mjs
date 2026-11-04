import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/**
 * 由 runtime/ 合并生成到 dist/ 的产物（无 src/*.ts 对应）。
 * tools/clean-dist.mjs 必须保留这些文件，不能当作孤儿删除。
 */
export const GENERATED_DIST_FILES = ['engine.js'];

export async function copyRuntime(distUrl = new URL('../dist/', import.meta.url)) {
  const sources = await Promise.all(['engine.js', 'deep-scan.js'].map(name => readFile(new URL('../runtime/' + name, import.meta.url), 'utf8')));
  await writeFile(new URL('engine.js', distUrl), sources.join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await copyRuntime();
