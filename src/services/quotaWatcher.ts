import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { getCurrentLocale, translate } from '../i18n';
import { resetCountdown } from './accountDashboard';
import { refreshDashboardQuotas } from './accountDashboardRefresh';
import { accountDisplayName } from './accountPrivacy';
import { readAccountNames } from './accountNames';
import { dedupeAuthFiles } from './authFiles';
import { readDashboardPreference, readDesktopAlertsPreference } from './dashboardPreferences';
import { attentionItems } from './homeGlance';
import { driftedApps, loadAppStatuses, newlyInstalledApps } from './connectedApps';
import { managementApi, readString, responseList } from './managementApi';
import { paceAlerts, providerTallies, quotaAlerts, type AlertMemory, type PaceAlert, type PaceMemory, type QuotaAlert } from './quotaAlerts';
import { invoke } from '@tauri-apps/api/core';
import { getQuotaCacheSnapshot } from './quotaCache';
import { getQuotaHistory, recordQuotaSamples, setQuotaHistory } from './quotaForecast';
import { getQuotaTrends, recordQuotaTrends, setQuotaTrends } from './quotaTrend';
import { getResetHistory, recordResetHistory, setResetHistory } from './resetHistory';
import { applyQuotaRouting } from './quotaRoutingControl';
import { syncBlockedRouting } from './blockedRouting';
import { loadPlanBlocks } from './planBlock';
import { initialProxyWatch, nextProxyWatch } from './proxyWatch';
import { getProxyUptime, recordProxyCheck, setProxyUptime } from './proxyUptime';
import { providerForFile, type AuthFile } from './quotaService';

const CHECK_EVERY_MS = 5 * 60_000;
/** How often the proxy itself is checked; it counts as down after two failed checks in a row. */
const PROXY_CHECK_EVERY_MS = 30_000;
const providerNames: Record<string, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', xai: 'Grok', kimi: 'Kimi', devin: 'Devin', gemini: 'Gemini' };
const providerOf = (file: AuthFile) => providerForFile(file) ?? (readString(file, 'provider', 'type') || 'other').toLowerCase();

export function labelFor(file: AuthFile): string {
  return accountDisplayName(file, providerOf(file), readAccountNames(), readDashboardPreference('hideEmails', ['true', 'false'], 'false') === 'true');
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
    case 'unavailable':
      return { title: t('notify.unavailable.title', { account: alert.account ?? provider }), body: t('notify.unavailable.body') };
    case 'working':
      return { title: t('notify.working.title', { account: alert.account ?? provider }), body: t('notify.working.body') };
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
  await invoke('set_tray_quota_summary', { menuText, tooltipText: parts.join(' · '), level: trayQuotaLevel(providerTallies(files, attention, providerOf)) }).catch(() => undefined);
  // Read by the Claude Code status line wrapper, when switched on in Settings.
  await invoke('write_claude_quota_line', { text: menuText }).catch(() => undefined);
}

/** The tray icon's dot: "out" when every account of a provider is out, "low" when any is low or out. */
export function trayQuotaLevel(tallies: ReturnType<typeof providerTallies>): 'ok' | 'low' | 'out' {
  if (tallies.some(tally => tally.total > 0 && tally.blocked === tally.total)) return 'out';
  return tallies.some(tally => tally.blocked > 0 || tally.low > 0) ? 'low' : 'ok';
}

/** At most three notifications at once; past that, the third says how many more there are instead of dropping them. */
export function batchNotifications(messages: { title: string; body: string }[], more: (count: number) => { title: string; body: string }) {
  return messages.length <= 3 ? messages : [...messages.slice(0, 2), more(messages.length - 2)];
}

async function send(messages: { title: string; body: string }[]) {
  if (!messages.length || !readDesktopAlertsPreference()) return;
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === 'granted';
  if (!granted) return;
  const locale = getCurrentLocale();
  for (const message of batchNotifications(messages, count => ({
    title: translate(locale, 'notify.more.title', { count }),
    body: translate(locale, 'notify.more.body'),
  }))) sendNotification(message);
}

const TRAY_NOTICE_KEY = 'personal.trayNoticeShown';

/** The first time the window goes to the tray, say the hub is still running; never again after that. */
export async function noticeStillInTray() {
  if (localStorage.getItem(TRAY_NOTICE_KEY)) return;
  localStorage.setItem(TRAY_NOTICE_KEY, String(Date.now()));
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === 'granted';
  if (!granted) return;
  const locale = getCurrentLocale();
  sendNotification({ title: translate(locale, 'notify.tray.title'), body: translate(locale, 'notify.tray.body') });
}

/** "Claude (work) will run out in about 1h 20m" with when it resets, for the pace warning. */
export function paceAlertText(alert: PaceAlert, now: number): { title: string; body: string } {
  const locale = getCurrentLocale();
  const t = (key: Parameters<typeof translate>[1], variables?: Record<string, string | number>) => translate(locale, key, variables);
  return {
    title: t('notify.pace.title', { account: alert.account, time: resetCountdown(alert.emptyAt, now) }),
    body: alert.resetAt ? t('notify.pace.bodyReset', { time: resetCountdown(alert.resetAt, now) }) : t('notify.pace.body'),
  };
}

/**
 * Checks quotas every five minutes while the proxy is running, even with the window hidden in the
 * tray: records samples for the run-out forecast and raises a Windows notification when an account
 * gets low, runs out or comes back. Returns a stop function.
 */
export function startQuotaWatcher(): () => void {
  let stopped = false;
  let memory: AlertMemory | null = null;
  let paceMemory: PaceMemory | null = null;
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
      setResetHistory(recordResetHistory(getResetHistory(), files, quotas, now));
      // Soonest-reset-first routing, when switched on in Settings → Routing.
      const rerouted = await applyQuotaRouting(files).catch(() => 0);
      // Accounts the provider refuses outright (terms, plan) move below the rest so requests go elsewhere.
      // Work from the priorities routing just wrote, not the ones read before it.
      const current = rerouted ? dedupeAuthFiles(responseList(await managementApi.get('/credentials'), 'files')) : files;
      await loadPlanBlocks(current).then(blocks => syncBlockedRouting(current, blocks)).catch(() => undefined);
      const attention = attentionItems(files, quotas, now, false);
      await updateTray(files, attention);
      const result = quotaAlerts(memory, files, attention, providerOf, labelFor);
      memory = result.memory;
      const pace = paceAlerts(paceMemory, files, getQuotaHistory(), attention, now, providerOf, labelFor);
      paceMemory = pace.memory;
      await send([...result.alerts.map(alert => alertText(alert, now)), ...pace.alerts.map(alert => paceAlertText(alert, now))]);
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

  void check();
  const timer = window.setInterval(() => { void check(); }, CHECK_EVERY_MS);
  // "Check all quotas now" in the command palette: a forced check that skips the rate-limit backoff.
  const checkNow = () => { void check(true); };
  window.addEventListener('app:check-quota', checkNow);
  return () => { stopped = true; window.clearInterval(timer); window.removeEventListener('app:check-quota', checkNow); };
}

/**
 * Watches the proxy itself every 30 seconds for as long as the hub runs. It must outlive the quota watcher,
 * which stops when the proxy does: the proxy stopping (a crash, or closed by something else) fails every
 * app's requests, so say so, and say when it's back. Returns a stop function.
 */
export function startProxyWatcher(): () => void {
  let stopped = false;
  let proxyWatch = initialProxyWatch;
  const checkProxy = async () => {
    const status = await invoke<{ ready: boolean; starting: boolean }>('get_core_status').catch(() => null);
    if (stopped) return;
    if (!status?.ready && !status?.starting) {
      // Stop proxy also switches off starting it on launch: a proxy stopped on purpose is neither an outage
      // nor worth an alert.
      const settings = await invoke<{ runOnStartup?: boolean }>('get_gui_settings').catch(() => null);
      if (stopped) return;
      if (settings?.runOnStartup === false) {
        proxyWatch = initialProxyWatch;
        return;
      }
    }
    setProxyUptime(recordProxyCheck(getProxyUptime(), status, Date.now()));
    const next = nextProxyWatch(proxyWatch, status);
    proxyWatch = next.state;
    if (!next.alert) return;
    const locale = getCurrentLocale();
    await send([{ title: translate(locale, `notify.proxy.${next.alert}.title`), body: translate(locale, `notify.proxy.${next.alert}.body`) }]);
  };
  const timer = window.setInterval(() => { void checkProxy(); }, PROXY_CHECK_EVERY_MS);
  return () => { stopped = true; window.clearInterval(timer); };
}
