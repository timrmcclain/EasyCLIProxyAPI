import { useSyncExternalStore } from 'react';
import { quotaKey, type AuthFile, type QuotaRow, type QuotaState } from './quotaService';

/**
 * A week of each account's longest quota window (usually the weekly one), one reading per hour, so the account's
 * details can show how it was used and when it reset. Separate from the forecast's 12-hour history, which keeps
 * every reading of the deciding window.
 */
export type TrendSample = { at: number; percent: number };
export type AccountTrend = { label: string; samples: TrendSample[] };
export type QuotaTrends = Record<string, AccountTrend>;

const HOUR = 3_600_000;
const KEEP_MS = 7 * 24 * HOUR;

/** The window that runs longest: the one resetting last, or failing that the last listed. */
function longestWindow(rows: QuotaRow[]): QuotaRow | undefined {
  const withPercent = rows.filter(row => typeof row.remainingPercent === 'number');
  return withPercent.reduce<QuotaRow | undefined>((best, row) => (!best || (row.resetAtMs ?? 0) >= (best.resetAtMs ?? 0) ? row : best), undefined);
}

export function recordQuotaTrends(trends: QuotaTrends, files: AuthFile[], quotas: Record<string, QuotaState>, now: number): QuotaTrends {
  const next: QuotaTrends = {};
  for (const file of files) {
    const key = quotaKey(file);
    const previous = trends[key];
    const quota = quotas[key];
    const row = quota?.status === 'success' ? longestWindow(quota.rows) : undefined;
    // A different window (say the provider renamed it) starts a fresh line rather than joining two scales.
    let samples = previous && (!row || previous.label === row.label) ? previous.samples.filter(sample => now - sample.at <= KEEP_MS) : [];
    if (row && typeof row.remainingPercent === 'number') {
      const at = quota?.fetchedAt ?? now;
      const sample = { at, percent: Math.round(row.remainingPercent * 10) / 10 };
      const last = samples[samples.length - 1];
      // One reading per hour: a newer reading in the same hour replaces the older one.
      if (last && Math.floor(last.at / HOUR) === Math.floor(at / HOUR)) samples = at >= last.at ? [...samples.slice(0, -1), sample] : samples;
      else if (!last || at > last.at) samples = [...samples, sample];
    }
    if (samples.length) next[key] = { label: row?.label ?? previous?.label ?? '', samples };
  }
  return next;
}

const STORAGE_KEY = 'personal.quotaTrends';
let trends: QuotaTrends | null = null;
const listeners = new Set<() => void>();
/** Server rendering (tests) has no stored readings; a shared empty object keeps the snapshot stable. */
const noTrends: QuotaTrends = {};

export function getQuotaTrends(): QuotaTrends {
  try { trends ??= JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as QuotaTrends; } catch { trends = {}; }
  return trends ?? {};
}

export function setQuotaTrends(next: QuotaTrends) {
  trends = next;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* storage full or unavailable */ }
  listeners.forEach(listener => listener());
}

export function useQuotaTrends(): QuotaTrends {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getQuotaTrends, () => noTrends);
}
