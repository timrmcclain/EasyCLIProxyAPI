import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, Check, ChevronDown, ExternalLink, Terminal } from 'lucide-react';
import { ChromeMark } from '../components/BrandMarks';
import { useI18n } from '../i18n';
import { connectorText, type ConnectorTextKey } from '../i18n/connectors';
import { readableError } from '../services/readableError';
import { chromeApi, chromeProgress, type ChromeIntegration } from '../services/chromeIntegration';

const EXPANDED_KEY = 'personal.connectorsExpanded';
const CARD_ID = 'chrome';
const DOCS_URL = 'https://code.claude.com/docs/en/chrome';
const SHORT_NAMES = { chrome: 'Chrome', edge: 'Edge' } as const;

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
const openUrl = (url: string) => { void invoke('open_external_url', { url }).catch(() => undefined); };

type LinkState = 'done' | 'broken' | 'waiting';

/**
 * Claude in Chrome isn't an MCP server the hub switches on. Claude Code reaches the browser through a chain of three
 * links (extension, an account sign-in, the browser link), so the card draws that chain, marks the first break, and
 * offers the one step that mends it. It never changes Claude Code's routing; that stays the user's call.
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
  // Back from installing the extension or signing in elsewhere: show the new state without a refresh.
  useEffect(() => {
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);

  const progress = state ? chromeProgress(state) : null;
  const open = expanded || Boolean(error);
  const toggle = () => { const next = !open; setExpanded(next); saveOpen(next); };
  // With a token, the button starts a Chrome session: Claude Code in its own config folder, signed in once with /login.
  const usesSession = Boolean(state?.tokenAuth);
  const openClaudeCode = async () => {
    setLaunch('busy');
    try { await chromeApi.openClaudeCode(); setLaunch(usesSession && !state?.sessionSignedIn ? 'login' : 'done'); }
    catch (launchError) { setLaunch(readableError(launchError)); }
  };

  const present = state?.browsers.filter(browser => browser.installed) ?? [];
  const withExtension = present.filter(browser => browser.extensionVersion);
  const broken = !progress ? null : !progress.extension ? 'extension' : !progress.signIn ? 'signIn' : !progress.link ? 'link' : null;
  const linkState = (done: boolean, waiting = false): LinkState => done ? 'done' : waiting ? 'waiting' : 'broken';

  const chip = !progress ? null
    : progress.ready ? <span className="connector-row-state on">{ct('chromeReady')}</span>
      : <span className={`connector-row-state${broken === 'extension' ? '' : ' warn'}`}>{ct(broken === 'extension' ? 'chromeChipExtension' : broken === 'signIn' ? 'chromeChipSignIn' : 'chromeChipLink')}</span>;

  const launchButton = (
    <>
      <button type="button" className="primary-button compact-button" disabled={launch === 'busy'} onClick={() => void openClaudeCode()}>
        <Terminal size={14} aria-hidden="true" />{ct(usesSession ? 'chromeStartSession' : 'chromeOpenClaudeCode')}
      </button>
      {launch === 'done' ? <small role="status">{ct('chromeOpened')}</small>
        : launch === 'login' ? <small role="status">{ct('chromeOpenedLogin')}</small>
          : launch !== 'idle' && launch !== 'busy' ? <small role="alert">{launch}</small> : null}
    </>
  );
  const whyLink = (
    <button type="button" className="secondary-button compact-button" onClick={() => openUrl(DOCS_URL)}>
      <ExternalLink size={14} aria-hidden="true" />{ct('chromeWhy')}
    </button>
  );

  let next: { tone: 'warn' | 'ready'; title: string; body: string; actions: ReactNode } | null = null;
  if (state && progress) {
    if (broken === 'extension') {
      next = { tone: 'warn', title: ct('chromeNextExtensionTitle'), body: ct(progress.noBrowser ? 'chromeNoBrowser' : 'chromeNextExtensionBody'),
        actions: progress.noBrowser ? null : (
          <button type="button" className="primary-button compact-button" onClick={() => openUrl(state.storeUrl)}>
            <ExternalLink size={14} aria-hidden="true" />{ct('chromeGetExtension')}
          </button>
        ) };
    } else if (broken === 'signIn') {
      next = { tone: 'warn', title: ct(state.routedThroughLocalProxy ? 'chromeNextHubTitle' : 'chromeNextTokenTitle'),
        body: `${ct(state.routedThroughLocalProxy ? 'chromeNextHubBody' : 'chromeNextTokenBody')} ${ct('chromeSessionBody').replace('{dir}', state.sessionDir)}`,
        actions: <>{launchButton}{whyLink}</> };
    } else if (broken === 'link') {
      next = { tone: 'warn', title: ct('chromeNextLinkTitle'), body: ct('chromeNextLinkBody'), actions: launchButton };
    } else {
      next = { tone: 'ready', title: ct('chromeNextReadyTitle'), body: ct('chromeNextReadyBody'), actions: launchButton };
    }
  }

  const extensionDetail = withExtension.length
    ? withExtension.map(browser => `${SHORT_NAMES[browser.id]} ${browser.extensionVersion}${browser.extensionTooOld ? ` (${ct('chromeTooOld')})` : ''}`).join(' · ')
    : ct('chromeNotInstalled');
  const linked = withExtension.filter(browser => browser.linked).map(browser => SHORT_NAMES[browser.id]);
  const chain: { key: string; label: string; detail: string; state: LinkState }[] = state && progress ? [
    { key: 'extension', label: ct('chromeLinkExtension'), detail: extensionDetail, state: linkState(progress.extension) },
    { key: 'signIn', label: ct('chromeLinkSignIn'), detail: progress.signIn ? ct(state.tokenAuth ? 'chromeSignInSession' : 'chromeSignInAccount') : ct(state.routedThroughLocalProxy ? 'chromeSignInHub' : 'chromeSignInToken'), state: linkState(progress.signIn) },
    { key: 'link', label: ct('chromeLinkBrowser'), detail: linked.length ? linked.join(' · ') : progress.extension && progress.signIn ? ct('chromeNotLinked') : ct('chromeWaiting'),
      state: linkState(progress.link, !(progress.extension && progress.signIn)) },
  ] : [];

  return (
    <section className={`connector-card chrome-connector-card${open ? ' is-open' : ''}`} aria-labelledby="connector-chrome-title">
      <header className="connector-card-header">
        <button type="button" className="connector-row-toggle" aria-expanded={open} aria-controls="connector-chrome-body" onClick={toggle}>
          <span className="connector-icon" aria-hidden="true"><ChromeMark size={18} /></span>
          <h2 id="connector-chrome-title">{ct('chrome_name')}</h2>
          <span className="connector-row-states">{chip}</span>
          <ChevronDown size={16} aria-hidden="true" className="connector-row-chevron" />
        </button>
        {open ? null : <p className="connector-card-teaser">{ct('chrome_body')}</p>}
      </header>
      <div id="connector-chrome-body" className="connector-card-body chrome-body" hidden={!open}>
        <p className="connector-card-description">{ct('chrome_body')}</p>
        {error ? <p className="connector-unavailable" role="alert">{error}</p> : null}
        {chain.length ? (
          <ol className="chrome-chain" aria-label={ct('chromeChainLabel')}>
            {chain.map(link => (
              <li key={link.key} className={`chrome-link is-${link.state}`} data-link={link.key}>
                <span className="chrome-link-mark" aria-hidden="true">
                  {link.state === 'done' ? <Check size={12} /> : link.state === 'broken' ? <AlertTriangle size={12} /> : null}
                </span>
                <span className="chrome-link-text">
                  <strong>{link.label}</strong>
                  <small>{link.detail}</small>
                </span>
                <span className="sr-only">{ct(link.state === 'done' ? 'chromeStateDone' : link.state === 'broken' ? 'chromeStateBroken' : 'chromeStateWaiting')}</span>
              </li>
            ))}
          </ol>
        ) : null}
        {next ? (
          <div className={`chrome-next is-${next.tone}`}>
            <strong>{next.title}</strong>
            <p>{next.body}</p>
            {next.actions ? <div className="chrome-next-actions">{next.actions}</div> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
