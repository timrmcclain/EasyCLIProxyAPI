import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, LoaderCircle, PartyPopper } from 'lucide-react';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { requestOAuthSubpage } from '../oauthNavigation';
import { checkCoreModelHealth, type CoreHealthModel } from '../services/coreHealthCheck';
import {
  connectedAppNames, SETUP_STATE_KEY, SETUP_TEST_KEY, setupProgress, setupView, SHOW_SETUP_EVENT,
  takePendingSetupSteps, type SetupAppStatus, type SetupStepId,
} from '../services/firstRunSetup';
import { readableError } from '../services/readableError';
import { formatAgo } from '../services/relativeTime';
import { requestSettingsCategory } from '../services/settingsNavigation';
import './FirstRunSetup.css';

type TestResult = { model: string; ms?: number };
const readStored = () => { try { return localStorage.getItem(SETUP_STATE_KEY) ?? ''; } catch { return ''; } };
const readTest = (): TestResult | null => {
  try { const value = JSON.parse(localStorage.getItem(SETUP_TEST_KEY) ?? 'null'); return value?.model ? value : null; } catch { return null; }
};
const navigate = (page: string) => window.dispatchEvent(new CustomEvent('app:navigate', { detail: page }));

/**
 * The first thing a new hub shows: four steps to the first request going through, each ticked off from the
 * hub's real state, with one clear next action at a time. It closes itself with a "you're set up" moment.
 */
export function FirstRunSetup({ coreInstalled, coreRunning, coreBusy, onStartProxy, accounts, latestAt, models }: {
  coreInstalled: boolean; coreRunning: boolean; coreBusy: boolean; onStartProxy: () => void;
  /** Null until the account list has loaded (it can't load while the hub is stopped). */
  accounts: number | null; latestAt?: string; models: CoreHealthModel[] | null;
}) {
  const { t, locale } = useI18n();
  const [stored, setStored] = useState(readStored);
  const [forced, setForced] = useState(takePendingSetupSteps);
  const [apps, setApps] = useState<string[] | null>(null);
  const [test, setTest] = useState<TestResult | null>(readTest);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState('');
  const everIncomplete = useRef(false);

  const progress = setupProgress({ coreRunning, accounts: accounts ?? 0, apps: apps ?? [], requestSeen: Boolean(latestAt) || Boolean(test) });
  // Known only once both lists have loaded; a stopped hub is unknown, not incomplete.
  const known = accounts !== null && apps !== null;
  if (known && !progress.complete) everIncomplete.current = true;
  const view = !known && coreRunning ? 'hidden' : setupView({ stored, complete: progress.complete, everIncomplete: everIncomplete.current, forced });

  const remember = (value: string) => {
    setStored(value); setForced(false);
    try { localStorage.setItem(SETUP_STATE_KEY, value); } catch { /* Shown again next launch. */ }
  };
  // Already set up when it opened: close the steps for good without making a moment of it.
  useEffect(() => {
    if (known && progress.complete && !stored && !forced && !everIncomplete.current) remember('done');
  }, [known, progress.complete, stored, forced]);
  useEffect(() => {
    const show = () => { takePendingSetupSteps(); setStored(''); setForced(true); };
    window.addEventListener(SHOW_SETUP_EVENT, show);
    return () => window.removeEventListener(SHOW_SETUP_EVENT, show);
  }, []);

  const loadApps = useCallback(() => {
    invoke<SetupAppStatus[]>('get_agent_config_statuses').then(statuses => setApps(connectedAppNames(statuses))).catch(() => setApps(current => current ?? []));
  }, []);
  // Apps are connected outside this page (on AI apps, or by hand), so look again now and then while waiting for one.
  const waitingForApp = view === 'steps' && !progress.steps[2].done;
  useEffect(() => {
    loadApps();
    if (!waitingForApp) return;
    const timer = window.setInterval(loadApps, 15_000);
    window.addEventListener('focus', loadApps);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', loadApps); };
  }, [loadApps, waitingForApp]);

  const sendTest = async () => {
    const model = models?.[0]?.name;
    setTestError('');
    if (!model) { setTestError(t('fr.test.noModel')); return; }
    setTesting(true);
    const result = await checkCoreModelHealth(model);
    setTesting(false);
    if (!result.success) { setTestError(t('fr.test.failed', { error: readableError(result.error ?? '') })); return; }
    const passed = { model, ms: result.responseLatencyMs };
    setTest(passed);
    try { localStorage.setItem(SETUP_TEST_KEY, JSON.stringify(passed)); } catch { /* Ticked off for this session. */ }
  };

  if (view === 'hidden') return null;

  if (view === 'celebrate') {
    return (
      <section className="first-run first-run-celebrate" aria-labelledby="first-run-title">
        <header>
          <h2 id="first-run-title"><PartyPopper size={18} aria-hidden="true" />{t('fr.celebrate.title')}</h2>
        </header>
        <p className="first-run-intro">{t('fr.celebrate.body')}</p>
        <FourLights done={progress.doneCount} total={progress.total} label={t('fr.progress', { done: progress.doneCount, total: progress.total })} />
        <h3>{t('fr.celebrate.next')}</h3>
        <div className="first-run-next">
          <button type="button" className="secondary-button compact-button" onClick={() => { remember('done'); requestSettingsCategory('routing'); }}>{t('fr.celebrate.routing')}</button>
          <button type="button" className="secondary-button compact-button" onClick={() => { remember('done'); requestSettingsCategory('software'); }}>{t('fr.celebrate.digest')}</button>
          <button type="button" className="primary-button compact-button" onClick={() => remember('done')}>{t('fr.celebrate.done')}</button>
        </div>
      </section>
    );
  }

  const appNames = apps ?? [];
  const detail = (id: SetupStepId): string => {
    if (id === 'proxy') return t('fr.done.proxy');
    if (id === 'account') return t('fr.done.account', { count: accounts ?? 0 });
    if (id === 'app') return appNames.length > 2
      ? t('fr.done.appMore', { apps: appNames.slice(0, 2).join(', '), count: appNames.length - 2 })
      : t('fr.done.app', { apps: appNames.join(', ') });
    if (latestAt) return t('fr.done.request', { time: formatAgo(latestAt, locale) });
    return test?.ms ? t('fr.done.test', { model: test.model, ms: test.ms }) : t('fr.done.testNoTime', { model: test?.model ?? '' });
  };
  const action = (id: SetupStepId) => {
    if (id === 'proxy') return coreInstalled
      ? <button type="button" className="primary-button compact-button" disabled={coreBusy} onClick={onStartProxy}>
        {coreBusy && <LoaderCircle size={14} className="spin" aria-hidden="true" />}{t('fr.action.proxy')}</button>
      : <button type="button" className="primary-button compact-button" onClick={() => navigate('versions')}>{t('fr.action.install')}</button>;
    if (id === 'account') return <button type="button" className="primary-button compact-button" onClick={() => requestOAuthSubpage('login')}>{t('fr.action.account')}</button>;
    if (id === 'app') return <button type="button" className="primary-button compact-button" onClick={() => navigate('agents')}>{t('fr.action.app')}</button>;
    return <button type="button" className="primary-button compact-button" disabled={testing} onClick={() => void sendTest()}>
      {testing && <LoaderCircle size={14} className="spin" aria-hidden="true" />}{t(testing ? 'fr.action.testing' : 'fr.action.request')}</button>;
  };

  return (
    <section className="first-run" aria-labelledby="first-run-title">
      <header>
        <h2 id="first-run-title">{t('fr.title')}</h2>
        <button type="button" className="secondary-button compact-button" title={t('fr.hideHint')} onClick={() => remember('dismissed')}>{t('fr.hide')}</button>
      </header>
      <p className="first-run-intro">{t('fr.intro')}</p>
      <FourLights done={progress.doneCount} total={progress.total} label={t('fr.progress', { done: progress.doneCount, total: progress.total })} />
      <ol>
        {progress.steps.map((step, index) => {
          const current = step.id === progress.current;
          const state = step.done ? 'done' : current ? 'current' : 'later';
          return (
            <li key={step.id} className={`first-run-step ${state}`} aria-current={current ? 'step' : undefined}>
              <span className="first-run-mark" aria-hidden="true">{step.done ? <Check size={14} /> : index + 1}</span>
              <div className="first-run-text">
                <strong>{t(`fr.step.${step.id}` as MessageKey)}</strong>
                <span>{step.done ? detail(step.id) : current ? t(`fr.why.${step.id}` as MessageKey) : t('fr.later')}</span>
                {current && step.id === 'request' && <span className="first-run-aside">{t('fr.why.requestApp')}</span>}
                {current && step.id === 'request' && testError && <span className="first-run-error" role="alert">{testError}</span>}
              </div>
              {step.done ? <span className="sr-only">{t('fr.celebrate.done')}</span> : current && action(step.id)}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Progress as four lights, the same lights the switchboard uses for a working line. */
function FourLights({ done, total, label }: { done: number; total: number; label: string }) {
  return (
    <div className="first-run-lights" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={label}>
      {Array.from({ length: total }, (_, index) => <span key={index} className={index < done ? 'lit' : undefined} />)}
      <span className="first-run-lights-label" aria-hidden="true">{label}</span>
    </div>
  );
}
