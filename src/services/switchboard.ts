import { requestClient, successfulRequest, type DashboardRequest } from './dashboardActivity';
import { forecastQuota, type QuotaHistory } from './quotaForecast';
import { normalizeAuthIndex } from './managementApi';
import { quotaKey, type AuthFile, type QuotaState } from './quotaService';
import type { ProviderPlan } from './routingOrder';

/**
 * The switchboard on Overview: apps send requests in, the hub routes each one, and an account pays for it. This turns
 * the routing order, quota and recent requests into the few things worth knowing at a glance: is it working, which
 * account is each provider spending, and when does that change.
 */
export type HubState = 'working' | 'reserve' | 'blocked' | 'down';
export type Lane = {
  provider: string;
  plan: ProviderPlan;
  /** The account the next request goes to, or null when every account is out. */
  serving: ProviderPlan['entries'][number] | null;
  /** Requests this provider served in the last few minutes; the lane pulses while it's above zero. */
  live: number;
  weekly: number | null;
  session: number | null;
  forecast: ReturnType<typeof forecastQuota> | null;
};
export type AppFlow = { client: string; count: number; live: boolean };

const LIVE_MS = 3 * 60_000;
const APPS_MS = 60 * 60_000;
const WEEKLY = /week|7.day|seven_day|7\s*天|7\s*日|週|周/i;
const SESSION = /five|5.hour|5h|session|5\s*小时|5\s*時間/i;

function windowPercent(quota: QuotaState | undefined, pattern: RegExp): number | null {
  const row = quota?.rows.find(item => pattern.test(item.windowId ?? '') || pattern.test(item.label));
  return typeof row?.remainingPercent === 'number' ? Math.max(0, Math.min(100, row.remainingPercent)) : null;
}

/** One lane per provider with a routing order, serving account first. */
export function hubLanes(plans: ProviderPlan[], quotas: Record<string, QuotaState>, items: DashboardRequest[], history: QuotaHistory, now: number): Lane[] {
  return plans.map(plan => {
    const serving = plan.next;
    const indexes = new Set(plan.entries.map(entry => normalizeAuthIndex(entry.file.auth_index ?? entry.file.authIndex)));
    const live = items.filter(item => successfulRequest(item) && now - Date.parse(item.timestamp) < LIVE_MS && indexes.has(normalizeAuthIndex(item.auth_index))).length;
    const quota = serving ? quotas[serving.key] : undefined;
    return {
      provider: plan.provider, plan, serving, live,
      weekly: windowPercent(quota, WEEKLY), session: windowPercent(quota, SESSION),
      forecast: serving ? forecastQuota(history[serving.key], now) : null,
    };
  });
}

/** Apps that sent requests in the last hour, busiest first. */
export function appFlows(items: DashboardRequest[], now: number): AppFlow[] {
  const counts = new Map<string, { count: number; latest: number }>();
  for (const item of items) {
    const at = Date.parse(item.timestamp);
    if (!Number.isFinite(at) || now - at > APPS_MS) continue;
    const client = requestClient(item) ?? 'other';
    const current = counts.get(client) ?? { count: 0, latest: 0 };
    counts.set(client, { count: current.count + 1, latest: Math.max(current.latest, at) });
  }
  return [...counts].map(([client, { count, latest }]) => ({ client, count, live: now - latest < LIVE_MS }))
    .sort((a, b) => b.count - a.count);
}

/** The one-word state: working, spending reserve, blocked (a provider with nothing left), or the proxy is down. */
export function hubState(ready: boolean, lanes: Lane[]): HubState {
  if (!ready) return 'down';
  if (lanes.some(lane => !lane.serving)) return 'blocked';
  if (lanes.some(lane => lane.serving && (lane.serving.role === 'reserve' || lane.serving.role === 'held'))) return 'reserve';
  return 'working';
}

/** Accounts kept back (Reserve or held by a rule) per lane, for "Gmail is held in reserve". */
export const keptBack = (lane: Lane) => lane.plan.entries.filter(entry => entry !== lane.serving && (entry.role === 'reserve' || entry.role === 'held'));

export type CalendarMark = { key: string; file: AuthFile; at: number; provider: string; percent: number | null };

/** Weekly refills over the next seven days, one mark per account, soonest first. */
export function resetCalendar(plans: ProviderPlan[], quotas: Record<string, QuotaState>, now: number, days = 7): CalendarMark[] {
  const end = now + days * 86_400_000;
  const marks: CalendarMark[] = [];
  for (const plan of plans) {
    for (const entry of plan.entries) {
      const rows = quotas[entry.key]?.rows ?? [];
      const weekly = rows.find(row => WEEKLY.test(row.windowId ?? '') || WEEKLY.test(row.label));
      const at = weekly?.resetAtMs;
      if (typeof at === 'number' && at > now && at <= end) {
        marks.push({ key: entry.key, file: entry.file, at, provider: plan.provider, percent: typeof weekly?.remainingPercent === 'number' ? weekly.remainingPercent : null });
      }
    }
  }
  return marks.sort((a, b) => a.at - b.at);
}

export type HourSlice = { at: number; byKey: Record<string, number>; total: number };

/** Activity keys each hour in local time as "YYYY-MM-DD-HH". */
export function parseHourKey(key: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4])).getTime();
  return Number.isFinite(at) ? at : null;
}

/** Who served each of the last 24 hours, per account, from each account's hourly timeline. */
export function servedByHour(timelines: Record<string, { hour: string; requests: number }[]>, now: number, hours = 24): HourSlice[] {
  const hour = 3_600_000;
  const start = Math.floor(now / hour) * hour - (hours - 1) * hour;
  const slices: HourSlice[] = Array.from({ length: hours }, (_, index) => ({ at: start + index * hour, byKey: {}, total: 0 }));
  for (const [key, points] of Object.entries(timelines)) {
    for (const point of points) {
      const at = parseHourKey(point.hour);
      if (at === null) continue;
      const index = Math.floor((at - start) / hour);
      if (index < 0 || index >= hours || !point.requests) continue;
      slices[index].byKey[key] = (slices[index].byKey[key] ?? 0) + point.requests;
      slices[index].total += point.requests;
    }
  }
  return slices;
}

/** The quota key for an account's email, which is how Activity names the account that served a request. */
export const keyForSource = (files: AuthFile[]) => new Map(files.filter(file => typeof file.email === 'string').map(file => [String(file.email), quotaKey(file)]));
