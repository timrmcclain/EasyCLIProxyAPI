/** "3 min ago" style label; callers keep the exact time in a tooltip. */
export function formatAgo(timestamp: string, locale: string, now = Date.now()) {
  const seconds = Math.round((Date.parse(timestamp) - now) / 1000);
  if (Number.isNaN(seconds)) return '';
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(seconds, 'second');
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return format.format(Math.round(seconds / 3600), 'hour');
  return format.format(Math.round(seconds / 86400), 'day');
}

/** Exact local date and time for tooltips, or the raw value if it doesn't parse. */
export function formatExact(timestamp: string, locale: string) {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return timestamp;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
}
