import type { PluginCatalog } from './plugin-catalog.js';
export const DEEP_STEPS = [
  {id:'model-open',name:'模型菜单'}, {id:'model-usage',name:'用量子菜单'}, {id:'model-close',name:'关闭本轮菜单'},
  {id:'history',name:'历史列表'}, {id:'marketplace',name:'插件市场'}, {id:'installed',name:'已安装插件'},
  {id:'settings-open',name:'打开设置'}, {id:'settings-general',name:'通用设置'}, {id:'settings-app',name:'应用设置'},
  {id:'settings-appearance',name:'外观设置'}, {id:'settings-models',name:'模型与用量'}, {id:'settings-shortcuts',name:'快捷键'},
  {id:'settings-close',name:'关闭本轮设置'}, {id:'automations',name:'自动化列表'}
] as const;
export type DeepStep = { id:string;name:string;state:'visited'|'limited'|'unavailable'|'manual'|'failed';message:string; samples:number };
export type NativeMenus = { state:'read'|'partial'|'permission-required'|'unavailable';labels:string[];unmatched:number;message:string };
export type DeepReport = { schema:1;scope?:'metadata'|'navigation';startedAt:string;finishedAt?:string;state:'running'|'complete'|'partial'|'cancelled'|'failed';steps:DeepStep[];plugins:PluginCatalog;nativeMenus:NativeMenus;restoration?:{routeRestored:boolean;editorsMatch:boolean;scrollRestored:number;userIntervened:boolean;message:string};notes:string[] };
export interface DeepPage {
  invoke(method:string,...args:unknown[]):Promise<any>;
}
export async function traverseDeep(page:DeepPage, signal:AbortSignal, onSample:(view:any)=>Promise<void>, onStep:(step:DeepStep,index:number)=>void,onRestored:(value:any)=>void=()=>{}) {
  const steps:DeepStep[]=[];let restoration:any;
  const ready=await page.invoke('begin');if(!ready?.ok)throw new Error(ready?.message??'无法准备界面遍历');
  try {
    for(const [index,step]of DEEP_STEPS.entries()) {
      signal.throwIfAborted();const result=await page.invoke('step',step.id);signal.throwIfAborted();
      if(result?.userIntervened)throw new Error('用户已接管界面，已停止自动遍历');
      const row:DeepStep={...step,state:result?.limited?'limited':result?.ok?'visited':'unavailable',message:result?.message??'入口不可用',samples:0};
      if(result?.ok){
        for(let scroll=0;scroll<12;scroll++){
          signal.throwIfAborted();const view=await page.invoke('sample');if(view?.userIntervened)throw new Error('用户已接管界面，已停止自动遍历');await onSample(view);row.samples++;
          if(!['marketplace','installed','history','settings-general','settings-app','settings-appearance','settings-shortcuts','model-usage'].includes(step.id))break;
          const moved=await page.invoke('scroll');if(moved?.userIntervened)throw new Error('用户已接管界面，已停止自动遍历');if(!moved?.more)break;
          if(scroll===11){row.state='limited';row.message='达到本页滚动上限，仍有内容待检查';}
        }
      }
      steps.push(row);onStep(row,index+1);
    }
    steps.push({id:'conditional',name:'账号条件与执行后界面',state:'manual',message:'登录、付费、安装、权限变更、删除和任务执行后的界面需人工进入；本轮不触发这些操作。',samples:0});
  } finally { restoration=await page.invoke('finish').catch(()=>({routeRestored:false,editorsMatch:false,scrollRestored:0,userIntervened:false,message:'未在时限内确认页面恢复；未强制重启应用，请检查当前界面。'}));onRestored(restoration); }
  return {steps,restoration};
}
export function sanitizeNativeMenus(data:any, allowed:Set<string>):NativeMenus {
  const states=['read','partial','permission-required','unavailable'];
  if(!states.includes(data?.state))return{state:'unavailable',labels:[],unmatched:0,message:'实时原生菜单尚未读取'};
  const labels=['read','partial'].includes(data.state)?[...new Set<string>((Array.isArray(data.labels)?data.labels:[]).filter((v:unknown)=>typeof v==='string'&&v.length<=200&&allowed.has(v)).slice(0,400))]:[];
  return{state:data.state,labels,unmatched:Math.max(0,Math.min(10000,Number(data.unmatched)||0)),message:({read:'已读取实时菜单标题，未执行菜单命令',partial:'菜单读取受限，部分条目待检查','permission-required':'原生菜单读取未授权，已跳过；其他扫描继续',unavailable:'实时菜单暂不可用'})[data.state as NativeMenus['state']]};
}
export function deepMarkdown(report:DeepReport){
 const lines=['# Antigravity 深度扫描报告','',`开始：${report.startedAt}`,`结束：${report.finishedAt??'进行中'}`,`状态：${report.state}`,'',`插件说明 ${report.plugins.entries.length} 条，已检查清单文件 ${report.plugins.inspectedFiles} 个。`, `原生菜单：${report.nativeMenus.message}（已读 ${report.nativeMenus.labels.length} 个标题）。`,'','## 页面遍历','', '| 页面 | 结果 | 采样 | 说明 |','| --- | --- | ---: | --- |'];
 const esc=(s:string)=>s.replace(/\\/g,'\\\\').replace(/[\[\]<>!*`_{}()#|]/g,'\\$&').replace(/\n/g,' ');for(const row of report.steps)lines.push(`| ${row.name} | ${row.state} | ${row.samples} | ${esc(row.message)} |`);
 lines.push('','## 恢复结果','',report.restoration?.message??'尚未确认恢复。','','## 插件展示说明','');
 for(const item of report.plugins.entries)lines.push(`### ${esc(item.name)}`,'',esc(item.description),`来源：${item.source}；${item.truncated?'内容截断，待继续检查':'展示说明已读取'}；仅本机保存，不自动发送。`,'');
 lines.push('## 实时原生菜单','',...report.nativeMenus.labels.map(v=>'- '+esc(v)),'','## 范围与限制','',...report.notes.map(v=>'- '+v));return lines.join('\n')+'\n';
}
