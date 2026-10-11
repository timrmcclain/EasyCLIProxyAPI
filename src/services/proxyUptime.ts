import { useSyncExternalStore } from 'react';

/**
 * A week of the proxy's 30-second health checks, counted per 10 minutes, so Health check can show how often it was
 * up. Only measured while the hub is open; time with the hub closed simply has no buckets.
 */
export type UptimeBucket = { at: number; up: number; down: number };
export type ProxyUptime = UptimeBucket[];

const BUCKET_MS = 10 * 60_000;
const DAY_MS = 24 * 3_600_000;
const KEEP_MS = 7 * DAY_MS;

/** Adds one check. A proxy that is still starting counts as neither up nor down. */
export function recordProxyCheck(history: ProxyUptime, status: { ready: boolean; starting: boolean } | null, now: number): ProxyUptime {
  const kept = history.filter(bucket => now - bucket.at < KEEP_MS);
  if (status?.starting) return kept;
  const up = status?.ready === true;
  const at = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  const last = kept[kept.length - 1];
  if (last && last.at === at) return [...kept.slice(0, -1), { at, up: last.up + (up ? 1 : 0), down: last.down + (up ? 0 : 1) }];
  return [...kept, { at, up: up ? 1 : 0, down: up ? 0 : 1 }];
}

export type DayUptime = { start: number; percent: number | null };
export type UptimeSummary = { percent: number | null; outages: number; days: DayUptime[] };

/** Overall uptime, how many separate outages there were, and one figure per day for the last seven days. */
export function summarizeUptime(history: ProxyUptime, now: number): UptimeSummary {
  const recent = history.filter(bucket => now - bucket.at < KEEP_MS);
  const up = recent.reduce((sum, bucket) => sum + bucket.up, 0);
  const down = recent.reduce((sum, bucket) => sum + bucket.down, 0);
  let outages = 0;
  let wasDown = false;
  for (const bucket of recent) {
    const isDown = bucket.down > 0 && bucket.up === 0;
    if (isDown && !wasDown) outages += 1;
    wasDown = isDown;
  }
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days: DayUptime[] = [];
  for (let back = 6; back >= 0; back -= 1) {
    const start = new Date(today);
    start.setDate(today.getDate() - back);
    const end = new Date(start);
    end.setDate(start.getDate() + 1);
    const inDay = recent.filter(bucket => bucket.at >= start.getTime() && bucket.at < end.getTime());
    const dayUp = inDay.reduce((sum, bucket) => sum + bucket.up, 0);
    const dayDown = inDay.reduce((sum, bucket) => sum + bucket.down, 0);
    days.push({ start: start.getTime(), percent: dayUp + dayDown ? (dayUp / (dayUp + dayDown)) * 100 : null });
  }
  return { percent: up + down ? (up / (up + down)) * 100 : null, outages, days };
}

const STORAGE_KEY = 'personal.proxyUptime';
let uptime: ProxyUptime | null = null;
const listeners = new Set<() => void>();
const noUptime: ProxyUptime = [];

export function getProxyUptime(): ProxyUptime {
  try { uptime ??= JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as ProxyUptime; } catch { uptime = []; }
  return Array.isArray(uptime) ? uptime : [];
}

export function setProxyUptime(next: ProxyUptime) {
  uptime = next;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* storage full or unavailable */ }
  listeners.forEach(listener => listener());
}

export function useProxyUptime(): ProxyUptime {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getProxyUptime, () => noUptime);
}
