import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { isPermissionGranted } from '@tauri-apps/plugin-notification';
import { AlertTriangle, ArrowRight, Check, CircleCheck, CircleX, ClipboardCopy, RefreshCw } from 'lucide-react';
import { useI18n } from '../i18n';
import { useCoreRuntime } from '../coreRuntime';
import { useCoreUpdate } from '../coreUpdate';
import { cantTakeRequests, needsSignIn } from '../components/AuthFileProviderIcon';
import { accountSummary } from '../services/accountDashboard';
import { dedupeAuthFiles, parseAuthFilePriority } from '../services/authFiles';
import { compressionService } from '../services/compression';
import { driftedApps, loadAppStatuses } from '../services/connectedApps';
import { readDesktopAlertsPreference } from '../services/dashboardPreferences';
import { findDuplicateAccounts, findOutrankingKeys, healthChecks, providersWithoutUsableAccount, type HealthCheck, type HealthLevel } from '../services/healthCheck';
import { diagnosticReport, type DiagnosticInput } from '../services/diagnostics';
import { managementApi, providerGroupsApi, readString, responseList } from '../services/managementApi';
import { summarizeUptime, useProxyUptime } from '../services/proxyUptime';
import './HealthCheckPage.css';

type CoreSettings = { apiKeys: unknown[]; managementSecretConfigured: boolean };
type ListenStatus = { host: string; port: number; exposed: boolean; portInUse: boolean; owner: { pid: number; name: string } | null };

const icons: Record<HealthLevel, typeof CircleCheck> = { ok: CircleCheck, warn: AlertTriangle, fail: CircleX };

/** Everything worth fixing on one page, worst first, each with a link to where it's fixed. */
export function HealthCheckPage() {
  const { t } = useI18n();
  const { status } = useCoreRuntime();
  const { hasUpdate, latest } = useCoreUpdate();
  const [snapshot, setSnapshot] = useState<Omit<DiagnosticInput, 'generatedAt' | 'hubVersion' | 'checks'> | null>(null);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const proxyRunning = Boolean(status?.ready);
  const [checks, setChecks] = useState<HealthCheck[] | null>(null);
  const [checking, setChecking] = useState(false);

  const run = useCallback(async () => {
    setChecking(true);
    try {
      const keySections = ['claude-api-key', 'codex-api-key', 'xai-api-key', 'meta-api-key'];
      const [settings, listen, filesResult, appsResult, compression, allowed, software, keyGroups] = await Promise.all([
        invoke<CoreSettings>('get_core_config_settings').catch(() => null),
        invoke<ListenStatus>('proxy_listen_status').catch(() => null),
        // Null (not []) when a probe fails, so the checks say "couldn't check" instead of reporting a guess.
        proxyRunning ? managementApi.get('/credentials').then(payload => dedupeAuthFiles(responseList(payload, 'files'))).catch(() => null) : Promise.resolve([]),
        loadAppStatuses(true).catch(() => null),
        compressionService.status().catch(() => null),
        isPermissionGranted().catch(() => null),
        invoke<{ autostartEnabled: boolean; startCoreOnLaunch: boolean }>('get_software_settings').catch(() => null),
        proxyRunning ? Promise.all(keySections.map(section => providerGroupsApi.get(section).then(groups => ({ section, groups })))).catch(() => null) : Promise.resolve(null),
      ]);
      const files = filesResult ?? [];
      const apps = appsResult ?? [];
      setSnapshot({
        platform: navigator.userAgent.includes('Windows') ? 'windows' : navigator.platform,
        proxy: { running: Boolean(status?.running), ready: proxyRunning, version: status?.currentVersion ?? null, managed: Boolean(status?.managed) },
        host: listen ? `${listen.host || '0.0.0.0'}:${listen.port}` : 'unknown',
        allowLan: listen?.exposed ?? false,
        keyCount: settings?.apiKeys.length ?? 0,
        accounts: files.map(file => {
          const summary = accountSummary(file);
          return { provider: readString(file, 'provider', 'type') || 'unknown', state: t(summary.health.label).toLowerCase(), disabled: summary.health.disabled };
        }),
        apps: apps.map(app => ({ name: app.name, installed: app.installed, state: app.connectionState, connectionMatches: app.connectionMatches })),
        compression: compression ? { enabled: compression.enabled, running: compression.running } : null,
      });
      setChecks(healthChecks({
        proxyRunning,
        host: listen?.host || '0.0.0.0',
        exposed: listen ? listen.exposed : null,
        // Our own proxy holding the port isn't a conflict, just a proxy the hub hasn't connected to yet.
        portBlockedBy: !proxyRunning && listen?.portInUse && listen.owner && !/cli-proxy-api/i.test(listen.owner.name)
          ? { port: listen.port, name: listen.owner.name, pid: listen.owner.pid } : null,
        keyCount: settings ? settings.apiKeys.length : null,
        managementSecretConfigured: settings ? settings.managementSecretConfigured : null,
        signInNeeded: files.filter(needsSignIn).map(file => readString(file, 'label', 'email', 'name') || accountSummary(file).label),
        unavailable: files.filter(cantTakeRequests).map(file => readString(file, 'label', 'email', 'name') || accountSummary(file).label),
        duplicateAccounts: findDuplicateAccounts(files.map(file => ({ provider: readString(file, 'provider', 'type'), email: readString(file, 'email') }))),
        disabledAccounts: files.filter(file => accountSummary(file).health.disabled).length,
        totalAccounts: files.length,
        accountsUnknown: filesResult === null,
        driftedApps: appsResult === null ? null : driftedApps(apps).map(app => app.name),
        compression: compression ? { enabled: compression.enabled, running: compression.running } : null,
        notificationsAllowed: allowed,
        notificationsEnabled: readDesktopAlertsPreference(),
        providersWithoutAccount: filesResult ? providersWithoutUsableAccount(files.map(file => ({
          provider: readString(file, 'provider', 'type'),
          usable: !accountSummary(file).health.disabled && !cantTakeRequests(file) && !needsSignIn(file),
        }))) : [],
        engineUpdate: hasUpdate && latest && status?.currentVersion ? { current: status.currentVersion, latest: latest.version } : null,
        outrankingKeys: keyGroups && filesResult ? findOutrankingKeys(
          keyGroups.flatMap(({ section, groups }) => groups.map((group, index) => ({
            section,
            name: readString(group, 'name') || `${section} #${index + 1}`,
            priority: Number(group.priority ?? 0) || 0,
            disabled: group.disabled === true,
          }))),
          files.map(file => ({ provider: readString(file, 'provider', 'type'), priority: parseAuthFilePriority(file.priority) ?? 0, disabled: accountSummary(file).health.disabled })),
        ) : null,
        startsWithWindows: software ? { autostart: software.autostartEnabled, startProxy: software.startCoreOnLaunch } : null,
        connectedApps: apps.filter(app => app.installed && app.connectionState !== 'not-configured').length,
      }));
    } finally {
      setChecking(false);
    }
  }, [proxyRunning, status?.running, status?.currentVersion, status?.managed, t, hasUpdate, latest]);

  useEffect(() => { void run(); }, [run]);

  const problems = checks?.filter(check => check.level !== 'ok').length ?? 0;
  const copyReport = async () => {
    if (!snapshot || !checks) return;
    try {
      const report = diagnosticReport({
        ...snapshot,
        generatedAt: new Date(),
        hubVersion: await getVersion().catch(() => 'unknown'),
        checks: checks.map(check => ({ level: check.level, text: t(check.key as 'health.title', check.variables) })),
      });
      await navigator.clipboard.writeText(report);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
    window.setTimeout(() => setCopied(null), 4000);
  };
  const open = (target: HealthCheck['target']) => window.dispatchEvent(new CustomEvent('app:navigate', { detail: target }));
  return <div className="health-page">
    <header className="health-heading">
      <div>
        <h1>{t('health.title')}</h1>
        <p>{checks === null ? t('health.checking') : problems ? t(problems === 1 ? 'health.summary.one' : 'health.summary.many', { count: problems }) : t('health.summary.clear')}</p>
      </div>
      <div className="health-actions">
        <button type="button" className="secondary-button compact-button" disabled={checking || !snapshot} onClick={() => void copyReport()}
          title={t('health.copyReport.hint')}>
          {copied === 'ok' ? <Check size={14} aria-hidden="true" /> : <ClipboardCopy size={14} aria-hidden="true" />}
          {copied === 'ok' ? t('health.copyReport.done') : copied === 'failed' ? t('health.copyReport.failed') : t('health.copyReport')}
        </button>
        <button type="button" className="secondary-button compact-button" disabled={checking} onClick={() => void run()}>
          <RefreshCw size={14} className={checking ? 'spin' : undefined} aria-hidden="true" />{t('health.recheck')}
        </button>
      </div>
    </header>
    <ul className="health-list" aria-busy={checking || undefined}>
      {checks?.map(check => {
        const Icon = icons[check.level];
        return <li key={check.id} className={`health-item level-${check.level}`}>
          <Icon size={18} aria-hidden="true" />
          <span className="health-text">{t(check.key as 'health.title', check.variables)}</span>
          {check.target && check.level !== 'ok' && <button type="button" className="secondary-button compact-button" onClick={() => open(check.target)}>
            {t('health.fix')}<ArrowRight size={12} aria-hidden="true" />
          </button>}
        </li>;
      })}
    </ul>
    <ProxyUptimeCard />
  </div>;
}

/** The proxy's last week, from the hub's 30-second checks, one cell per day. */
function ProxyUptimeCard() {
  const { t } = useI18n();
  const history = useProxyUptime();
  const summary = summarizeUptime(history, Date.now());
  const format = (percent: number) => `${percent >= 99.95 || percent < 0.05 ? Math.round(percent) : percent.toFixed(1)}%`;
  return <section className="health-uptime" aria-labelledby="health-uptime-title">
    <div className="health-uptime-heading">
      <h2 id="health-uptime-title">{t('health.uptime.title')}</h2>
      <span>{summary.percent === null ? t('health.uptime.none') : summary.outages === 1 ? t('health.uptime.summaryOne', { percent: format(summary.percent) }) : t('health.uptime.summary', { percent: format(summary.percent), outages: summary.outages })}</span>
    </div>
    <ol className="health-uptime-days">
      {summary.days.map(day => {
        const name = new Date(day.start).toLocaleDateString(undefined, { weekday: 'short' });
        const label = day.percent === null ? t('health.uptime.dayNone', { day: name }) : t('health.uptime.day', { day: name, percent: format(day.percent) });
        const tone = day.percent === null ? 'none' : day.percent >= 99.5 ? 'ok' : day.percent >= 95 ? 'warn' : 'fail';
        return <li key={day.start} className={`uptime-${tone}`} title={label} aria-label={label}><span aria-hidden="true">{name}</span></li>;
      })}
    </ol>
    <p>{t('health.uptime.note')}</p>
  </section>;
}
