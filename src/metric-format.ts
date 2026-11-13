export function compactNumber(value: number, significantDigits = 3): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const integer = Math.floor(value);
  if (integer < 1000) return String(integer);
  const rounded = Number(integer.toPrecision(significantDigits));
  const divisor = rounded >= 1e9 ? 1e9 : rounded >= 1e6 ? 1e6 : 1e3;
  const unit = divisor === 1e9 ? 'B' : divisor === 1e6 ? 'M' : 'K';
  return `${Number((rounded / divisor).toPrecision(significantDigits))}${unit}`;
}
export function durationText(value: number, language: 'zh' | 'en' = 'zh'): string {
  const seconds = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  if (seconds === 0) return language === 'en' ? '0s' : '0秒';
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  if (language === 'en') return `${hours ? `${hours}h` : ''}${minutes ? `${minutes}m` : ''}${rest ? `${rest}s` : ''}`;
  return `${hours ? `${hours}小时` : ''}${minutes ? `${minutes}分` : ''}${rest ? `${rest}秒` : ''}`;
}
