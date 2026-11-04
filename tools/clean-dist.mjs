import { readdir, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { GENERATED_DIST_FILES } from './copy-runtime.mjs';

/**
 * dist 孤儿清理：只删除 `dist/**\/*.js` 中「没有同名 src/**\/*.ts 对应」且不在白名单里的文件。
 * - 白名单只放构建期生成物（engine.js 由 tools/copy-runtime.mjs 生成），资源/运行时文件不是 .js，不会被触碰。
 * - 默认 dry-run 之外的行为只有删除孤儿；缺失 src/dist 目录时视为无孤儿，不报错。
 */
const defaultRoot = fileURLToPath(new URL('../', import.meta.url));

async function listFiles(dir) {
  const result = [];
  async function walk(relative = '') {
    let entries;
    try { entries = await readdir(join(dir, relative), { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const next = relative ? join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) result.push(next.split('\\').join('/'));
    }
  }
  await walk();
  return result;
}

export async function planDistCleanup({ projectRoot = defaultRoot, srcDir = 'src', distDir = 'dist', whitelist = GENERATED_DIST_FILES } = {}) {
  const srcFiles = (await listFiles(join(projectRoot, srcDir))).filter(file => file.endsWith('.ts'));
  const expected = new Set(srcFiles.map(file => file.replace(/\.ts$/, '.js')));
  const keep = new Set(whitelist);
  const distFiles = (await listFiles(join(projectRoot, distDir))).filter(file => file.endsWith('.js'));
  const orphans = distFiles.filter(file => !expected.has(file) && !keep.has(file)).sort();
  return { expected: [...expected].sort(), whitelist: [...keep], orphans };
}

export async function cleanDist(options = {}) {
  const plan = await planDistCleanup(options);
  const projectRoot = options.projectRoot ?? defaultRoot;
  const distDir = options.distDir ?? 'dist';
  for (const relative of plan.orphans) await rm(join(projectRoot, distDir, ...relative.split('/')), { force: true });
  return { ...plan, removed: plan.orphans };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dryRun = process.argv.includes('--dry-run');
  const plan = dryRun ? await planDistCleanup() : await cleanDist();
  if (!plan.orphans.length) process.stdout.write('dist 与 src 对应，无孤儿文件\n');
  else for (const file of plan.orphans) process.stdout.write(`${dryRun ? '将清理' : '已清理'} dist/${file}（无 src 对应）\n`);
}
