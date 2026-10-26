import { invoke } from '@tauri-apps/api/core';
import { getCurrentLocale, translate } from '../i18n';
import { summarizeHomeUsage, type HomeUsageSummary } from './homeOverview';
import { notify, readAlertKinds } from './notifications';

/**
 * The morning summary: once a day, from 8am while the app is running, one Windows notification with yesterday's
 * requests and failures and how quota stands now. It is only a desktop notification; nothing is sent anywhere.
 */
export const DIGEST_HOUR = 8;
const LAST_DAY_KEY = 'personal.digestLastDay';
/** The tray's quota line, kept by the quota watcher so the summary can say how quota stands now. */
export const LAST_QUOTA_LINE_KEY = 'personal.lastQuotaLine';

export const localDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** Due once per local day, from DIGEST_HOUR on. */
export function digestDue(now: Date, lastDay: string | null): boolean {
  return now.getHours() >= DIGEST_HOUR && localDay(now) !== lastDay;
}

/** Yesterday, midnight to midnight in local time. */
export function yesterdayRange(now: Date): { start: string; end: string } {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function digestBody(usage: HomeUsageSummary | null, quotaLine: string | null, locale = getCurrentLocale()): string {
  const parts = [usage === null
    ? translate(locale, 'v7.digest.noUsage')
    : usage.totalRequests === 0
      ? translate(locale, 'v7.digest.quiet')
      : translate(locale, 'v7.digest.usage', { count: usage.totalRequests, failed: usage.failureCount })];
  if (quotaLine) parts.push(quotaLine);
  return parts.join(' ');
}

export async function runMorningDigest(now = new Date()): Promise<boolean> {
  let lastDay: string | null = null;
  try { lastDay = localStorage.getItem(LAST_DAY_KEY); } catch { return false; }
  if (!digestDue(now, lastDay)) return false;
  // Marked first, so a slow read or a second window never sends two.
  localStorage.setItem(LAST_DAY_KEY, localDay(now));
  // Off unless asked for; when off it doesn't even go into the alert history.
  if (!readAlertKinds().digest) return false;
  const usage = await invoke<unknown>('get_usage_overview', { query: yesterdayRange(now) }).then(summarizeHomeUsage).catch(() => null);
  const locale = getCurrentLocale();
  await notify('digest', [{ title: translate(locale, 'v7.digest.title'), body: digestBody(usage, localStorage.getItem(LAST_QUOTA_LINE_KEY), locale), page: 'home' }]);
  return true;
}
