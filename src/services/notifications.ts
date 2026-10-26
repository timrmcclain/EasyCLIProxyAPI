import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { getCurrentLocale, translate } from '../i18n';
import { readDesktopAlertsPreference } from './dashboardPreferences';

/**
 * Every Windows notification the hub raises goes through here. Each one is kept in the hub's alert history,
 * whether or not it popped up, so an alert silenced by a switch or quiet hours can still be found later.
 */
export const ALERT_KINDS = ['quota', 'pace', 'apps', 'proxy', 'secrets', 'updates', 'digest'] as const;
export type AlertKind = typeof ALERT_KINDS[number];
export type AlertMessage = { title: string; body: string; /** The page the alert is about. */ page?: string };
export type AlertEntry = AlertMessage & {
  id: string;
  at: number;
  kind: AlertKind;
  /** Why it didn't pop up, if it didn't. */
  silenced?: 'off' | 'kind' | 'quiet';
  read: boolean;
};
export type QuietHours = { enabled: boolean; start: string; end: string };

const HISTORY_KEY = 'personal.alertHistory';
const KINDS_KEY = 'personal.alertKinds';
const QUIET_KEY = 'personal.quietHours';
const HISTORY_LIMIT = 100;
export const ALERT_HISTORY_EVENT = 'app:alert-history';

/** Where each kind of alert sends you from the history. */
export const ALERT_PAGES: Record<AlertKind, string> = {
  quota: 'home', pace: 'home', apps: 'agents', proxy: 'home', secrets: 'secret-guard', updates: 'versions', digest: 'home',
};

const readJson = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } as T : fallback;
  } catch { return fallback; }
};

export function readAlertKinds(): Record<AlertKind, boolean> {
  // Every kind is on until switched off, except the morning summary, which is off until asked for.
  return readJson(KINDS_KEY, Object.fromEntries(ALERT_KINDS.map(kind => [kind, kind !== 'digest'])) as Record<AlertKind, boolean>);
}
export function saveAlertKind(kind: AlertKind, on: boolean) {
  localStorage.setItem(KINDS_KEY, JSON.stringify({ ...readAlertKinds(), [kind]: on }));
}

export function readQuietHours(): QuietHours {
  return readJson(QUIET_KEY, { enabled: false, start: '22:00', end: '07:00' });
}
export function saveQuietHours(quiet: QuietHours) {
  localStorage.setItem(QUIET_KEY, JSON.stringify(quiet));
}

const minutesOf = (time: string) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number(match[1]) < 24 && Number(match[2]) < 60 ? minutes : null;
};

/** Whether a local time falls in quiet hours; a range like 22:00–07:00 runs past midnight. */
export function inQuietHours(quiet: QuietHours, date: Date): boolean {
  if (!quiet.enabled) return false;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === null || end === null || start === end) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export function readAlertHistory(): AlertEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed as AlertEntry[] : [];
  } catch { return []; }
}
function writeAlertHistory(entries: AlertEntry[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_LIMIT)));
  window.dispatchEvent(new Event(ALERT_HISTORY_EVENT));
}
export function markAlertsRead() {
  const entries = readAlertHistory();
  if (entries.some(entry => !entry.read)) writeAlertHistory(entries.map(entry => ({ ...entry, read: true })));
}
export function clearAlertHistory() {
  writeAlertHistory([]);
}

/** At most three notifications at once; past that, the third says how many more there are instead of dropping them. */
export function batchNotifications<T extends { title: string; body: string }>(messages: T[], more: (count: number) => T): T[] {
  return messages.length <= 3 ? messages : [...messages.slice(0, 2), more(messages.length - 2)];
}

/** Why a new alert of this kind wouldn't pop up right now, or undefined if it would. */
export function silencedBecause(kind: AlertKind, date: Date): AlertEntry['silenced'] {
  if (!readDesktopAlertsPreference()) return 'off';
  if (!readAlertKinds()[kind]) return 'kind';
  return inQuietHours(readQuietHours(), date) ? 'quiet' : undefined;
}

export async function notify(kind: AlertKind, messages: AlertMessage[]): Promise<void> {
  if (!messages.length) return;
  const now = new Date();
  const silenced = silencedBecause(kind, now);
  const entries: AlertEntry[] = messages.map((message, index) => ({
    ...message, page: message.page ?? ALERT_PAGES[kind], kind, at: now.getTime(), id: `${now.getTime()}-${kind}-${index}`, silenced, read: false,
  }));
  writeAlertHistory([...entries.reverse(), ...readAlertHistory()]);
  if (silenced) return;
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === 'granted';
  if (!granted) return;
  const locale = getCurrentLocale();
  for (const message of batchNotifications(messages, count => ({
    title: translate(locale, 'notify.more.title', { count }),
    body: translate(locale, 'notify.more.body'),
  }))) sendNotification({ title: message.title, body: message.body });
}
