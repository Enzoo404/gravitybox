import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {fetchBundleWithHash} from './bundle.js';
/** Memory-only identity-bound fingerprint cache; source bodies are never retained. */
export class BundleCache {
  downloads=0;downloadedBytes=0;
  private hashes=new Map<string,string>();
  private pending=new Map<string,Promise<{hash:string;source:string|undefined;cacheHit:boolean}>>();
  async key(app:string,pid:number,version:string,origin:string){
    const rows=[];
    for(const name of ['app.asar','app.asar.unpacked']){
      try{const s=await stat(join(app,'Contents/Resources',name));rows.push([name,s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs]);}
      catch(error){if(name==='app.asar'||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    return JSON.stringify([app,pid,version,new URL(origin).origin,rows]);
  }
  async read(app:string,pid:number,version:string,origin:string,fetcher=fetchBundleWithHash){
    const key=await this.key(app,pid,version,origin),hit=this.hashes.get(key);
    if(hit)return {hash:hit,source:undefined,cacheHit:true};
    const pending=this.pending.get(key);if(pending)return {...await pending,cacheHit:true};
    const load=(async()=>{
      const result=await fetcher(origin);this.downloads++;this.downloadedBytes+=result.bytes;
      if(key!==await this.key(app,pid,version,origin))throw new Error('应用资源在读取期间发生变化');
      this.hashes.set(key,result.hash);while(this.hashes.size>2)this.hashes.delete(this.hashes.keys().next().value!);
      return {hash:result.hash,source:result.source,cacheHit:false};
    })();
    this.pending.set(key,load);try{return await load;}finally{this.pending.delete(key);}
  }
}
