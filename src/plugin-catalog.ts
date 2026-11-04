import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export type PluginText = { id: string; name: string; description: string; source: 'installed-manifest' | 'marketplace-view' | 'installed-view'; truncated: boolean; onlineEligible: false };
export type PluginCatalog = { entries: PluginText[]; inspectedFiles: number; skipped: number; limited: boolean; notes: string[] };
const clean = (s: unknown, limit: number) => typeof s === 'string' ? s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim().slice(0,limit) : '';
const safeText = (s: string) => !/(?:\b(?:sk-|AIza)[\w-]{12,}|-----BEGIN .+PRIVATE KEY|\bBearer\s+\S+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|https?:\/\/\S+[?&](?:key|token|secret)=)/i.test(s);
export function pluginDisplay(data: unknown, fallback: string): PluginText | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const value = data as Record<string, unknown>;
  const id = clean(value.name,120) || fallback;
  if (!/^[a-zA-Z0-9_.-]{1,120}$/.test(id)) return;
  const name = clean(value.displayName,160) || id, description = clean(value.description,2000);
  if (!description || !safeText(name) || !safeText(description)) return;
  return {id,name,description,source:'installed-manifest',truncated:typeof value.description==='string'&&value.description.length>2000,onlineEligible:false};
}
export function appendPluginViews(catalog: PluginCatalog, rows: unknown) {
  if (!Array.isArray(rows)) return;
  const seen = new Set(catalog.entries.map(p=>p.id+'\0'+p.description));
  for(const row of rows.slice(0,250)) {
    if(!row||!['marketplace-view','installed-view'].includes(row.source))continue;
    const value=pluginDisplay({name:row.id,displayName:row.name,description:row.description},'');if(!value)continue;
    const key=value.id+'\0'+value.description;if(seen.has(key))continue;
    if(catalog.entries.length>=1000){catalog.limited=true;break;}
    catalog.entries.push({...value,source:row.source,truncated:!!row.truncated||value.truncated});seen.add(key);
  }
}
export async function readPluginCatalog(root: string, signal: AbortSignal): Promise<PluginCatalog> {
  const catalog: PluginCatalog={entries:[],inspectedFiles:0,skipped:0,limited:false,notes:['仅读取插件清单的名称和展示说明，不读取规则、凭据、MCP 配置或执行代码。','说明只保存在本机报告中，不自动进入在线补译。']};
  let base: string;
  try { const info=await lstat(root);if(info.isSymbolicLink()||!info.isDirectory())throw new Error();base=await realpath(root); } catch { catalog.notes.push('已安装插件目录不可用；仍可采集已打开的目录页面。');return catalog; }
  const names=await readdir(base,{withFileTypes:true});
  for(const entry of names.sort((a,b)=>a.name.localeCompare(b.name)).slice(0,500)) {
    signal.throwIfAborted();if(entry.isSymbolicLink()||!entry.isDirectory()){catalog.skipped++;continue;}
    const path=join(base,entry.name,'plugin.json');let handle;
    try {
      const parent=await realpath(join(base,entry.name)),rel=relative(base,parent);
      if(!rel||rel.startsWith('..'+sep)||rel==='..')throw new Error();
      const info=await lstat(path);if(info.isSymbolicLink()||!info.isFile()||info.size>262144)throw new Error();
      handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await handle.stat();
      if(stat.ino!==info.ino||stat.dev!==info.dev||stat.size>262144)throw new Error();
      const buffer=Buffer.alloc(stat.size+1);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);if(bytesRead>262144)throw new Error();signal.throwIfAborted();
      catalog.inspectedFiles++;const value=pluginDisplay(JSON.parse(buffer.subarray(0,bytesRead).toString()),entry.name);if(value)catalog.entries.push(value);else catalog.skipped++;
    }catch(error){signal.throwIfAborted();catalog.skipped++;}finally{await handle?.close();}
  }
  catalog.limited=names.length>500;return catalog;
}
