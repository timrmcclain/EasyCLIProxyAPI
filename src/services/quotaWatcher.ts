import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { getCurrentLocale, translate } from '../i18n';
import { resetCountdown } from './accountDashboard';
import { refreshDashboardQuotas } from './accountDashboardRefresh';
import { privateAccountLabel } from './accountPrivacy';
import { readAccountNames } from './accountNames';
import { dedupeAuthFiles } from './authFiles';
import { readDashboardPreference, readDesktopAlertsPreference } from './dashboardPreferences';
import { attentionItems } from './homeGlance';
import { driftedApps, loadAppStatuses } from './connectedApps';
import { managementApi, readString, responseList } from './managementApi';
import { quotaAlerts, type AlertMemory, type QuotaAlert } from './quotaAlerts';
import { getQuotaCacheSnapshot } from './quotaCache';
import { getQuotaHistory, recordQuotaSamples, setQuotaHistory } from './quotaForecast';
import { fileName, providerForFile, type AuthFile } from './quotaService';

const CHECK_EVERY_MS = 5 * 60_000;
const providerNames: Record<string, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', xai: 'Grok', kimi: 'Kimi', devin: 'Devin', gemini: 'Gemini' };
const providerOf = (file: AuthFile) => providerForFile(file) ?? (readString(file, 'provider', 'type') || 'other').toLowerCase();

function labelFor(file: AuthFile): string {
  const privateLabel = privateAccountLabel(file, providerOf(file));
  if (readDashboardPreference('hideEmails', ['true', 'false'], 'false') === 'true') return privateLabel;
  return readAccountNames()[privateLabel] || fileName(file) || readString(file, 'email', 'label') || privateLabel;
}

export function alertText(alert: QuotaAlert, now: number): { title: string; body: string } {
  const locale = getCurrentLocale();
  const t = (key: Parameters<typeof translate>[1], variables?: Record<string, string | number>) => translate(locale, key, variables);
  const provider = providerNames[alert.provider] ?? alert.provider;
  const time = alert.resetAt ? resetCountdown(alert.resetAt, now) : '';
  const back = time ? t('notify.backIn', { time }) : t('notify.noReset');
  switch (alert.kind) {
    case 'providerExhausted':
      return { title: t('notify.exhausted.title', { provider }), body: back };
    case 'blocked':
      return { title: t('notify.blocked.title', { account: alert.account ?? provider }), body: back };
    case 'low':
      return {
        title: t('notify.low.title', { account: alert.account ?? provider }),
        body: [t('notify.low.left', { percent: Math.round(alert.percent ?? 0) }), time ? t('notify.resetsIn', { time }) : ''].filter(Boolean).join(' '),
      };
    case 'recovered':
      return { title: t('notify.recovered.title', { account: alert.account ?? provider }), body: t('notify.recovered.body') };
  }
}

async function send(messages: { title: string; body: string }[]) {
  if (!messages.length || !readDesktopAlertsPreference()) return;
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === 'granted';
  if (!granted) return;
  // More than three at once reads as noise; the hub's Overview has the full list.
  for (const message of messages.slice(0, 3)) sendNotification(message);
}

/**
 * Checks quotas every five minutes while the proxy is running, even with the window hidden in the
 * tray: records samples for the run-out forecast and raises a Windows notification when an account
 * gets low, runs out or comes back. Returns a stop function.
 */
export function startQuotaWatcher(): () => void {
  let stopped = false;
  let memory: AlertMemory | null = null;
  let driftBaseline: Set<string> | null = null;
  const lastAttempt: Record<string, number> = {};

  const check = async () => {
    try {
      const files = dedupeAuthFiles(responseList(await managementApi.get('/credentials'), 'files'));
      if (stopped) return;
      await refreshDashboardQuotas(files.filter(file => providerForFile(file)), false, lastAttempt, () => !stopped);
      if (stopped) return;
      const now = Date.now();
      const quotas = getQuotaCacheSnapshot();
      setQuotaHistory(recordQuotaSamples(getQuotaHistory(), files, quotas, now));
      const result = quotaAlerts(memory, files, attentionItems(files, quotas, now, false), providerOf, labelFor);
      memory = result.memory;
      await send(result.alerts.map(alert => alertText(alert, now)));
    } catch {
      // The proxy may be restarting; try again on the next tick.
    }
    try {
      // An app whose settings stop matching the hub (old key, address or port) fails every request.
      const drifted = driftedApps(await loadAppStatuses());
      if (stopped) return;
      const fresh = driftBaseline ? drifted.filter(app => !driftBaseline!.has(app.id)) : [];
      driftBaseline = new Set(drifted.map(app => app.id));
      const locale = getCurrentLocale();
      await send(fresh.map(app => ({ title: translate(locale, 'notify.drift.title', { app: app.name }), body: translate(locale, 'notify.drift.body') })));
    } catch {
      // App detection failed; check again next time.
    }
  };

  void check();
  const timer = window.setInterval(() => { void check(); }, CHECK_EVERY_MS);
  return () => { stopped = true; window.clearInterval(timer); };
}
