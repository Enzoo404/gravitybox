/** Select small metadata fields from a protobuf BLOB without loading skipped payloads. */
export type ProtoSelection = { [field: number]: true | ProtoSelection };
export const GENERATION_PROJECTION: ProtoSelection = { 1: { 4: true, 9: true, 19: true, 21: true }, 2: true, 4: true };
export const STEP_PROJECTION: ProtoSelection = { 1: true, 9: true, 12: true };
export const HUD_STEP_METADATA_PROJECTION: ProtoSelection = {
  1: true,
  4: { 2: true, 3: true, 8: true },
  6: true,
  7: true,
  8: true,
  9: true,
  12: true,
  22: true,
  24: { 4: true, 8: true, 12: true, 20: true },
  32: true,
};
export const HUD_GEN_METADATA_PROJECTION: ProtoSelection = {
  1: {
    4: true,
    9: { 10: { 1: true, 3: true, 4: true } },
    11: true,
    12: true,
    19: true,
    21: true,
  },
  2: true,
  4: true,
  3: {
    14: true,
    27: { 4: true, 8: true, 12: true, 20: true },
    28: true,
  },
};

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  do { const byte=value%128;value=Math.floor(value/128);bytes.push(byte+(value?128:0)); } while(value);
  return Buffer.from(bytes);
}

export function projectProtobuf(size: number, readChunk: (offset: number, length: number) => Uint8Array, selection: ProtoSelection,
  limits = { maxReadBytes: 4*1024*1024, maxOutputBytes: 256*1024, maxFieldBytes: 64*1024, maxFields: 20000, maxMs: 1500 }) {
  if(!Number.isSafeInteger(size)||size<0)throw Error('元数据长度无效');
  let cache:Buffer=Buffer.alloc(0),cacheStart=-1,bytesRead=0,fields=0,outputBytes=0;
  const started=performance.now();
  function read(offset:number,length:number):Buffer {
    if(performance.now()-started>limits.maxMs)throw Error('元数据字段读取超出时间预算');
    if(offset<0||length<0||offset+length>size)throw Error('元数据字段越界');
    if(offset>=cacheStart&&offset+length<=cacheStart+cache.length)return cache.subarray(offset-cacheStart,offset-cacheStart+length);
    const take=Math.min(size-offset,Math.max(length,65536));
    if(bytesRead+take>limits.maxReadBytes)throw Error('元数据字段读取超出字节预算');
    const chunk=readChunk(offset,take);bytesRead+=chunk.byteLength;
    if(chunk.byteLength!==take)throw Error('元数据字段读取不完整');
    cache=Buffer.from(chunk.buffer,chunk.byteOffset,chunk.byteLength);cacheStart=offset;
    return cache.subarray(0,length);
  }
  function varint(offset:number,end:number):[bigint,number] {
    const bytes=read(offset,Math.min(10,end-offset));let n=0n;
    for(let i=0;i<bytes.length;i++){const byte=bytes[i]!;if(i===9&&byte>1)throw Error('元数据整数溢出');n|=BigInt(byte&127)<<BigInt(i*7);if(!(byte&128))return[n,offset+i+1];}
    throw Error('元数据整数不完整');
  }
  function safe(value:bigint):number {if(value>BigInt(Number.MAX_SAFE_INTEGER))throw Error('元数据长度溢出');return Number(value);}
  function project(start:number,end:number,wanted:ProtoSelection,depth:number):Buffer {
    if(depth>4)throw Error('元数据嵌套超出预算');const result:Buffer[]=[];let cursor=start;
    while(cursor<end){
      if(++fields>limits.maxFields)throw Error('元数据字段数量超出预算');
      const fieldStart=cursor,[tag,next]=varint(cursor,end),tagNumber=safe(tag),wire=tagNumber%8,field=Math.floor(tagNumber/8);
      if(field<1||field>536870911)throw Error('元数据字段编号无效');cursor=next;
      let contentStart=cursor;
      if(wire===2){const [length,afterLength]=varint(cursor,end);contentStart=afterLength;cursor=contentStart+safe(length);}
      else if(wire===0)cursor=varint(cursor,end)[1];
      else if(wire===1)cursor+=8;
      else if(wire===5)cursor+=4;
      else throw Error('不支持的元数据字段类型');
      if(cursor>end)throw Error('元数据字段长度越界');
      const child=wanted[field];if(!child)continue;
      let selected:Buffer;
      if(child!==true){if(wire!==2)throw Error('元数据消息类型不符');const inner=project(contentStart,cursor,child,depth+1);selected=Buffer.concat([encodeVarint(tagNumber),encodeVarint(inner.length),inner]);}
      else {if(cursor-fieldStart>limits.maxFieldBytes)throw Error('目标元数据字段超过安全上限');selected=Buffer.from(read(fieldStart,cursor-fieldStart));}
      outputBytes+=selected.length;if(outputBytes>limits.maxOutputBytes)throw Error('元数据输出超出预算');result.push(selected);
    }
    return Buffer.concat(result);
  }
  const data=project(0,size,selection,0);
  return{data,bytesRead,fields};
}
