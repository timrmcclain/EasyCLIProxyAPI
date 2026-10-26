import { MessageNotice } from '../appNotice';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, CircleCheck, CircleSlash, ExternalLink, FlaskConical, KeyRound, RefreshCw } from 'lucide-react';
import { requestRequestDetail } from '../usageNavigation';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { resetCountdown } from '../services/accountDashboard';
import { readableError } from '../services/readableError';
import { rotateUrl, secretSeverity, weeklySafety } from '../services/secretSeverity';
import {
  SECRET_GUARD_MODES, SECRET_GUARD_PROVIDERS, modeFor, openFindings, publishOpenCount, secretGuardApp, secretGuardKind, secretGuardService,
  type SecretGuardCheckHit, type SecretGuardFinding, type SecretGuardMode, type SecretGuardProvider, type SecretGuardStatus,
} from '../services/secretGuard';
import './HealthCheckPage.css';
import './JevPage.css';
import './SecretGuardPage.css';

const kindKey = secretGuardKind;
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
  const [testText, setTestText] = useState('');
  const [testHits, setTestHits] = useState<SecretGuardCheckHit[] | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setFindings(await secretGuardService.findings());
      setLoadError(null);
    } catch (cause) {
      setLoadError(readableError(cause));
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

  // Keep the sidebar badge in step as soon as something is handled here, not at the watcher's next check.
  useEffect(() => {
    if (!findings || !status) return;
    publishOpenCount(openFindings(findings, status.policy).length);
  }, [findings, status]);

  const runTest = async () => {
    setTestError(null);
    try {
      setTestHits(await secretGuardService.check(testText));
    } catch (cause) {
      setTestHits(null);
      setTestError(readableError(cause));
    }
  };

  /** One change at a time: a second click while one is running is ignored. */
  const run = async (id: string, action: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(id);
    setActionError(null);
    try {
      await action();
    } catch (cause) {
      setActionError(t('sg.error', { error: readableError(cause) }));
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

  if (loadError && !findings) return <div className="health-page sg-page"><MessageNotice inline message={t('sg.loadError', { error: loadError })} /></div>;

  const policy = status?.policy ?? { defaultMode: 'report' as SecretGuardMode, modes: {}, allow: [] };
  const all = findings ?? [];
  const open = openFindings(all, policy);
  const handled = all.filter(item => !open.includes(item));
  const reportOnly = SECRET_GUARD_PROVIDERS.every(provider => ['report', 'off'].includes(modeFor(policy, provider)));
  const bundled = status?.info.bundled ?? true;

  const stateLine = () => {
    if (proxyDown) return { icon: AlertTriangle, level: 'warn', text: t('sg.state.proxyDown') };
    if (!status) return null;
    // An older copy still loaded, whether updated just now or before the page was last opened.
    const staleCopy = status.running && status.loadedVersion !== '' && status.loadedVersion !== status.info.bundledVersion;
    // Copy the new build in first (the hub only does that when switching on), then the proxy needs a restart.
    if (staleCopy && !restartNeeded && !status.info.installedCurrent && status.on) return { icon: AlertTriangle, level: 'warn', text: t('sg.state.update', { version: status.info.bundledVersion }), retry: true, retryLabel: t('sg.updateNow') };
    if ((restartNeeded || staleCopy) && status.on) return { icon: AlertTriangle, level: 'warn', text: t('sg.state.restart') };
    if (!status.on) return { icon: CircleSlash, level: 'warn', text: t('sg.state.off') };
    if (status.pluginsOff) return { icon: AlertTriangle, level: 'warn', text: t('sg.state.pluginsOff'), retry: true };
    if (!status.running) return { icon: AlertTriangle, level: 'warn', text: t('sg.state.starting'), retry: true };
    if (SECRET_GUARD_PROVIDERS.every(provider => modeFor(policy, provider) === 'off')) return { icon: CircleSlash, level: 'warn', text: t('sg.state.allOff') };
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
    const severity = secretSeverity(item.kind);
    const rotatePage = rotateUrl(item.kind);
    return <li key={item.fingerprint} className={`sg-finding severity-${severity}${isHandled ? ' handled' : ''}${item.actions.includes('blocked') ? ' blocked' : ''}`}>
      <KeyRound size={18} aria-hidden="true" className="sg-finding-icon" />
      <div className="sg-finding-body">
        <div className="sg-finding-title">
          <strong>{t(`sg.kind.${kind}` as MessageKey)}</strong>
          <span className={`sg-severity sg-severity-${severity}`} title={t(`as.sg.severityHint.${severity}`)}>{t(`as.sg.severity.${severity}`)}</span>
          {item.actions.map(action => <span key={action} className={`sg-action sg-action-${action}`}>{t(`sg.action.${action}` as MessageKey)}</span>)}
          {isHandled && <span className="sg-action sg-action-handled">{t(allowed ? 'sg.finding.handledSafe' : 'sg.finding.handledRotated')}</span>}
        </div>
        <p className="sg-finding-meta">{t('sg.finding.sentTo', { providers: item.providers.map(providerLabel).join(', '), apps: apps.join(', ') || '—' })}</p>
        <p className="sg-finding-meta">
          <span title={new Date(item.lastSeen).toLocaleString()}>{t('sg.finding.when', { first: ago(item.firstSeen, now), last: ago(item.lastSeen, now) })}</span>
          <span className="sg-fingerprint">{t('sg.finding.fingerprint', { fingerprint: item.fingerprint })}</span>
        </p>
        {!isHandled && <p className="sg-rotate">{t(`sg.rotate.${kind}` as MessageKey)}</p>}
        {!isHandled && <p className="sg-severity-hint">{t(`as.sg.severityHint.${severity}`)}</p>}
      </div>
      <div className="sg-finding-actions">
        {!isHandled && rotatePage && <button type="button" className="secondary-button compact-button" title={rotatePage}
          onClick={() => void invoke('open_external_url', { url: rotatePage }).catch(() => undefined)}><ExternalLink size={14} aria-hidden="true" />{t('as.sg.rotate')}</button>}
        {item.requestIds?.length ? <button type="button" className="secondary-button compact-button" title={t('sg.finding.viewRequestHint')}
          onClick={() => requestRequestDetail(item.requestIds![0])}><ExternalLink size={14} aria-hidden="true" />{t('sg.finding.viewRequest')}</button> : null}
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
            {'retry' in line && line.retry && <button type="button" className="secondary-button compact-button" onClick={() => void toggle(true)}>{('retryLabel' in line && line.retryLabel) || t('sg.retry')}</button>}
          </p>}
        {status && !status.on && status.pluginsOff && <p className="sg-state" role="note">{t('sg.pluginsNote')}</p>}
        {status?.on && status.info.codexSteeringBypass && <p className="sg-state level-warn" role="note">
          <AlertTriangle size={16} aria-hidden="true" />{t('sg.codexSteering')}
        </p>}
      </>}
      {actionError && <MessageNotice inline message={actionError} onDismiss={() => setActionError(null)} />}
    </section>

    <section aria-labelledby="sg-findings-title" className="jev-card">
      <header className="jev-card-heading">
        <div>
          <h2 id="sg-findings-title" className="jev-section-title">{t('sg.findings.title')}{open.length > 0 && <span className="sg-count" aria-label={t('sg.findings.openCount', { count: open.length })}>{open.length}</span>}</h2>
          <p className="jev-subtitle">{t('sg.findings.subtitle')}</p>
        </div>
        {handled.length > 0 && <button type="button" className="secondary-button compact-button" aria-expanded={showHandled} onClick={() => setShowHandled(value => !value)}>
          {showHandled ? t('sg.findings.hideHandled') : t('sg.findings.showHandled', { count: handled.length })}
        </button>}
      </header>
      {(() => {
        const week = weeklySafety(all, now);
        if (week.caught === 0) return <p className="sg-week">{t('as.sg.weekNone')}</p>;
        return <p className="sg-week">
          <strong>{t('as.sg.week', { caught: week.caught, s: week.caught === 1 ? '' : 's' })}</strong>
          <span>{t('as.sg.weekStopped', { stopped: week.stopped })}</span>
          <span>{t('as.sg.weekReported', { reported: week.reported })}</span>
          {week.critical > 0 && <span className="sg-week-critical">{t('as.sg.weekCritical', { critical: week.critical })}</span>}
        </p>;
      })()}
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
      {/* The modes live in the plugin's settings in the proxy, so they can only change while it's on and reachable. */}
      {(proxyDown || !status?.on) && <p className="sg-state sg-policy-locked" role="note">{t(proxyDown ? 'sg.policy.lockedProxy' : 'sg.policy.lockedOff')}</p>}
      <dl className="sg-policy">
        {SECRET_GUARD_PROVIDERS.map(provider => <div key={provider}>
          <dt>{providerLabel(provider)}</dt>
          <dd>{modeSelect(provider, modeFor(policy, provider), providerLabel(provider))}</dd>
        </div>)}
      </dl>
    </section>

    <section aria-labelledby="sg-test-title" className="jev-card sg-test">
      <div>
        <h2 id="sg-test-title" className="jev-section-title"><FlaskConical size={16} aria-hidden="true" />{t('sg.test.title')}</h2>
        <p className="jev-subtitle">{t('sg.test.subtitle')}</p>
      </div>
      <textarea aria-label={t('sg.test.label')} placeholder={t('sg.test.placeholder')} value={testText} rows={4} spellCheck={false}
        onChange={event => { setTestText(event.currentTarget.value); setTestHits(null); }} />
      <div className="sg-test-actions">
        <button type="button" className="secondary-button compact-button" disabled={!testText.trim()} onClick={() => void runTest()}>{t('sg.test.check')}</button>
        {testHits && <span role="status">{testHits.length ? t('sg.test.found', { count: testHits.length }) : t('sg.test.none')}</span>}
      </div>
      {testHits && testHits.length > 0 && <ul className="sg-test-hits">
        {testHits.map((hit, index) => <li key={`${hit.kind}-${index}`}><strong>{t(`sg.kind.${kindKey(hit.kind)}` as MessageKey)}</strong><code>{hit.hint}</code></li>)}
      </ul>}
      {testError && <MessageNotice inline message={t('sg.error', { error: testError })} onDismiss={() => setTestError(null)} />}
    </section>
  </div>;
}
