import { useSyncExternalStore } from 'react';
import { quotaKey, type AuthFile, type QuotaState } from './quotaService';

/** One quota window that has ended: how much of it was used, as far as the hub saw. */
export type CompletedWindow = { window: string; label: string; endedAt: number; used: number };
/** The window still running, tracked until its reset time passes. */
type OpenWindow = { window: string; label: string; resetAt: number; lowest: number };
export type AccountResets = { open: OpenWindow[]; completed: CompletedWindow[] };
export type ResetHistory = Record<string, AccountResets>;

const DAY = 86_400_000;
const KEEP_MS = 28 * DAY;
// Providers report reset times that drift by seconds to minutes between checks; within this it's the same window.
const SAME_RESET_MS = 10 * 60_000;

/**
 * Updates each account's quota windows from the latest check. A window is complete once its reset time has
 * passed and a later check shows a new reset time; it then records the most used the hub saw before the reset.
 */
export function recordResetHistory(history: ResetHistory, files: AuthFile[], quotas: Record<string, QuotaState>, now: number): ResetHistory {
  const next: ResetHistory = {};
  for (const file of files) {
    const key = quotaKey(file);
    const previous = history[key] ?? { open: [], completed: [] };
    const quota = quotas[key];
    let completed = previous.completed.filter(entry => now - entry.endedAt <= KEEP_MS);
    let open = previous.open;
    if (quota?.status === 'success') {
      const at = quota.fetchedAt ?? now;
      const seen: OpenWindow[] = [];
      for (const row of quota.rows) {
        if (!row.windowId || typeof row.remainingPercent !== 'number' || !row.resetAtMs) continue;
        const tracked = open.find(item => item.window === row.windowId);
        const sameWindow = tracked && Math.abs(tracked.resetAt - row.resetAtMs) <= SAME_RESET_MS;
        if (tracked && !sameWindow && tracked.resetAt <= at + SAME_RESET_MS) {
          completed = [...completed, { window: tracked.window, label: tracked.label, endedAt: tracked.resetAt, used: Math.round(100 - tracked.lowest) }];
        }
        seen.push({
          window: row.windowId, label: row.label, resetAt: row.resetAtMs,
          lowest: sameWindow ? Math.min(tracked.lowest, row.remainingPercent) : row.remainingPercent,
        });
      }
      open = seen;
    }
    if (open.length || completed.length) next[key] = { open, completed };
  }
  return next;
}

export type ResetSummary = { label: string; resets: number; averageUsed: number; ranOut: number };

/** Per window, over the last 4 weeks: how many resets, average share used, and how often it ran out. */
export function summarizeResets(account: AccountResets | undefined, now: number): ResetSummary[] {
  const byWindow = new Map<string, CompletedWindow[]>();
  for (const entry of account?.completed ?? []) {
    if (now - entry.endedAt > KEEP_MS) continue;
    byWindow.set(entry.window, [...(byWindow.get(entry.window) ?? []), entry]);
  }
  return [...byWindow.values()].map(entries => ({
    label: entries[entries.length - 1].label,
    resets: entries.length,
    averageUsed: Math.round(entries.reduce((sum, entry) => sum + entry.used, 0) / entries.length),
    ranOut: entries.filter(entry => entry.used >= 100).length,
  }));
}

const STORAGE_KEY = 'personal.resetHistory';
let history: ResetHistory | null = null;
const listeners = new Set<() => void>();
const noHistory: ResetHistory = {};

const validEntry = (value: unknown): value is AccountResets => !!value && typeof value === 'object'
  && Array.isArray((value as AccountResets).open) && Array.isArray((value as AccountResets).completed)
  && (value as AccountResets).completed.every(entry => !!entry && typeof entry.endedAt === 'number' && typeof entry.used === 'number');

export function getResetHistory(): ResetHistory {
  if (history === null) {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
      // Keep only well-formed entries: one damaged entry would otherwise make every quota check throw.
      history = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? Object.fromEntries(Object.entries(parsed).filter(([, value]) => validEntry(value))) as ResetHistory : {};
    } catch { history = {}; }
  }
  return history ?? {};
}

export function setResetHistory(next: ResetHistory) {
  history = next;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* storage full or unavailable */ }
  listeners.forEach(listener => listener());
}

export function useResetHistory(): ResetHistory {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getResetHistory, () => noHistory);
}
