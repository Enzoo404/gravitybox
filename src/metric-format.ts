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

export function formatTurnDurationCompact(seconds: number, language: 'zh' | 'en' = 'zh'): string {
  if (!Number.isFinite(seconds) || seconds < 0) return language === 'en' ? 'Turn 0s' : '本轮 0s';
  const rounded = Math.max(0, Math.round(seconds));
  const prefix = language === 'en' ? 'Turn ' : '本轮 ';
  if (rounded < 60) return `${prefix}${rounded}s`;
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  if (hours > 0) return `${prefix}${hours}h${minutes > 0 ? `${minutes}m` : ''}`;
  return `${prefix}${minutes}m`;
}
