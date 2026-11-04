export class IdempotencyStore {
  private map = new Map<string,{at:number;fingerprint:string;result?:any;waiters:((result:any)=>void)[]}>();
  reserve(key:string,fingerprint:string,reply:(result:any)=>void) {
    const now=Date.now();
    for(const[k,v]of this.map)if(v.result!==undefined&&now-v.at>60000)this.map.delete(k);
    const hit=this.map.get(key);
    if(hit){if(hit.fingerprint!==fingerprint)return 'conflict';if(hit.result!==undefined)reply(hit.result);else hit.waiters.push(reply);return 'waiting';}
    if(this.map.size>=200)return 'full';
    this.map.set(key,{at:now,fingerprint,waiters:[]});return 'owner';
  }
  complete(key:string,result:any){const hit=this.map.get(key);if(!hit)return;hit.result=result;hit.at=Date.now();for(const reply of hit.waiters.splice(0))reply(result);}
}
export function canonicalPayload(value: any, topLevel = true): any {
  if (Array.isArray(value)) return value.map(item => canonicalPayload(item, false));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value)
    .filter(key => !topLevel || !['requestId', 'idempotencyKey'].includes(key))
    .sort().map(key => [key, canonicalPayload(value[key], false)]));
}
