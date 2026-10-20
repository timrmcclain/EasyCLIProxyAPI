import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, ChevronDown, ExternalLink, Globe, Terminal } from 'lucide-react';
import { useI18n } from '../i18n';
import { connectorText, type ConnectorTextKey } from '../i18n/connectors';
import { readableError } from '../services/readableError';
import { chromeApi, chromeProgress, type ChromeIntegration } from '../services/chromeIntegration';

const EXPANDED_KEY = 'personal.connectorsExpanded';
const CARD_ID = 'chrome';
function readOpen() {
  try { const value: unknown = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]'); return Array.isArray(value) && value.includes(CARD_ID); }
  catch { return false; }
}
function saveOpen(open: boolean) {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]');
    const next = new Set(Array.isArray(value) ? value.filter(item => typeof item === 'string') : []);
    if (open) next.add(CARD_ID); else next.delete(CARD_ID);
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
  } catch { /* Open state just isn't remembered. */ }
}

/**
 * Claude in Chrome: not an MCP server the hub switches on, so this card only reports the three things that decide
 * whether Claude Code can drive your browser (extension, sign-in, link) and offers the next step for each.
 * It never changes Claude Code's routing; whether to keep using the hub's proxy is the user's call.
 */
export function ChromeConnectorCard({ reloadCount }: { reloadCount: number }) {
  const { locale } = useI18n();
  const ct = (key: ConnectorTextKey) => connectorText(key, locale);
  const [state, setState] = useState<ChromeIntegration | null>(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(readOpen);
  const [launch, setLaunch] = useState<'idle' | 'busy' | 'done' | string>('idle');

  const load = useCallback(() => {
    chromeApi.status().then(next => { setState(next); setError(''); }).catch(loadError => setError(readableError(loadError)));
  }, []);
  useEffect(() => { load(); }, [load, reloadCount]);
  useEffect(() => {
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);

  const progress = state ? chromeProgress(state) : null;
  const open = expanded || Boolean(error);
  const toggle = () => { const next = !open; setExpanded(next); saveOpen(next); };
  const openClaudeCode = async () => {
    setLaunch('busy');
    try { await chromeApi.openClaudeCode(); setLaunch('done'); }
    catch (launchError) { setLaunch(readableError(launchError)); }
  };
  const getExtension = () => { if (state) void invoke('open_external_url', { url: state.storeUrl }).catch(() => undefined); };
  const present = state?.browsers.filter(browser => browser.installed) ?? [];
  const chip = !progress ? null
    : progress.ready ? <span className="connector-row-state on">{ct('chromeReady')}</span>
      : !progress.extension ? <span className="connector-row-state">{ct('chromeNoExtension')}</span>
        : !progress.signIn ? <span className="connector-row-state warn">{ct('chromeBlocked')}</span>
          : <span className="connector-row-state warn">{ct('chromeNotLinked')}</span>;

  const step = (done: boolean, number: number, title: string, body: ReactNode) => (
    <li className={done ? 'done' : undefined}>
      <span className="connector-step-number" aria-hidden="true">{done ? <Check size={12} /> : number}</span>
      <div>
        <strong>{title}</strong>
        {body}
      </div>
    </li>
  );

  return (
    <section className={`connector-card chrome-connector-card${open ? ' is-open' : ''}`} aria-labelledby="connector-chrome-title">
      <header className="connector-card-header">
        <button type="button" className="connector-row-toggle" aria-expanded={open} aria-controls="connector-chrome-body" onClick={toggle}>
          <span className="connector-icon" aria-hidden="true"><Globe size={18} /></span>
          <h2 id="connector-chrome-title">{ct('chrome_name')}</h2>
          <span className="connector-row-states">{chip}</span>
          <ChevronDown size={16} aria-hidden="true" className="connector-row-chevron" />
        </button>
        {open ? null : <p className="connector-card-teaser">{ct('chrome_body')}</p>}
      </header>
      <div id="connector-chrome-body" className="connector-card-body" hidden={!open}>
        <p className="connector-card-description">{ct('chrome_body')}</p>
        {error ? <p className="connector-unavailable" role="alert">{error}</p> : null}
        {state && progress ? (
          <section className="connector-steps" aria-labelledby="connector-chrome-steps">
            <h3 id="connector-chrome-steps">{ct('chromeStepsTitle')}</h3>
            <ol>
              {step(progress.extension, 1, ct('chromeStepExtension'), <>
                {progress.noBrowser ? <small>{ct('chromeNoBrowser')}</small> : (
                  <ul className="chrome-browsers">
                    {present.map(browser => (
                      <li key={browser.id} data-browser={browser.id}>
                        {browser.name}: {browser.extensionVersion
                          ? `${browser.extensionVersion}${browser.extensionTooOld ? ` · ${ct('chromeTooOld')}` : ''}`
                          : ct('chromeNotInstalled')}
                      </li>
                    ))}
                  </ul>
                )}
                {progress.extension ? null : (
                  <span className="connector-auto-setup-actions">
                    <button type="button" className="secondary-button compact-button" onClick={getExtension}>
                      <ExternalLink size={14} aria-hidden="true" />{ct('chromeGetExtension')}
                    </button>
                  </span>
                )}
              </>)}
              {step(progress.signIn, 2, ct('chromeStepSignIn'), progress.signIn
                ? <small>{ct('chromeSignInOk')}</small>
                : <p className="connector-test warn chrome-blocked" role="note">{ct(state.routedThroughLocalProxy ? 'chromeBlockedByHub' : 'chromeBlockedByToken')}</p>)}
              {step(progress.link, 3, ct('chromeStepLink'), <>
                {present.length ? (
                  <ul className="chrome-links">
                    {present.filter(browser => browser.extensionVersion).map(browser => (
                      <li key={browser.id} data-browser={browser.id}>{browser.name}: {browser.linked ? ct('chromeLinked') : ct('chromeNotLinkedYet')}</li>
                    ))}
                  </ul>
                ) : null}
                <small>{progress.link ? ct('chromeLinkDoneHint') : ct('chromeLinkHint')}</small>
                {progress.extension && progress.signIn ? (
                  <span className="connector-auto-setup-actions">
                    <button type="button" className="secondary-button compact-button" disabled={launch === 'busy'} onClick={() => void openClaudeCode()}>
                      <Terminal size={14} aria-hidden="true" />{ct('chromeOpenClaudeCode')}
                    </button>
                    {launch === 'done' ? <small role="status">{ct('chromeOpened')}</small> : launch !== 'idle' && launch !== 'busy' ? <small role="alert">{launch}</small> : null}
                  </span>
                ) : null}
              </>)}
            </ol>
          </section>
        ) : null}
      </div>
    </section>
  );
}
