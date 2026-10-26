import { authFileHealth } from './authFileHealth';
import { quotaAvailability } from './quotaAvailability';
import { primaryQuotaRow, quotaPercentLeft } from './quotaLedger';
import { parseAuthFilePriority } from './authFiles';
import { fileName, providerForFile, quotaKey, type AuthFile, type QuotaState } from './quotaService';

export type RoutingTier = 'ready' | 'low' | 'out';
export type RoutingEntry = { file: AuthFile; key: string; tier: RoutingTier; priority: number; current: number; last: boolean };
export type RoutingPlan = { provider: string; order: RoutingEntry[] };

const WEEKLY = /week|7.day|seven_day|7\s*天|7\s*日|週|周/i;
const LOW_PERCENT = 15;
const tierRank: Record<RoutingTier, number> = { ready: 0, low: 1, out: 2 };

/** States the hub can act on; anything else (not yet checked, stale, failed) means "don't reorder this provider". */
const decisive = new Set(['available', 'creditBacked', 'exhausted', 'limited', 'unavailable', 'resetDue']);

export function rankAccount(file: AuthFile, quota: QuotaState | undefined, now: number) {
  const state = quotaAvailability(file, quota, now);
  if (!decisive.has(state.kind)) return null;
  const rows = quota?.rows ?? [];
  const future = rows.filter(row => typeof row.resetAtMs === 'number' && row.resetAtMs > now);
  const weekly = future.filter(row => WEEKLY.test(row.windowId ?? '') || WEEKLY.test(row.label));
  const resets = (weekly.length ? weekly : future).map(row => row.resetAtMs!);
  const resetAt = resets.length ? Math.min(...resets) : Number.POSITIVE_INFINITY;
  if (state.kind !== 'available') return { tier: 'out' as const, resetAt };
  const left = quotaPercentLeft(primaryQuotaRow(rows, []));
  return { tier: left && left.percent < LOW_PERCENT ? 'low' as const : 'ready' as const, resetAt };
}

/**
 * The order the proxy should use each provider's accounts in under fill-first routing (larger priority goes first):
 * accounts with room before low ones before blocked ones, and within each group the one whose weekly window resets
 * soonest, so quota that would otherwise expire unused is spent first. Accounts saved for last (by quota key) go
 * below all the others, whatever their reset time, so the account you want to keep is used only when the rest can't.
 */
export function routingPlan(files: AuthFile[], quotas: Record<string, QuotaState>, now: number,
  last: ReadonlySet<string> = new Set()): RoutingPlan[] {
  const byProvider = new Map<string, AuthFile[]>();
  for (const file of files) {
    const provider = providerForFile(file);
    if (!provider || authFileHealth(file).disabled) continue;
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), file]);
  }
  const plans: RoutingPlan[] = [];
  for (const [provider, accounts] of byProvider) {
    if (accounts.length < 2) continue;
    const ranked = accounts.map(file => ({ file, last: last.has(quotaKey(file)), rank: rankAccount(file, quotas[quotaKey(file)], now) }));
    if (ranked.some(entry => !entry.rank)) continue;
    ranked.sort((a, b) => Number(a.last) - Number(b.last)
      || tierRank[a.rank!.tier] - tierRank[b.rank!.tier]
      || a.rank!.resetAt - b.rank!.resetAt
      || fileName(a.file).localeCompare(fileName(b.file)));
    plans.push({ provider, order: ranked.map(({ file, last: saved, rank }, index) => ({
      file, key: quotaKey(file), tier: rank!.tier, last: saved,
      priority: (ranked.length - index) * 10,
      current: parseAuthFilePriority(file.priority) ?? 0,
    })) });
  }
  return plans;
}

export const priorityChanges = (plans: RoutingPlan[]) =>
  plans.flatMap(plan => plan.order.filter(entry => entry.priority !== entry.current));
