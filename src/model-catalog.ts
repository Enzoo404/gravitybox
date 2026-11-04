import { readFileSync } from 'node:fs';
import type { ApiPricingEntry } from './usage.js';
const catalog=JSON.parse(readFileSync(new URL('../assets/model-catalog.json',import.meta.url),'utf8'));
if(catalog.schema!==1||!catalog.names||!catalog.prices)throw Error('模型目录无效');
export const MODEL_PRICES=Object.assign(Object.create(null),catalog.prices) as Record<string,ApiPricingEntry>;
export const MODEL_PRICE_ALIASES=catalog.aliases as Record<string,string>;
