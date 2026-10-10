import { accountSummary } from './accountDashboard';
import { captureQuotaCacheGeneration, commitQuotaCacheIfCurrent, getQuotaCacheSnapshot, quotaResultUpdater, updateQuotaCache } from './quotaCache';
import { loadQuota, quotaKey, type AuthFile, type QuotaState } from './quotaService';

const QUOTA_TTL = 5 * 60_000;
const RATE_LIMIT_BACKOFF = 15 * 60_000;

/** One timer for every caller (the Overview and the background watcher), so they never double the checks. */
const lastAttempt: Record<string, number> = {};
/** Accounts whose provider rate-limited the quota check, and when to try again. */
const backoffUntil: Record<string, number> = {};
const isRateLimited = (result: QuotaState) => result.status === 'error' && /429|rate.?limit/i.test(result.error ?? '');

export const quotaBackoffUntil = (key: string): number | undefined =>
  (backoffUntil[key] ?? 0) > Date.now() ? backoffUntil[key] : undefined;

/** `force` is a direct request (a refresh click), which skips both the timer and any rate-limit backoff. */
export async function refreshDashboardQuotas(
  files: AuthFile[], force: boolean, isCurrent: () => boolean,
  load: (file: AuthFile) => Promise<QuotaState> = loadQuota,
) {
  const generation = captureQuotaCacheGeneration();
  const current = () => isCurrent() && captureQuotaCacheGeneration() === generation;
  const pending = files.filter((file) => {
    const key = quotaKey(file);
    const cached = getQuotaCacheSnapshot()[key];
    return !accountSummary(file).health.disabled && cached?.status !== 'loading'
      && (force || (!quotaBackoffUntil(key) && Date.now() - (lastAttempt[key] ?? cached?.fetchedAt ?? 0) >= QUOTA_TTL));
  });
  for (let i = 0; i < pending.length && current(); i += 2) {
    await Promise.all(pending.slice(i, i + 2).map(async (file) => {
      if (!current()) return;
      const key = quotaKey(file);
      const started = commitQuotaCacheIfCurrent(generation, () => updateQuotaCache((cache) => ({
        ...cache, [key]: { ...cache[key], status: 'loading', rows: cache[key]?.rows ?? [] },
      })));
      if (!started) return;
      lastAttempt[key] = Date.now();
      let result: QuotaState;
      try { result = await load(file); }
      catch { result = { status: 'error', rows: [] }; }
      if (isRateLimited(result)) backoffUntil[key] = Date.now() + RATE_LIMIT_BACKOFF;
      else delete backoffUntil[key];
      // Finish already-started entries on unmount; pruning invalidates their generation.
      commitQuotaCacheIfCurrent(generation, () => updateQuotaCache(quotaResultUpdater(key, result)));
    }));
  }
}
