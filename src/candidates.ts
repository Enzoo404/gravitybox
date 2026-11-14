import {createHash} from 'node:crypto';
/** One candidate format for resource, visible UI and explicitly selected plugin copy. */
export const UI_KINDS = new Set(['button','tab','menuitem','tooltip','heading','label','option','toast','placeholder','attribute','description','template']);
export type PendingItem = {key:string;kind?:string;route?:string;source?:'static'|'runtime-ui'|'plugin';translationKey?:string};
export function safeRoute(value:unknown):string {
  if(typeof value!=='string')return '/other';
  if(value==='/fixture')return value;
  if(/^\/customizations(?:\/installed)?$/.test(value))return value;
  if(/^\/settings(?:\/[a-z-]+)?$/.test(value)||value==='/settings-standalone')return '/settings';
  return ['/','/history','/sidecars','/automations'].includes(value)?value:'/other';
}
export function scopedKey(key:string,kind:string,route:string){return `@ui:${safeRoute(route)}|${UI_KINDS.has(kind)?kind:'label'}|${key}`;}
export function decodeScopedKey(value:string){const match=value.match(/^@ui:([^|]+)\|([^|]+)\|([\s\S]+)$/);return match&&safeRoute(match[1])===match[1]&&UI_KINDS.has(match[2]!)?{key:match[3]!,kind:match[2]!,route:match[1]!}:undefined;}
export function pendingIdentity(item:PendingItem){return item.translationKey??item.key;}

export function describeContext(scope:{route:string;kind:string}){const routes:Record<string,string>={'/':'主页','/settings':'设置','/history':'对话历史','/customizations':'插件市场','/customizations/installed':'已安装插件','/sidecars':'自动化','/automations':'自动化','/other':'其他界面','/fixture':'测试界面'};const kinds:Record<string,string>={button:'按钮',heading:'标题',tooltip:'提示',placeholder:'输入提示',menuitem:'菜单项',tab:'标签页',label:'标签',description:'说明',attribute:'控件说明',option:'选项',toast:'通知'};return `${routes[scope.route]??'界面'} · ${kinds[scope.kind]??'文案'}`;}

export function previewItemId(item:PendingItem){return createHash('sha256').update(pendingIdentity(item)).digest('hex');}
export function selectedPreviewItems(entries:PendingItem[], ids:unknown):PendingItem[]{
  if(ids===undefined)return entries;
  if(!Array.isArray(ids)||ids.length===0||ids.length>entries.length||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)throw new Error('请选择有效且不重复的待译子集');
  const allowed=new Set(entries.map(previewItemId));if(ids.some(id=>!allowed.has(id)))throw new Error('所选词条不属于已预览批次，请重新预览');
  const selected=new Set(ids);return entries.filter(item=>selected.has(previewItemId(item)));
}
