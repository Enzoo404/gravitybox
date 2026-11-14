import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export function snapshotDigest(value) {
  if (value?.schema !== 1 || !Array.isArray(value.strings) || !value.strings.length) throw Error('提取结果缺少有效的 strings 数组');
  const seen = new Set(), counts = {};
  const strings = value.strings.map(row => {
    if (!row || typeof row.text !== 'string' || !row.text.trim() || seen.has(row.text) || !Array.isArray(row.kinds) || !row.kinds.length
      || row.kinds.some(kind => typeof kind !== 'string' || !/^[a-zA-Z][a-zA-Z-]*$/.test(kind)) || new Set(row.kinds).size !== row.kinds.length
      || !Number.isSafeInteger(row.count) || row.count < 1) throw Error('提取结果条目结构、唯一性或计数无效');
    seen.add(row.text);
    for (const kind of row.kinds) counts[kind] = (counts[kind] ?? 0) + 1;
    return { text: row.text, kinds: [...row.kinds].sort(), count: row.count };
  }).sort((a, b) => a.text < b.text ? -1 : a.text > b.text ? 1 : 0);
  if (value.counts) for (const [key, count] of Object.entries(value.counts)) {
    if (count !== (key === 'total' ? strings.length : counts[key] ?? 0)) throw Error('提取结果汇总计数不一致');
  }
  return createHash('sha256').update(JSON.stringify({ appVersion: value.appVersion, bundleSha256: value.bundleSha256, extractor: value.extractor ?? 'legacy-regex', strings })).digest('hex');
}

export async function verifyExtractionSnapshot(value) {
  const manifest = JSON.parse(await readFile(new URL('../assets/ui-extraction-manifest.json', import.meta.url), 'utf8'));
  const expected = manifest.versions?.[value.appVersion];
  if (!expected || expected.bundleSha256 !== value.bundleSha256 || expected.snapshotSha256 !== snapshotDigest(value)) throw Error('提取快照与已审阅清单不一致；请重新取证并显式登记，不能只修改版本或哈希');
  return expected;
}
