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

export function readAccountColors(storage: Pick<Storage, 'getItem'> = localStorage): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}');
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
