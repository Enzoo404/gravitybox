import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function buildPricingFeed(catalog) {
  const prices = {};
  for (const key of catalog.feedModels ?? []) {
    const price = catalog.prices[key];
    if (!price) throw Error('公开价格表引用了不存在的模型：' + key);
    prices[key] = Array.isArray(price) ? price : price.intervals ?? [{ model: price.model, validFrom: price.provenance?.validFrom ?? null, validUntil: price.provenance?.validUntil ?? null,
      input: price.input, output: price.output, cached: price.cached, ...(price.cacheWrite !== undefined ? { cacheWrite: price.cacheWrite } : {}), provenance: price.provenance }];
  }
  return { version: catalog.pricingVersion, schema: 1, updatedAt: catalog.pricingUpdatedAt,
    source: 'https://raw.githubusercontent.com/Enzoo404/gravitybox/main/assets/pricing-feed.json', prices };
}
async function main() {
  const catalog = JSON.parse(await readFile(new URL('../assets/model-catalog.json', import.meta.url), 'utf8'));
  const file = new URL('../assets/pricing-feed.json', import.meta.url);
  const text = JSON.stringify(buildPricingFeed(catalog), null, 2) + '\n';
  if (process.argv.includes('--write')) await writeFile(file, text);
  else if (await readFile(file, 'utf8') !== text) throw Error('价格资产不同步，请审阅模型目录后显式运行 node tools/sync-pricing-feed.mjs --write');
  console.log('模型目录与公开价格表一致');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
