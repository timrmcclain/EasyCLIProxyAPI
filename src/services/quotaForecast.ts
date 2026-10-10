import { useSyncExternalStore } from 'react';
import { orderedQuotaRows, primaryQuotaRow } from './quotaLedger';
import { quotaKey, type AuthFile, type QuotaState } from './quotaService';

/** One reading of an account's deciding window: how much was left, and when. */
export type QuotaSample = { at: number; percent: number; window: string; resetAt?: number };
export type QuotaHistory = Record<string, QuotaSample[]>;

export type QuotaForecast =
  | { kind: 'unknown' }
  /** Using too little to matter (under half a percent an hour). */
  | { kind: 'steady'; ratePerHour: number }
  /** At this pace the window resets before it empties. */
  | { kind: 'lastsToReset'; ratePerHour: number; emptyAt: number; resetAt: number }
  | { kind: 'runsOut'; ratePerHour: number; emptyAt: number; resetAt?: number };

const MAX_SAMPLES = 60;
const MAX_AGE_MS = 12 * 3_600_000;
/** Pace is judged on the recent past, so a quiet morning doesn't hide a busy afternoon. */
const RATE_WINDOW_MS = 3 * 3_600_000;
const MIN_SPAN_MS = 20 * 60_000;
const STEADY_RATE = 0.5;

/** Adds the latest successful reading for each account. A reset (remaining going up, or a new window) starts a fresh series. */
export function recordQuotaSamples(history: QuotaHistory, files: AuthFile[], quotas: Record<string, QuotaState>, now: number): QuotaHistory {
  const next: QuotaHistory = {};
  for (const file of files) {
    const key = quotaKey(file);
    const quota = quotas[key];
    let samples = (history[key] ?? []).filter(sample => now - sample.at <= MAX_AGE_MS);
    if (quota?.status === 'success') {
      const row = primaryQuotaRow(orderedQuotaRows(quota.rows), []);
      const percent = row?.remainingPercent;
      if (row && typeof percent === 'number') {
        const at = quota.fetchedAt ?? now;
        const window = row.windowId ?? row.label;
        const last = samples[samples.length - 1];
        if (last && (last.window !== window || percent - last.percent >= 1)) samples = [];
        if (!last || at > last.at) samples = [...samples, { at, percent, window, resetAt: row.resetAtMs }];
      }
    }
    if (samples.length) next[key] = samples.slice(-MAX_SAMPLES);
  }
  return next;
}

/** Least-squares slope of remaining% over time, as percentage points used per hour. */
function usageRatePerHour(samples: QuotaSample[]): number {
  const n = samples.length;
  const meanT = samples.reduce((sum, s) => sum + s.at, 0) / n;
  const meanP = samples.reduce((sum, s) => sum + s.percent, 0) / n;
  let num = 0;
  let den = 0;
  for (const s of samples) {
    num += (s.at - meanT) * (s.percent - meanP);
    den += (s.at - meanT) ** 2;
  }
  return den === 0 ? 0 : -(num / den) * 3_600_000;
}

/** When the account's deciding window runs out at its recent pace, compared with when it resets. */
export function forecastQuota(samples: QuotaSample[] | undefined, now: number): QuotaForecast {
  const recent = (samples ?? []).filter(sample => now - sample.at <= RATE_WINDOW_MS);
  if (recent.length < 2 || recent[recent.length - 1].at - recent[0].at < MIN_SPAN_MS) return { kind: 'unknown' };
  const ratePerHour = usageRatePerHour(recent);
  if (ratePerHour < STEADY_RATE) return { kind: 'steady', ratePerHour: Math.max(0, ratePerHour) };
  const latest = recent[recent.length - 1];
  const emptyAt = latest.at + (latest.percent / ratePerHour) * 3_600_000;
  const resetAt = latest.resetAt && latest.resetAt > now ? latest.resetAt : undefined;
  return resetAt !== undefined && resetAt <= emptyAt
    ? { kind: 'lastsToReset', ratePerHour, emptyAt, resetAt }
    : { kind: 'runsOut', ratePerHour, emptyAt, resetAt };
}

const STORAGE_KEY = 'personal.quotaHistory';

function readStoredHistory(): QuotaHistory {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as QuotaHistory; } catch { return {}; }
}

let history: QuotaHistory | null = null;
const listeners = new Set<() => void>();

export function getQuotaHistory(): QuotaHistory {
  history ??= readStoredHistory();
  return history;
}

/** Stores the new history, persists it so forecasts survive a restart, and tells any open page. */
export function setQuotaHistory(next: QuotaHistory) {
  history = next;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* storage full or unavailable */ }
  listeners.forEach(listener => listener());
}

export function useQuotaHistory(): QuotaHistory {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getQuotaHistory,
  );
}
