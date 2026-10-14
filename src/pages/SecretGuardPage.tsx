import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CircleCheck, CircleSlash, KeyRound, RefreshCw } from 'lucide-react';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { resetCountdown } from '../services/accountDashboard';
import {
  SECRET_GUARD_MODES, SECRET_GUARD_PROVIDERS, modeFor, openFindings, secretGuardApp, secretGuardService,
  type SecretGuardFinding, type SecretGuardMode, type SecretGuardProvider, type SecretGuardStatus,
} from '../services/secretGuard';
import './HealthCheckPage.css';
import './JevPage.css';
import './SecretGuardPage.css';

const KINDS = new Set(['github_token', 'anthropic_key', 'openai_key', 'google_api_key', 'aws_access_key', 'slack_token', 'stripe_key',
  'azure_storage_key', 'azure_client_secret', 'private_key', 'jwt', 'connection_string_password', 'password_assignment']);
const kindKey = (kind: string) => (KINDS.has(kind) ? kind : 'other');
const ago = (at: number, now: number) => resetCountdown(now + Math.max(60_000, now - at), now);
const POLL_MS = 15_000;

/** Credentials found in outgoing prompts, and what the proxy does about them. */
export function SecretGuardPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<SecretGuardStatus | null>(null);
  const [proxyDown, setProxyDown] = useState(false);
  const [findings, setFindings] = useState<SecretGuardFinding[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [showHandled, setShowHandled] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    try {
      setFindings(await secretGuardService.findings());
      setLoadError(null);
    } catch (cause) {
      setLoadError(String(cause));
    }
    try {
      setStatus(await secretGuardService.status());
      setProxyDown(false);
    } catch {
      // The findings file is local; only the switch and policy need the proxy.
      setProxyDown(true);
      setStatus(current => current ?? null);
    }
    setNow(Date.now());
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (!busyRef.current) void load(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  /** One change at a time: a second click while one is running is ignored. */
  const run = async (id: string, action: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(id);
    setActionError(null);
    try {
      await action();
    } catch (cause) {
      setActionError(t('sg.error', { error: String(cause) }));
    } finally {
      await load();
      busyRef.current = false;
      setBusy(null);
    }
  };

  const toggle = (on: boolean) => run('switch', async () => {
    if (on) {
      const install = await secretGuardService.enable();
      setRestartNeeded(install.replacedLoadedCopy);
    } else {
      await secretGuardService.disable();
    }
  });

  if (loadError && !findings) return <div className="health-page sg-page"><p role="alert" className="ad-notice ad-error">{t('sg.loadError', { error: loadError })}</p></div>;

  const policy = status?.policy ?? { defaultMode: 'report' as SecretGuardMode, modes: {}, allow: [] };
  const all = findings ?? [];
  const open = openFindings(all, policy);
  const handled = all.filter(item => !open.includes(item));
  const reportOnly = SECRET_GUARD_PROVIDERS.every(provider => ['report', 'off'].includes(modeFor(policy, provider)));
  const bundled = status?.info.bundled ?? true;

  const stateLine = () => {
    if (proxyDown) return { icon: AlertTriangle, level: 'warn', text: t('sg.state.proxyDown') };
    if (!status) return null;
    if (restartNeeded && status.on) return { icon: AlertTriangle, level: 'warn', text: t('sg.state.restart') };
    if (!status.on) return { icon: CircleSlash, level: 'warn', text: t('sg.state.off') };
    if (!status.running) return { icon: AlertTriangle, level: 'warn', text: t('sg.state.starting'), retry: true };
    return { icon: CircleCheck, level: 'ok', text: `${t('sg.state.running')}${reportOnly ? ` ${t('sg.reportOnly')}` : ''}` };
  };
  const line = stateLine();
  const LineIcon = line?.icon;

  const providerLabel = (provider: string) => t(`sg.provider.${(SECRET_GUARD_PROVIDERS as readonly string[]).includes(provider) ? provider : 'other'}` as MessageKey);

  const renderFinding = (item: SecretGuardFinding) => {
    const kind = kindKey(item.kind);
    const allowed = policy.allow.includes(item.fingerprint);
    const isHandled = item.dismissedAt !== null || allowed;
    const apps = [...new Set(item.clients.map(secretGuardApp))].filter(Boolean);
    return <li key={item.fingerprint} className={`sg-finding${isHandled ? ' handled' : ''}${item.actions.includes('blocked') ? ' blocked' : ''}`}>
      <KeyRound size={18} aria-hidden="true" className="sg-finding-icon" />
      <div className="sg-finding-body">
        <div className="sg-finding-title">
          <strong>{t(`sg.kind.${kind}` as MessageKey)}</strong>
          {item.actions.map(action => <span key={action} className={`sg-action sg-action-${action}`}>{t(`sg.action.${action}` as MessageKey)}</span>)}
          {isHandled && <span className="sg-action sg-action-handled">{t(allowed ? 'sg.finding.handledSafe' : 'sg.finding.handledRotated')}</span>}
        </div>
        <p className="sg-finding-meta">{t('sg.finding.sentTo', { providers: item.providers.map(providerLabel).join(', '), apps: apps.join(', ') || '—' })}</p>
        <p className="sg-finding-meta">
          <span title={new Date(item.lastSeen).toLocaleString()}>{t('sg.finding.when', { first: ago(item.firstSeen, now), last: ago(item.lastSeen, now) })}</span>
          <span className="sg-fingerprint">{t('sg.finding.fingerprint', { fingerprint: item.fingerprint })}</span>
        </p>
        {!isHandled && <p className="sg-rotate">{t(`sg.rotate.${kind}` as MessageKey)}</p>}
      </div>
      <div className="sg-finding-actions">
        {isHandled
          ? <button type="button" className="secondary-button compact-button" disabled={busy !== null}
            onClick={() => void run(item.fingerprint, async () => {
              if (allowed) await secretGuardService.setAllowed(item.fingerprint, false);
              if (item.dismissedAt !== null) await secretGuardService.dismiss(item.fingerprint, false);
            })}>{t('sg.finding.undo')}</button>
          : <>
            <button type="button" className="primary-button compact-button" disabled={busy !== null}
              onClick={() => void run(item.fingerprint, () => secretGuardService.dismiss(item.fingerprint, true))}>{t('sg.finding.rotated')}</button>
            <button type="button" className="secondary-button compact-button" disabled={busy !== null || proxyDown} title={t('sg.finding.safeHint')}
              onClick={() => void run(item.fingerprint, () => secretGuardService.setAllowed(item.fingerprint, true))}>{t('sg.finding.safe')}</button>
          </>}
      </div>
    </li>;
  };

  const modeSelect = (provider: SecretGuardProvider | 'default', value: SecretGuardMode, label: string) =>
    <select aria-label={label} value={value} disabled={!status?.on || proxyDown || busy !== null}
      onChange={event => void run(`mode-${provider}`, () => secretGuardService.setMode(provider, event.currentTarget.value as SecretGuardMode))}>
      {SECRET_GUARD_MODES.map(mode => <option key={mode} value={mode}>{t(`sg.mode.${mode}` as MessageKey)} — {t(`sg.mode.${mode}.hint` as MessageKey)}</option>)}
    </select>;

  return <div className="health-page jev-page sg-page" aria-busy={findings === null || undefined}>
    <header className="health-heading">
      <div>
        <h1>{t('sg.title')}</h1>
        <p>{t('sg.subtitle')}</p>
      </div>
    </header>

    <section className="jev-card sg-switch-card" aria-label={t('sg.switch')}>
      {!bundled ? <p className="glance-muted">{t('sg.notBundled')}</p> : <>
        <div className="sg-switch-row">
          <span className="sg-switch-label">{t('sg.switch')}</span>
          <label className="switch-control" title={t('sg.switch')}>
            <input type="checkbox" role="switch" aria-label={t('sg.switch')} checked={Boolean(status?.on)}
              disabled={!status || proxyDown || busy !== null} onChange={event => void toggle(event.currentTarget.checked)} />
            <span className="switch-track" />
          </label>
        </div>
        {busy === 'switch' ? <p className="sg-state level-ok"><RefreshCw size={16} className="spin" aria-hidden="true" />{t('sg.working')}</p>
          : line && LineIcon && <p className={`sg-state level-${line.level}`} role="status">
            <LineIcon size={16} aria-hidden="true" />{line.text}
            {'retry' in line && line.retry && <button type="button" className="secondary-button compact-button" onClick={() => void toggle(true)}>{t('sg.retry')}</button>}
          </p>}
      </>}
      {actionError && <p role="alert" className="jev-error">{actionError}</p>}
    </section>

    <section aria-labelledby="sg-findings-title" className="jev-card">
      <header className="jev-card-heading">
        <div>
          <h2 id="sg-findings-title" className="jev-section-title">{t('sg.findings.title')}{open.length > 0 && <span className="sg-count">{open.length}</span>}</h2>
          <p className="jev-subtitle">{t('sg.findings.subtitle')}</p>
        </div>
        {handled.length > 0 && <button type="button" className="secondary-button compact-button" aria-expanded={showHandled} onClick={() => setShowHandled(value => !value)}>
          {showHandled ? t('sg.findings.hideHandled') : t('sg.findings.showHandled', { count: handled.length })}
        </button>}
      </header>
      {all.length === 0 ? <p className="glance-muted">{t('sg.findings.none')}</p>
        : <>
          {open.length === 0 && <p className="glance-muted">{t('sg.findings.allHandled')}</p>}
          <ul className="sg-findings">
            {open.map(renderFinding)}
            {showHandled && handled.map(renderFinding)}
          </ul>
        </>}
    </section>

    <section aria-labelledby="sg-policy-title" className="jev-card">
      <div>
        <h2 id="sg-policy-title" className="jev-section-title">{t('sg.policy.title')}</h2>
        <p className="jev-subtitle">{t('sg.policy.subtitle')}</p>
      </div>
      <dl className="sg-policy">
        {SECRET_GUARD_PROVIDERS.map(provider => <div key={provider}>
          <dt>{providerLabel(provider)}</dt>
          <dd>{modeSelect(provider, modeFor(policy, provider), providerLabel(provider))}</dd>
        </div>)}
      </dl>
    </section>
  </div>;
}
