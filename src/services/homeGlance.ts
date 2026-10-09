import { quotaAvailability } from './quotaAvailability';
import { orderedQuotaRows, primaryQuotaRow, quotaPercentLeft } from './quotaLedger';
import { quotaKey, type AuthFile, type QuotaState } from './quotaService';
import { requestClient, type DashboardRequest } from './dashboardActivity';

export type AttentionSeverity = 'blocked' | 'low' | 'unconfirmed';
export type AttentionItem = { file: AuthFile; severity: AttentionSeverity; percent: number | null; resetAt?: number };

const blockedKinds = ['exhausted', 'unavailable', 'limited', 'resetDue'];
const severityRank: Record<AttentionSeverity, number> = { blocked: 0, low: 1, unconfirmed: 2 };

/** Accounts that could stop work soon: blocked, under 15% left, or not confirmed. Worst first. */
export function attentionItems(files: AuthFile[], quotas: Record<string, QuotaState>, now: number, stale: boolean): AttentionItem[] {
  return files.flatMap((file): AttentionItem[] => {
    const quota = quotas[quotaKey(file)];
    const state = quotaAvailability(file, quota, now, stale);
    const primary = primaryQuotaRow(orderedQuotaRows(quota?.rows ?? []), state.blockers);
    const left = quotaPercentLeft(primary);
    const resetAt = state.recoveryAt ?? (primary?.resetAtMs && primary.resetAtMs > now ? primary.resetAtMs : undefined);
    if (blockedKinds.includes(state.kind)) return [{ file, severity: 'blocked', percent: left?.percent ?? null, resetAt }];
    if (state.kind === 'available' && left?.tone === 'critical') return [{ file, severity: 'low', percent: left.percent, resetAt }];
    if (state.kind === 'unknown') return [{ file, severity: 'unconfirmed', percent: null }];
    return [];
  }).sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || (a.percent ?? 100) - (b.percent ?? 100));
}

export type TimelinePoint = { hour: string; requests: number; failure: number };
export type HourBucket = { at: number; requests: number; failures: number };

/** Usage timeline keys are local time, "YYYY-MM-DD-HH" or "YYYY-MM-DD-HH-MM" (half-hour buckets); ISO strings also work. */
export function parseHourKey(key: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(?:-(\d{2}))?$/.exec(key);
  return match ? new Date(+match[1], +match[2] - 1, +match[3], +match[4], +(match[5] ?? 0)).getTime() : Date.parse(key);
}

/** The last 24 hours as hourly buckets, oldest first, ending with the current hour. */
export function hourlyActivity(timeline: readonly TimelinePoint[], now: number): HourBucket[] {
  const hour = 3_600_000;
  const current = Math.floor(now / hour) * hour;
  const buckets = Array.from({ length: 24 }, (_, index) => ({ at: current - (23 - index) * hour, requests: 0, failures: 0 }));
  for (const point of timeline) {
    const at = point && typeof point.hour === 'string' ? Math.floor(parseHourKey(point.hour) / hour) * hour : NaN;
    const bucket = Number.isFinite(at) ? buckets.find(item => item.at === at) : undefined;
    if (!bucket) continue;
    bucket.requests += Number.isFinite(point.requests) ? point.requests : 0;
    bucket.failures += Number.isFinite(point.failure) ? point.failure : 0;
  }
  return buckets;
}

/** The app that sent the most of the given requests, if any are recognised. */
export function busiestClient(items: readonly DashboardRequest[]): { client: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const item of items) {
    const client = requestClient(item);
    if (client) counts.set(client, (counts.get(client) ?? 0) + 1);
  }
  const [client, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
  return client ? { client, count: count! } : null;
}
