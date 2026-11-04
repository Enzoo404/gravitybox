import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicText } from '../dist/files.js';
import { createHash } from 'node:crypto';
import { validateEntries } from '../dist/dictionary.js';
const source = process.argv[2];
if (!source) throw new Error('请明确指定本地词典目录');
const entries = Object.create(null), conflicts = [], excluded = [], sources = [];
for (const name of (await readdir(source)).filter(name => name.endsWith('.json')).sort()) {
  const text = await readFile(join(source, name), 'utf8');
  sources.push({ file: name, sha256: createHash('sha256').update(text).digest('hex') });
  for (const [rawKey, value] of Object.entries(JSON.parse(text))) {
    const key = rawKey.replace(/\s+/g, ' ').trim();
    if (typeof value !== 'string' || !/[\u3400-\u9fff]/.test(value) || /^(?:Antigravity|Gemini|Claude|GPT|\d)/i.test(key) || key.includes('@') || /https?:\/\//.test(key)) { excluded.push({ key, file: name, reason: '技术标识、无中文译文或敏感格式' }); continue; }
    try { validateEntries({ [key]: value }, name); } catch { excluded.push({ key, file: name, reason: '格式或占位符需人工核对' }); continue; }
    if (Object.hasOwn(entries, key) && entries[key] !== value) { conflicts.push({ key, file: name, kept: entries[key], alternative: value }); continue; }
    entries[key] = value;
  }
}
const option=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const out=option('--out')??fileURLToPath(new URL('../dict/base.json',import.meta.url));
const text=JSON.stringify(Object.fromEntries(Object.entries(entries).sort(([a],[b])=>a.localeCompare(b))),null,2)+'\n';
let previous;
try {previous=await readFile(out,'utf8');validateEntries(JSON.parse(previous));}
catch(error){if(error.code!=='ENOENT')throw Error('目标词典无法读取，原文件已保留');}
if(process.argv.includes('--dry-run')){console.log(JSON.stringify({dryRun:true,out,count:Object.keys(entries).length}));}
else {
  if(previous!==undefined&&!process.argv.includes('--force'))throw Error('目标词典已存在，请核对后使用 --force；原文件未改变');
  if(previous!==undefined)await atomicText(join(dirname(out),'.backups',basename(out)+'.'+Date.now()+'.json'),previous);
  await atomicText(out,text);
  const report=join(dirname(out),'.imports','legacy-'+Date.now()+'.json');await atomicText(report,JSON.stringify({importedAt:new Date().toISOString(),count:Object.keys(entries).length,sources,conflicts,excluded},null,2)+'\n');
  console.log(JSON.stringify({imported:Object.keys(entries).length,conflicts:conflicts.length,excluded:excluded.length,out}));
}
