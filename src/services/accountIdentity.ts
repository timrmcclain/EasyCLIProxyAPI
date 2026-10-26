/**
 * Each account gets one colour, used wherever it appears (switchboard lanes, the 24-hour strip, the reset calendar),
 * so "the blue one" means the same account everywhere. The default comes from the account's key; you can pick another.
 */
export const ACCOUNT_COLORS = ['#2f6fdb', '#c2571a', '#1f8a5b', '#8a4fc7', '#b8892a', '#c23a5e', '#2a8a96', '#6b7280'] as const;
const STORAGE_KEY = 'personal.accountColors';

function hash(text: string) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  return value >>> 0;
}

/** No storage (server rendering, tests) reads as nothing saved. */
const browserStorage = (): Pick<Storage, 'getItem'> | null => typeof localStorage === 'undefined' ? null : localStorage;

export function readAccountColors(storage = browserStorage()): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, color]) => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color))) as Record<string, string>;
  } catch { return {}; }
}

export function saveAccountColor(key: string, color: string | null) {
  const next = { ...readAccountColors() };
  if (color) next[key] = color; else delete next[key];
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* the colour just isn't remembered */ }
  window.dispatchEvent(new Event('app:account-colors'));
  return next;
}

/** The account's colour: your pick, or a stable default from its key. */
export const accountColor = (key: string, overrides: Record<string, string> = {}) =>
  overrides[key] ?? ACCOUNT_COLORS[hash(key) % ACCOUNT_COLORS.length];

const GROUPS_KEY = 'personal.accountGroups';

/** Your own grouping of accounts by person or purpose ("Work", "Personal"), by quota key. */
export function readAccountGroups(storage = browserStorage()): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(GROUPS_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, group]) => typeof group === 'string' && group.trim())
      .map(([key, group]) => [key, (group as string).trim().slice(0, 40)]));
  } catch { return {}; }
}

export function saveAccountGroup(key: string, group: string) {
  const next = { ...readAccountGroups() };
  const name = group.trim().slice(0, 40);
  if (name) next[key] = name; else delete next[key];
  try { localStorage.setItem(GROUPS_KEY, JSON.stringify(next)); } catch { /* the group just isn't remembered */ }
  window.dispatchEvent(new Event('app:account-colors'));
  return next;
}

/** Health per day for the last week from an account's hourly timeline: requests and failures, oldest day first. */
export function dailyHealth(timeline: { hour: string; requests: number; failure?: number }[], now: number, days = 7) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const start = today.getTime() - (days - 1) * 86_400_000;
  const result = Array.from({ length: days }, (_, index) => ({ at: start + index * 86_400_000, requests: 0, failures: 0 }));
  for (const point of timeline) {
    const match = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})$/.exec(point.hour);
    if (!match) continue;
    const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
    const index = Math.round((day - start) / 86_400_000);
    if (index < 0 || index >= days) continue;
    result[index].requests += point.requests || 0;
    result[index].failures += point.failure || 0;
  }
  return result;
}
