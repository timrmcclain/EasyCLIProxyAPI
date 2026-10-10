import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isPermissionGranted } from '@tauri-apps/plugin-notification';
import { AlertTriangle, ArrowRight, CircleCheck, CircleX, RefreshCw } from 'lucide-react';
import { useI18n } from '../i18n';
import { useCoreRuntime } from '../coreRuntime';
import { needsSignIn } from '../components/AuthFileProviderIcon';
import { accountSummary } from '../services/accountDashboard';
import { dedupeAuthFiles } from '../services/authFiles';
import { compressionService } from '../services/compression';
import { driftedApps, loadAppStatuses } from '../services/connectedApps';
import { readDesktopAlertsPreference } from '../services/dashboardPreferences';
import { healthChecks, type HealthCheck, type HealthLevel } from '../services/healthCheck';
import { managementApi, readString, responseList } from '../services/managementApi';
import './HealthCheckPage.css';

type CoreSettings = { host: string; allowLan: boolean; apiKeys: unknown[]; managementSecretConfigured: boolean };

const icons: Record<HealthLevel, typeof CircleCheck> = { ok: CircleCheck, warn: AlertTriangle, fail: CircleX };

/** Everything worth fixing on one page, worst first, each with a link to where it's fixed. */
export function HealthCheckPage() {
  const { t } = useI18n();
  const { status } = useCoreRuntime();
  const proxyRunning = Boolean(status?.ready);
  const [checks, setChecks] = useState<HealthCheck[] | null>(null);
  const [checking, setChecking] = useState(false);

  const run = useCallback(async () => {
    setChecking(true);
    try {
      const [settings, files, apps, compression, allowed] = await Promise.all([
        invoke<CoreSettings>('get_core_config_settings').catch(() => null),
        proxyRunning ? managementApi.get('/credentials').then(payload => dedupeAuthFiles(responseList(payload, 'files'))).catch(() => []) : Promise.resolve([]),
        loadAppStatuses(true).catch(() => []),
        compressionService.status().catch(() => null),
        isPermissionGranted().catch(() => null),
      ]);
      setChecks(healthChecks({
        proxyRunning,
        host: settings?.host ?? '127.0.0.1',
        allowLan: settings?.allowLan ?? false,
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
  }, [proxyRunning]);

  useEffect(() => { void run(); }, [run]);

  const problems = checks?.filter(check => check.level !== 'ok').length ?? 0;
  const open = (target: HealthCheck['target']) => window.dispatchEvent(new CustomEvent('app:navigate', { detail: target }));
  return <div className="health-page">
    <header className="health-heading">
      <div>
        <h1>{t('health.title')}</h1>
        <p>{checks === null ? t('health.checking') : problems ? t(problems === 1 ? 'health.summary.one' : 'health.summary.many', { count: problems }) : t('health.summary.clear')}</p>
      </div>
      <button type="button" className="secondary-button compact-button" disabled={checking} onClick={() => void run()}>
        <RefreshCw size={14} className={checking ? 'spin' : undefined} aria-hidden="true" />{t('health.recheck')}
      </button>
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
