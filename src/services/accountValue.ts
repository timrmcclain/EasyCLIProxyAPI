import { invoke } from '@tauri-apps/api/core';

/** Monthly subscription prices you set per account, in USD; the hub can't know what you pay. */
export type AccountPrices = Record<string, number>;
const STORAGE_KEY = 'personal.accountPrices';
const DAY = 86_400_000;

export function readAccountPrices(): AccountPrices {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value > 0)) as AccountPrices;
  } catch { return {}; }
}

/** Saves one account's price; an empty or zero price removes it. */
export function saveAccountPrice(key: string, price: number | null): AccountPrices {
  const next = { ...readAccountPrices() };
  if (price && Number.isFinite(price) && price > 0) next[key] = Math.round(price * 100) / 100;
  else delete next[key];
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* the price just isn't remembered */ }
  return next;
}

/** Parses what was typed in the price field: "$200", "200.50" or "" (clears). */
export function parsePriceInput(value: string): number | null | undefined {
  const cleaned = value.replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  const price = Number(cleaned);
  return Number.isFinite(price) && price >= 0 && price < 100_000 ? price : undefined;
}

/** How many times the price the requests would have cost at API prices; undefined without a price. */
export function valueMultiple(apiValue: number, monthlyPrice: number | undefined): number | undefined {
  if (!monthlyPrice || monthlyPrice <= 0 || !Number.isFinite(apiValue)) return undefined;
  return Math.round((apiValue / monthlyPrice) * 10) / 10;
}

/** The API-equivalent value of one account's requests over the last 30 days, from Activity's records. */
export async function loadAccountValue(source: string, now = Date.now()): Promise<number> {
  const overview = await invoke<{ estimatedCost?: unknown }>('get_usage_overview', {
    query: { source, start: new Date(now - 30 * DAY).toISOString(), end: new Date(now).toISOString() },
  });
  return typeof overview?.estimatedCost === 'number' ? overview.estimatedCost : 0;
}
