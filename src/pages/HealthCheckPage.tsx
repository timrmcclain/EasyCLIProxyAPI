import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { isPermissionGranted } from '@tauri-apps/plugin-notification';
import { AlertTriangle, ArrowRight, Check, CircleCheck, CircleX, ClipboardCopy, RefreshCw } from 'lucide-react';
import { useI18n } from '../i18n';
import { useCoreRuntime } from '../coreRuntime';
import { needsSignIn } from '../components/AuthFileProviderIcon';
import { accountSummary } from '../services/accountDashboard';
import { dedupeAuthFiles } from '../services/authFiles';
import { compressionService } from '../services/compression';
import { driftedApps, loadAppStatuses } from '../services/connectedApps';
import { readDesktopAlertsPreference } from '../services/dashboardPreferences';
import { healthChecks, type HealthCheck, type HealthLevel } from '../services/healthCheck';
import { diagnosticReport, type DiagnosticInput } from '../services/diagnostics';
import { managementApi, readString, responseList } from '../services/managementApi';
import './HealthCheckPage.css';

type CoreSettings = { apiKeys: unknown[]; managementSecretConfigured: boolean };
type ListenStatus = { host: string; port: number; exposed: boolean; portInUse: boolean; owner: { pid: number; name: string } | null };

const icons: Record<HealthLevel, typeof CircleCheck> = { ok: CircleCheck, warn: AlertTriangle, fail: CircleX };

/** Everything worth fixing on one page, worst first, each with a link to where it's fixed. */
export function HealthCheckPage() {
  const { t } = useI18n();
  const { status } = useCoreRuntime();
  const [snapshot, setSnapshot] = useState<Omit<DiagnosticInput, 'generatedAt' | 'hubVersion' | 'checks'> | null>(null);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const proxyRunning = Boolean(status?.ready);
  const [checks, setChecks] = useState<HealthCheck[] | null>(null);
  const [checking, setChecking] = useState(false);

  const run = useCallback(async () => {
    setChecking(true);
    try {
      const [settings, listen, files, apps, compression, allowed] = await Promise.all([
        invoke<CoreSettings>('get_core_config_settings').catch(() => null),
        invoke<ListenStatus>('proxy_listen_status').catch(() => null),
        proxyRunning ? managementApi.get('/credentials').then(payload => dedupeAuthFiles(responseList(payload, 'files'))).catch(() => []) : Promise.resolve([]),
        loadAppStatuses(true).catch(() => []),
        compressionService.status().catch(() => null),
        isPermissionGranted().catch(() => null),
      ]);
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
        exposed: listen?.exposed ?? false,
        // Our own proxy holding the port isn't a conflict, just a proxy the hub hasn't connected to yet.
        portBlockedBy: !proxyRunning && listen?.portInUse && listen.owner && !/cli-proxy-api/i.test(listen.owner.name)
          ? { port: listen.port, name: listen.owner.name, pid: listen.owner.pid } : null,
        keyCount: settings?.apiKeys.length ?? 1,
        managementSecretConfigured: settings?.managementSecretConfigured ?? true,
        signInNeeded: files.filter(needsSignIn).map(file => readString(file, 'label', 'email', 'name') || accountSummary(file).label),
        disabledAccounts: files.filter(file => accountSummary(file).health.disabled).length,
        totalAccounts: files.length,
        driftedApps: driftedApps(apps).map(app => app.name),
        compression: compression ? { enabled: compression.enabled, running: compression.running } : null,
        notificationsAllowed: allowed,
        notificationsEnabled: readDesktopAlertsPreference(),
      }));
    } finally {
      setChecking(false);
    }
  }, [proxyRunning, status?.running, status?.currentVersion, status?.managed, t]);

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
  </div>;
}
