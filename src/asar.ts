import { closeSync, openSync, readSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

export interface AsarFileEntry {
  size?: number | string;
  offset?: number | string;
  unpacked?: boolean;
  link?: string;
  files?: Record<string, AsarFileEntry>;
}

export interface AsarHeader {
  files?: Record<string, AsarFileEntry>;
}

export interface ParsedAsarHeaderPrefix {
  headerSize: number;
  jsonSize: number;
  dataOffset: number;
}

/** Parse and validate the 16-byte ASAR preamble before reading its JSON header. */
export function parseAsarHeaderPrefix(prefix: Buffer, maxHeaderBytes = 16_000_000): ParsedAsarHeaderPrefix {
  if (prefix.length < 16) throw new Error('应用资源头不完整');
  const headerSize = prefix.readUInt32LE(4);
  const jsonSize = prefix.readUInt32LE(12);
  if (jsonSize <= 0 || jsonSize > maxHeaderBytes) {
    throw new Error('应用资源索引无效');
  }
  return { headerSize, jsonSize, dataOffset: 8 + headerSize };
}

/** Validate and resolve a single ASAR file entry range within archive bounds. */
export function resolveAsarEntryRange(
  entry: AsarFileEntry | undefined,
  dataOffset: number,
  maxSize: number,
  options: { fileSize?: number; minSize?: number } = {}
): { size: number; offset: number } | null {
  if (!entry || entry.unpacked || entry.link || entry.files) return null;
  const size = Number(entry.size);
  const relOffset = Number(entry.offset);
  const minSize = options.minSize ?? 0;
  if (
    !Number.isSafeInteger(size) ||
    !Number.isSafeInteger(relOffset) ||
    size < minSize ||
    relOffset < 0 ||
    size > maxSize
  ) {
    throw new Error('应用资源位置无效');
  }
  const offset = dataOffset + relOffset;
  if (offset < dataOffset) throw new Error('应用资源位置无效');
  if (options.fileSize !== undefined && offset + size > options.fileSize) {
    throw new Error('应用资源位置无效');
  }
  return { size, offset };
}

/** Synchronously inspect ASAR header and read individual entries without loading the whole archive. */
export function openAsarSync(asarPath: string, maxHeaderBytes = 16_000_000): {
  header: AsarHeader;
  dataOffset: number;
  readEntryBuffer(entry: AsarFileEntry | undefined, maxSize: number, minSize?: number): Buffer | null;
  close(): void;
} {
  const fd = openSync(asarPath, 'r');
  try {
    const prefix = Buffer.alloc(16);
    if (readSync(fd, prefix, 0, 16, 0) !== 16) {
      throw new Error('应用资源头不完整');
    }
    const { jsonSize, dataOffset } = parseAsarHeaderPrefix(prefix, maxHeaderBytes);
    const headerBytes = Buffer.alloc(jsonSize);
    if (readSync(fd, headerBytes, 0, jsonSize, 16) !== jsonSize) {
      throw new Error('应用资源索引无效');
    }
    const header = JSON.parse(headerBytes.toString('utf8')) as AsarHeader;
    return {
      header,
      dataOffset,
      readEntryBuffer(entry, maxSize, minSize = 1) {
        const range = resolveAsarEntryRange(entry, dataOffset, maxSize, { minSize });
        if (!range) return null;
        const buf = Buffer.alloc(range.size);
        if (readSync(fd, buf, 0, range.size, range.offset) !== range.size) {
          return null;
        }
        return buf;
      },
      close() {
        try { closeSync(fd); } catch {}
      },
    };
  } catch (error) {
    try { closeSync(fd); } catch {}
    throw error;
  }
}

/** Open an ASAR archive asynchronously for header inspection and bounded range reads. */
export async function openAsarArchive(asarPath: string, maxHeaderBytes = 16_000_000): Promise<{
  header: AsarHeader;
  dataOffset: number;
  fileSize: number;
  readEntryBuffer(entry: AsarFileEntry | undefined, maxSize: number, minSize?: number): Promise<Buffer | null>;
  close(): Promise<void>;
}> {
  const handle: FileHandle = await open(asarPath, 'r');
  try {
    const stat = await handle.stat();
    const prefix = Buffer.alloc(16);
    const prefixRead = await handle.read(prefix, 0, 16, 0);
    if (prefixRead.bytesRead !== 16) {
      throw new Error('应用资源头不完整');
    }
    const { jsonSize, dataOffset } = parseAsarHeaderPrefix(prefix, maxHeaderBytes);
    if (16 + jsonSize > stat.size || dataOffset > stat.size) {
      throw new Error('应用资源索引无效');
    }
    const headerBytes = Buffer.alloc(jsonSize);
    const headerRead = await handle.read(headerBytes, 0, jsonSize, 16);
    if (headerRead.bytesRead !== jsonSize) {
      throw new Error('应用资源索引无效');
    }
    const header = JSON.parse(headerBytes.toString('utf8')) as AsarHeader;
    return {
      header,
      dataOffset,
      fileSize: stat.size,
      async readEntryBuffer(entry, maxSize, minSize = 0) {
        const range = resolveAsarEntryRange(entry, dataOffset, maxSize, { fileSize: stat.size, minSize });
        if (!range) return null;
        if (range.size === 0) return Buffer.alloc(0);
        const bytes = Buffer.alloc(range.size);
        const { bytesRead } = await handle.read(bytes, 0, range.size, range.offset);
        if (bytesRead !== range.size) {
          throw new Error('应用资源读取不完整');
        }
        return bytes;
      },
      async close() {
        await handle.close();
      },
    };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}
