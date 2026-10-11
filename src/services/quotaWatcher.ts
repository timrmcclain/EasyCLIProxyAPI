import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { getCurrentLocale, translate } from '../i18n';
import { resetCountdown } from './accountDashboard';
import { refreshDashboardQuotas } from './accountDashboardRefresh';
import { privateAccountLabel } from './accountPrivacy';
import { readAccountNames } from './accountNames';
import { dedupeAuthFiles } from './authFiles';
import { readDashboardPreference, readDesktopAlertsPreference } from './dashboardPreferences';
import { attentionItems } from './homeGlance';
import { driftedApps, loadAppStatuses, newlyInstalledApps } from './connectedApps';
import { managementApi, readString, responseList } from './managementApi';
import { providerTallies, quotaAlerts, type AlertMemory, type QuotaAlert } from './quotaAlerts';
import { invoke } from '@tauri-apps/api/core';
import { getQuotaCacheSnapshot } from './quotaCache';
import { getQuotaHistory, recordQuotaSamples, setQuotaHistory } from './quotaForecast';
import { getQuotaTrends, recordQuotaTrends, setQuotaTrends } from './quotaTrend';
import { applyQuotaRouting } from './quotaRoutingControl';
import { initialProxyWatch, nextProxyWatch } from './proxyWatch';
import { fileName, providerForFile, type AuthFile } from './quotaService';

const CHECK_EVERY_MS = 5 * 60_000;
/** How often the proxy itself is checked; it counts as down after two failed checks in a row. */
const PROXY_CHECK_EVERY_MS = 30_000;
const providerNames: Record<string, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', xai: 'Grok', kimi: 'Kimi', devin: 'Devin', gemini: 'Gemini' };
const providerOf = (file: AuthFile) => providerForFile(file) ?? (readString(file, 'provider', 'type') || 'other').toLowerCase();

export function labelFor(file: AuthFile): string {
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

/** "Quota: Codex all out · Claude 1 low · Grok ok" for the tray menu and tooltip. */
async function updateTray(files: AuthFile[], attention: ReturnType<typeof attentionItems>) {
  const locale = getCurrentLocale();
  const parts = providerTallies(files, attention, providerOf).map(tally => {
    const provider = providerNames[tally.provider] ?? tally.provider;
    if (tally.blocked === tally.total) return translate(locale, 'tray.allOut', { provider });
    if (tally.blocked) return translate(locale, 'tray.out', { provider, count: tally.blocked });
    if (tally.low) return translate(locale, 'tray.low', { provider, count: tally.low });
    return translate(locale, 'tray.ok', { provider });
  });
  const menuText = parts.length ? translate(locale, 'tray.quota', { summary: parts.join(' · ') }) : translate(locale, 'tray.none');
  await invoke('set_tray_quota_summary', { menuText, tooltipText: parts.join(' · ') }).catch(() => undefined);
  // Read by the Claude Code status line wrapper, when switched on in Settings.
  await invoke('write_claude_quota_line', { text: menuText }).catch(() => undefined);
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
  let installedBaseline: Set<string> | null = null;

  const check = async (force = false) => {
    try {
      const files = dedupeAuthFiles(responseList(await managementApi.get('/credentials'), 'files'));
      if (stopped) return;
      await refreshDashboardQuotas(files.filter(file => providerForFile(file)), force, () => !stopped);
      if (stopped) return;
      const now = Date.now();
      const quotas = getQuotaCacheSnapshot();
      setQuotaHistory(recordQuotaSamples(getQuotaHistory(), files, quotas, now));
      setQuotaTrends(recordQuotaTrends(getQuotaTrends(), files, quotas, now));
      // Soonest-reset-first routing, when switched on in Settings → Routing.
      await applyQuotaRouting(files).catch(() => undefined);
      const attention = attentionItems(files, quotas, now, false);
      await updateTray(files, attention);
      const result = quotaAlerts(memory, files, attention, providerOf, labelFor);
      memory = result.memory;
      await send(result.alerts.map(alert => alertText(alert, now)));
    } catch {
      // The proxy may be restarting; try again on the next tick.
    }
    try {
      // An app whose settings stop matching the hub (old key, address or port) fails every request.
      const statuses = await loadAppStatuses();
      if (stopped) return;
      const drifted = driftedApps(statuses);
      const fresh = driftBaseline ? drifted.filter(app => !driftBaseline!.has(app.id)) : [];
      driftBaseline = new Set(drifted.map(app => app.id));
      // A supported AI tool installed while the hub runs: offer to connect it.
      const installed = newlyInstalledApps(installedBaseline, statuses);
      installedBaseline = installed.seen;
      const locale = getCurrentLocale();
      await send([
        ...fresh.map(app => ({ title: translate(locale, 'notify.drift.title', { app: app.name }), body: translate(locale, 'notify.drift.body') })),
        ...installed.fresh.map(app => ({ title: translate(locale, 'notify.newApp.title', { app: app.name }), body: translate(locale, 'notify.newApp.body') })),
      ]);
    } catch {
      // App detection failed; check again next time.
    }
  };

  // The proxy stopping (a crash, or closed by something else) fails every app's requests, so say so.
  let proxyWatch = initialProxyWatch;
  const checkProxy = async () => {
    const status = await invoke<{ ready: boolean; starting: boolean }>('get_core_status').catch(() => null);
    if (stopped) return;
    const next = nextProxyWatch(proxyWatch, status);
    proxyWatch = next.state;
    if (!next.alert) return;
    const locale = getCurrentLocale();
    await send([{ title: translate(locale, `notify.proxy.${next.alert}.title`), body: translate(locale, `notify.proxy.${next.alert}.body`) }]);
  };

  void check();
  const timer = window.setInterval(() => { void check(); }, CHECK_EVERY_MS);
  const proxyTimer = window.setInterval(() => { void checkProxy(); }, PROXY_CHECK_EVERY_MS);
  // "Check all quotas now" in the command palette: a forced check that skips the rate-limit backoff.
  const checkNow = () => { void check(true); };
  window.addEventListener('app:check-quota', checkNow);
  return () => { stopped = true; window.clearInterval(timer); window.clearInterval(proxyTimer); window.removeEventListener('app:check-quota', checkNow); };
}
