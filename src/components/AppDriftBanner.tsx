import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, PlugZap } from 'lucide-react';
import { useI18n } from '../i18n';
import { driftedApps, loadAppStatuses, reapplyApps, type ConnectedAppStatus, type ReapplyOutcome } from '../services/connectedApps';
import { navigateHelp } from '../services/uxNavigation';
import './AppDriftBanner.css';

/**
 * Warns on the Overview when an app the hub set up stops matching it (an old key, address or
 * port), so requests from that app would fail. Re-apply fixes it in place, keeping its models.
 */
export function AppDriftBanner({ coreReady }: { coreReady: boolean }) {
  const { t } = useI18n();
  const [drifted, setDrifted] = useState<ConnectedAppStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<ReapplyOutcome[] | null>(null);

  const load = useCallback(async (refresh = false) => {
    try { setDrifted(driftedApps(await loadAppStatuses(refresh))); } catch { /* detection failed; nothing to warn about */ }
  }, []);

  useEffect(() => {
    if (!coreReady) return;
    void load();
    const timer = window.setInterval(() => { void load(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [coreReady, load]);

  const reapply = async () => {
    setBusy(true);
    try {
      setOutcomes(await reapplyApps(drifted));
      await load(true);
    } finally {
      setBusy(false);
    }
  };

  const unresolved = outcomes?.filter(outcome => outcome.result !== 'reapplied') ?? [];
  if (!drifted.length && !unresolved.length) return null;
  const names = drifted.map(app => app.name).join(', ');
  return <section className="app-drift-banner" role="status">
    <PlugZap size={18} aria-hidden="true" />
    <div className="app-drift-copy">
      <strong>{drifted.length === 1 ? t('drift.one', { app: names }) : t('drift.many', { apps: names })}</strong>
      <small>{t('drift.detail')}</small>
      {unresolved.length > 0 && <small className="app-drift-manual">{t('drift.manual', { apps: unresolved.map(outcome => outcome.name).join(', ') })}</small>}
    </div>
    <div className="app-drift-actions">
      {drifted.length > 0 && <button type="button" className="primary-button compact-button" disabled={busy} onClick={() => void reapply()}>
        {busy && <LoaderCircle size={14} className="spin" aria-hidden="true" />}{t('drift.reapply')}
      </button>}
      <button type="button" className="secondary-button compact-button" onClick={() => navigateHelp('agents')}>{t('drift.open')}</button>
    </div>
  </section>;
}
