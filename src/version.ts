import { readFileSync } from 'node:fs';

// The packaged backend keeps this metadata in core/package.json, next to dist/.
const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (typeof metadata.version !== 'string' || metadata.version !== metadata.version.trim() || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(metadata.version)) {
  throw new Error('GravityBox 运行时缺少有效的构建版本');
}
export const APP_VERSION: string = metadata.version;
