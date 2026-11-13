/**
 * Shared TypeScript Protobuf wire-level decoding and encoding helpers.
 */

export function decodeVarint64(buf: Uint8Array, cursor: { pos: number }): bigint {
  let result = 0n;
  let shift = 0n;
  while (cursor.pos < buf.length && shift <= 63n) {
    const b = BigInt(buf[cursor.pos++]!);
    result |= (b & 0x7fn) << shift;
    shift += 7n;
    if ((b & 0x80n) === 0n) break;
  }
  return result;
}

export function skipProtobufField(buf: Uint8Array, cursor: { pos: number }, wireType: number): boolean {
  if (wireType === 0) {
    decodeVarint64(buf, cursor);
    return cursor.pos <= buf.length;
  }
  if (wireType === 1) {
    cursor.pos += 8;
    return cursor.pos <= buf.length;
  }
  if (wireType === 2) {
    const len = Number(decodeVarint64(buf, cursor));
    if (!Number.isSafeInteger(len) || len < 0 || cursor.pos + len > buf.length) return false;
    cursor.pos += len;
    return true;
  }
  if (wireType === 5) {
    cursor.pos += 4;
    return cursor.pos <= buf.length;
  }
  return false;
}

export class ProtobufReader {
  /** Field 2 of CortexStepGeneratorMetadata is repeated uint32 step_indices. */
  static stepIndices(buf: Buffer): number[] | null {
    let offset = 0;
    let present = false;
    const result: number[] = [];
    const valid = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff;
    while (offset < buf.length) {
      const tag = this.readVarint(buf, offset);
      if (!tag || !valid(tag[0]) || !tag[0]) return [];
      const field = tag[0] >>> 3;
      const wire = tag[0] & 7;
      offset = tag[1];
      if (wire === 0) {
        const value = this.readVarint(buf, offset);
        if (!value) return [];
        offset = value[1];
        if (field === 2) {
          present = true;
          if (!valid(value[0])) return [];
          result.push(value[0]);
        }
      } else if (wire === 2) {
        const length = this.readVarint(buf, offset);
        if (!length || !Number.isSafeInteger(length[0]) || length[0] < 0) return [];
        offset = length[1];
        const end = offset + length[0];
        if (end > buf.length) return [];
        if (field === 2) {
          present = true;
          while (offset < end) {
            const v = this.readVarint(buf.subarray(0, end), offset);
            if (!v || !valid(v[0]) || result.length >= 10000) return [];
            result.push(v[0]);
            offset = v[1];
          }
        }
        offset = end;
      } else if (wire === 1) {
        offset += 8;
      } else if (wire === 5) {
        offset += 4;
      } else {
        return [];
      }
      if (offset > buf.length) return [];
    }
    return present ? [...new Set(result)] : null;
  }

  static readVarint(buf: Buffer, offset: number): [number, number] | null {
    let result = 0;
    let shift = 0;
    let pos = offset;

    while (pos < buf.length) {
      const byte = buf[pos++]!;
      result += (byte & 0x7f) * Math.pow(2, shift);
      shift += 7;
      if ((byte & 0x80) === 0) {
        return [Math.round(result), pos];
      }
    }
    return null;
  }

  static findField(buf: Buffer, targetField: number): Buffer | null {
    let offset = 0;
    while (offset < buf.length) {
      const v = this.readVarint(buf, offset);
      if (!v) break;
      const [tag, newOffset] = v;
      const wireType = tag & 0x07;
      const fieldNum = tag >>> 3;

      if (wireType === 2) {
        const lenInfo = this.readVarint(buf, newOffset);
        if (!lenInfo) break;
        const [length, contentOffset] = lenInfo;
        const end = contentOffset + length;
        if (end > buf.length) break;

        if (fieldNum === targetField) {
          return buf.subarray(contentOffset, end);
        }
        offset = end;
      } else if (wireType === 0) {
        const val = this.readVarint(buf, newOffset);
        if (!val) break;
        offset = val[1];
      } else if (wireType === 1) {
        offset = newOffset + 8;
      } else if (wireType === 5) {
        offset = newOffset + 4;
      } else {
        break;
      }
    }
    return null;
  }

  static findVarint(buf: Buffer, targetField: number): number | null {
    let offset = 0;
    while (offset < buf.length) {
      const v = this.readVarint(buf, offset);
      if (!v) break;
      const [tag, newOffset] = v;
      const wireType = tag & 0x07;
      const fieldNum = tag >>> 3;

      if (wireType === 0) {
        const val = this.readVarint(buf, newOffset);
        if (!val) break;
        if (fieldNum === targetField) {
          return val[0];
        }
        offset = val[1];
      } else if (wireType === 2) {
        const lenInfo = this.readVarint(buf, newOffset);
        if (!lenInfo) break;
        offset = lenInfo[1] + lenInfo[0];
      } else if (wireType === 1) {
        offset = newOffset + 8;
      } else if (wireType === 5) {
        offset = newOffset + 4;
      } else {
        break;
      }
    }
    return null;
  }

  static findString(buf: Buffer, targetField: number): string | null {
    const fieldBuf = this.findField(buf, targetField);
    if (!fieldBuf) return null;
    return fieldBuf.toString('utf8').trim() || null;
  }
}

export class ProtobufWriter {
  static encodeVarint(value: number | bigint): Buffer {
    let v = typeof value === 'bigint' ? value : BigInt(Math.floor(value));
    const bytes: number[] = [];
    while (v >= 0x80n) {
      bytes.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    bytes.push(Number(v & 0x7fn));
    return Buffer.from(bytes);
  }

  static encodeField(fieldNumber: number, wireType: number, payload: Buffer): Buffer {
    const tag = (fieldNumber << 3) | wireType;
    const tagBuf = this.encodeVarint(tag);
    if (wireType === 0) {
      return Buffer.concat([tagBuf, payload]);
    }
    if (wireType === 2) {
      const lenBuf = this.encodeVarint(payload.length);
      return Buffer.concat([tagBuf, lenBuf, payload]);
    }
    return Buffer.concat([tagBuf, payload]);
  }

  static encodeString(fieldNumber: number, text: string): Buffer {
    return this.encodeField(fieldNumber, 2, Buffer.from(text, 'utf8'));
  }

  static encodeLengthDelimited(fieldNumber: number, payload: Buffer): Buffer {
    return this.encodeField(fieldNumber, 2, payload);
  }

  static encodeVarintField(fieldNumber: number, value: number | bigint): Buffer {
    return this.encodeField(fieldNumber, 0, this.encodeVarint(value));
  }

  static encodeUint64(fieldNumber: number, value: number | bigint): Buffer {
    return this.encodeVarintField(fieldNumber, value);
  }

  static createGenerationMetadata(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    cachedTokens = 0
  ): Buffer {
    const fields: Buffer[] = [
      this.encodeString(1, modelId),
      this.encodeUint64(2, inputTokens),
      this.encodeUint64(3, outputTokens),
    ];
    if (cachedTokens > 0) {
      fields.push(this.encodeUint64(4, cachedTokens));
    }
    return Buffer.concat(fields);
  }

  static createOAuthTokenInfo(token: { access_token?: string; refresh_token?: string; expiry_timestamp?: number; is_gcp_tos?: boolean }, _email?: string): Buffer {
    const fields: Buffer[] = [
      this.encodeString(1, token.access_token || ''),
      this.encodeString(3, token.refresh_token || ''),
    ];
    if (token.expiry_timestamp) {
      const timePayload = this.encodeUint64(1, token.expiry_timestamp);
      fields.push(this.encodeField(4, 2, timePayload));
    }
    if (token.is_gcp_tos) {
      fields.push(this.encodeUint64(6, 1));
    }
    return Buffer.concat(fields);
  }
}
