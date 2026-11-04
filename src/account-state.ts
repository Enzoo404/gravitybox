import { ProtobufReader as Reader, ProtobufWriter as Writer } from './usage.js';

export function replaceTopicRow(value: string | undefined, sentinel: string, payload: Buffer): string {
  let wrapper: Record<string, unknown> | undefined;
  let encoded = value || '';
  if (encoded.startsWith('{')) { wrapper = JSON.parse(encoded); if (typeof wrapper?.data !== 'string') throw new Error('登录数据格式无法识别'); encoded = wrapper.data; }
  if (encoded && !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('登录数据格式无法识别');
  const data = Buffer.from(encoded, 'base64'), keep: Buffer[] = [];
  let offset = 0;
  while (offset < data.length) {
    const start = offset, tag = Reader.readVarint(data, offset);
    if (!tag) throw new Error('登录数据不完整');
    const [field, pos] = tag;
    let content: Buffer | undefined;
    if ((field & 7) === 2) {
      const size = Reader.readVarint(data, pos);
      if (!size || size[1] + size[0] > data.length) throw new Error('登录数据不完整');
      offset = size[1] + size[0]; content = data.subarray(size[1], offset);
    } else if ((field & 7) === 0) {
      const v = Reader.readVarint(data, pos); if (!v) throw new Error('登录数据不完整'); offset = v[1];
    } else if ((field & 7) === 1) offset = pos + 8;
    else if ((field & 7) === 5) offset = pos + 4;
    else throw new Error('登录数据格式无法识别');
    if (offset > data.length) throw new Error('登录数据不完整');
    if (!(field === 10 && content && Reader.findString(content, 1) === sentinel)) keep.push(data.subarray(start, offset));
  }
  const row = Writer.encodeString(1, payload.toString('base64'));
  keep.push(Writer.encodeLengthDelimited(1, Buffer.concat([Writer.encodeString(1, sentinel), Writer.encodeLengthDelimited(2, row)])));
  const result = Buffer.concat(keep).toString('base64');
  return wrapper ? JSON.stringify({ ...wrapper, data: result }) : result;
}


export function decodeTopicRow(value: string, sentinel: string): Buffer | null {
  let encoded = value;
  if (value.startsWith('{')) encoded = JSON.parse(value).data;
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('登录数据格式无法识别');
  const data = Buffer.from(encoded, 'base64');
  let offset = 0;
  while (offset < data.length) {
    const tag = Reader.readVarint(data, offset); if (!tag || tag[0] !== 10) break;
    const len = Reader.readVarint(data, tag[1]); if (!len || len[1] + len[0] > data.length) break;
    const entry = data.subarray(len[1], len[1] + len[0]); offset = len[1] + len[0];
    if (Reader.findString(entry, 1) !== sentinel) continue;
    const row = Reader.findField(entry, 2); if (!row) return null;
    const payload = Reader.findString(row, 1);
    if (payload && /^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return Buffer.from(payload, 'base64');
    return row; // Compatibility with the early, directly nested form.
  }
  return null;
}
