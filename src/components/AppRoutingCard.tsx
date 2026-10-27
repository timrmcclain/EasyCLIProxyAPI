import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CircleCheck, CircleSlash } from 'lucide-react';
import { useI18n } from '../i18n';
import { appRoutingService, ruleFor, type AppRoutingStatus, type RoutingAccount } from '../services/appRouting';
import { readableError } from '../services/readableError';
import { Skeleton } from './Skeleton';
import './AppRoutingCard.css';

const PROVIDER_NAMES: Record<string, string> = {
  claude: 'Claude', codex: 'Codex', kimi: 'Kimi', xai: 'Grok', antigravity: 'Antigravity', devin: 'Devin', gemini: 'Gemini',
};
const providerName = (provider: string) => PROVIDER_NAMES[provider] ?? provider;

/**
 * Who pays for one app: tick the accounts it should use and what happens when none of them can take a request.
 * Saving installs and configures the App Routing proxy plugin; clearing puts the app back on the normal order.
 */
export function AppRoutingCard({ app, appName }: { app: string; appName: string }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<AppRoutingStatus | null>(null);
  const [accounts, setAccounts] = useState<RoutingAccount[] | null>(null);
  const [proxyDown, setProxyDown] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [only, setOnly] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [restartNeeded, setRestartNeeded] = useState(false);
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const [nextStatus, nextAccounts] = await Promise.all([appRoutingService.status(), appRoutingService.accounts()]);
      setStatus(nextStatus);
      setAccounts(nextAccounts);
      setProxyDown(false);
      setLoadError('');
    } catch (cause) {
      setProxyDown(true);
      setLoadError(readableError(cause));
    }
  }, []);

  useEffect(() => { void load(); }, [load, app]);
  useEffect(() => { setDirty(false); setNotice(''); setError(''); }, [app]);

  const rule = status?.rules[app];
  // The saved rule, until you start changing it.
  useEffect(() => {
    if (dirty) return;
    setChosen(rule?.accounts ?? []);
    setOnly(rule?.only ?? false);
  }, [rule, dirty]);

  const byProvider = useMemo(() => {
    const groups = new Map<string, RoutingAccount[]>();
    for (const account of accounts ?? []) groups.set(account.provider, [...(groups.get(account.provider) ?? []), account]);
    return [...groups];
  }, [accounts]);

  const toggle = (name: string) => {
    setDirty(true);
    setNotice('');
    setChosen(current => current.includes(name) ? current.filter(item => item !== name) : [...current, name]);
  };

  const save = async (clear: boolean) => {
    if (busyRef.current || !accounts) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = clear ? null : ruleFor(accounts, chosen, only);
      const wasRunning = status?.running ?? false;
      const wasCurrent = status?.info.installedCurrent ?? true;
      await appRoutingService.setRule(app, next);
      // An older copy the proxy had loaded is replaced on disk; it takes over after a restart.
      if (next && wasRunning && !wasCurrent) setRestartNeeded(true);
      setDirty(false);
      setNotice(t(next ? 'ar.saved' : 'ar.cleared', { app: appName }));
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      await load();
      busyRef.current = false;
      setBusy(false);
    }
  };

  const stateLine = () => {
    if (proxyDown) return { Icon: AlertTriangle, level: 'warn', text: t('ar.state.proxyDown') };
    if (!status) return null;
    if (!rule) return { Icon: CircleSlash, level: 'muted', text: t('ar.state.none') };
    const staleCopy = status.running && status.loadedVersion !== '' && status.loadedVersion !== status.info.bundledVersion;
    if (restartNeeded || staleCopy) return { Icon: AlertTriangle, level: 'warn', text: t('ar.state.restart') };
    if (!status.running) return { Icon: AlertTriangle, level: 'warn', text: t('ar.state.starting') };
    return { Icon: CircleCheck, level: 'ok', text: t('ar.state.running', { app: appName, count: rule.accounts.length }) };
  };
  const line = stateLine();

  const chosenProviders = new Set((accounts ?? []).filter(account => chosen.includes(account.name)).map(account => account.provider));
  const otherProviders = byProvider.map(([provider]) => provider).filter(provider => chosenProviders.size > 0 && !chosenProviders.has(provider));
  const bundled = status?.info.bundled ?? true;
  const locked = busy || proxyDown || !bundled;
  const changed = dirty && (chosen.length > 0 || Boolean(rule));

  return (
    <section className="agent-core-setting-section app-routing-card" aria-labelledby={`app-routing-title-${app}`}>
      <div className="agent-section-heading">
        <div>
          <strong id={`app-routing-title-${app}`}>{t('ar.title', { app: appName })}</strong>
          <p className="app-routing-subtitle">{t('ar.subtitle', { app: appName })}</p>
        </div>
      </div>
      {line ? <p className={`app-routing-state app-routing-state-${line.level}`} role="status">
        <line.Icon size={15} aria-hidden="true" />{line.text}
      </p> : null}
      {!bundled ? <p className="app-routing-note">{t('ar.notBundled')}</p> : null}
      {loadError && !accounts ? <p className="app-routing-note">{t('ar.loadError', { error: loadError })}</p> : null}
      {!accounts && !loadError ? <Skeleton label={t('ar.loading')} count={3} /> : null}
      {accounts && !accounts.length ? <p className="app-routing-note">{t('ar.noAccounts')}</p> : null}
      {accounts && accounts.length > 0 ? <>
        <div className="app-routing-groups">
          {byProvider.map(([provider, list]) => (
            <fieldset className="app-routing-group" key={provider}>
              <legend>{providerName(provider)}</legend>
              {list.map(account => (
                <label className="app-routing-account" key={account.name} title={account.name}>
                  <input type="checkbox" checked={chosen.includes(account.name)} disabled={locked} onChange={() => toggle(account.name)} />
                  <span>{account.label}</span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
        <fieldset className="app-routing-fallback" disabled={locked}>
          <legend>{t('ar.fallback.label')}</legend>
          <label>
            <input type="radio" name={`app-routing-fallback-${app}`} checked={!only} onChange={() => { setOnly(false); setDirty(true); setNotice(''); }} />
            <span><strong>{t('ar.fallback.prefer')}</strong> <span className="app-routing-hint">{t('ar.fallback.preferHint')}</span></span>
          </label>
          <label>
            <input type="radio" name={`app-routing-fallback-${app}`} checked={only} onChange={() => { setOnly(true); setDirty(true); setNotice(''); }} />
            <span><strong>{t('ar.fallback.only')}</strong> <span className="app-routing-hint">{t('ar.fallback.onlyHint', { app: appName })}</span></span>
          </label>
        </fieldset>
        <p className="app-routing-hint">{t('ar.sticky')}</p>
        {otherProviders.length ? <p className="app-routing-hint">{t('ar.otherProviders', { providers: otherProviders.map(providerName).join(', ') })}</p> : null}
        <div className="app-routing-actions">
          <button type="button" className="primary-button compact-button" disabled={locked || !changed || (!chosen.length && !rule)}
            onClick={() => void save(chosen.length === 0)}>{t('ar.save')}</button>
          {rule ? <button type="button" className="secondary-button compact-button" disabled={locked}
            onClick={() => void save(true)}>{t('ar.clear', { app: appName })}</button> : null}
        </div>
      </> : null}
      {notice ? <p className="app-routing-notice" role="status">{notice}</p> : null}
      {error ? <p className="app-routing-error" role="alert">{error}</p> : null}
    </section>
  );
}
