import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useI18n } from '../i18n';
import { resetCountdown } from '../services/accountDashboard';
import type { MiniProvider } from '../services/miniSummary';
import { ProviderLogo } from './AuthFileProviderIcon';
import './MiniHub.css';

type HubSummary = { menuText: string; tooltipText: string; level: string | null; providers?: MiniProvider[] | null };

/** True in the small always-on-top window, which shows only the hub's one-line status. */
export const isMiniWindow = () => Boolean((window as { __HUB_MINI__?: boolean }).__HUB_MINI__)
  || new URLSearchParams(window.location.search).get('mini') === '1';

/**
 * The mini window: one row per provider with its logo, a bar split into one segment per account (each filled to the
 * quota it has left) and the best quota left, or when it's back. Updated as the main window's watcher sends it.
 */
export function MiniHub() {
  const { t } = useI18n();
  const [summary, setSummary] = useState<HubSummary | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    void invoke<HubSummary | null>('get_hub_summary').then(value => { if (!disposed && value) setSummary(value); }).catch(() => undefined);
    void listen<HubSummary>('hub-summary', event => { if (!disposed) setSummary(event.payload); }).then(unlisten => {
      if (disposed) unlisten(); else stop = unlisten;
    });
    // Keeps "back in 3h" counting down between the watcher's checks.
    const tick = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => { disposed = true; stop?.(); window.clearInterval(tick); };
  }, []);
  const level = summary?.level === 'low' || summary?.level === 'out' ? summary.level : summary ? 'ok' : 'unknown';
  const providers = summary?.providers ?? null;
  const allOut = providers?.find(provider => provider.accounts.length > 0 && provider.accounts.every(account => account.state === 'out'));
  const heading = !summary ? t('nd.mini.waiting')
    : level === 'out' && allOut ? t('nd.mini.head.outNamed', { provider: allOut.name })
      : t(`nd.mini.head.${level === 'unknown' ? 'ok' : level}`);
  // Older summaries without per-provider data: the tray's text, one provider per line.
  const lines = providers ? [] : summary?.tooltipText.split(' · ').map(line => line.trim()).filter(Boolean) ?? [];
  return <main className={`mini-hub level-${level}`} aria-label={t('nd.mini.title')}>
    <header>
      <span className="mini-hub-dot" aria-hidden="true" />
      <strong>{heading}</strong>
    </header>
    {providers && providers.length > 0 && <ul className="mini-hub-providers">
      {providers.slice(0, 6).map(provider => <MiniProviderRow key={provider.provider} provider={provider} now={now} />)}
    </ul>}
    {lines.length > 0 && <ul className="mini-hub-lines">{lines.slice(0, 6).map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ul>}
    <button type="button" className="mini-hub-open" onClick={() => void invoke('show_main_from_mini').catch(() => undefined)}>
      {t('nd.mini.open')} <span aria-hidden="true">→</span>
    </button>
  </main>;
}

function MiniProviderRow({ provider, now }: { provider: MiniProvider; now: number }) {
  const { t } = useI18n();
  const total = provider.accounts.length;
  const usable = provider.accounts.filter(account => account.state !== 'out').length;
  const state = usable === 0 ? 'out' : provider.accounts.some(account => account.state !== 'ok') ? 'low' : 'ok';
  const value = usable === 0
    ? (provider.resetAt !== undefined ? t('nd.mini.outBack', { time: resetCountdown(provider.resetAt, now) }) : t('nd.mini.out'))
    : provider.percent !== null ? `${Math.round(provider.percent)}%` : t('nd.mini.ready');
  const label = t('nd.mini.barLabel', { provider: provider.name, usable, total });
  return <li className={`mini-hub-row state-${state}`}>
    <ProviderLogo provider={provider.provider} className="mini-hub-logo" />
    <span className="mini-hub-name">{provider.name}</span>
    <span className="mini-hub-value">{value}</span>
    <span className="mini-hub-bar" role="img" aria-label={label} title={label}>
      {provider.accounts.map((account, index) => <span key={index} className={`mini-hub-seg seg-${account.state}`}>
        <span style={{ width: `${account.state === 'out' ? 0 : Math.max(4, Math.min(100, account.percent ?? 100))}%` }} />
      </span>)}
    </span>
  </li>;
}
