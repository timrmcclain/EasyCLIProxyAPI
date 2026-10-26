import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useI18n } from '../i18n';
import './MiniHub.css';

type HubSummary = { menuText: string; tooltipText: string; level: string | null };

/** True in the small always-on-top window, which shows only the hub's one-line status. */
export const isMiniWindow = () => Boolean((window as { __HUB_MINI__?: boolean }).__HUB_MINI__)
  || new URLSearchParams(window.location.search).get('mini') === '1';

/**
 * The mini window: the same status the tray shows (quota per provider and the proxy's state), updated as the
 * main window's watcher sends it, with a button back to the full hub.
 */
export function MiniHub() {
  const { t } = useI18n();
  const [summary, setSummary] = useState<HubSummary | null>(null);
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    void invoke<HubSummary | null>('get_hub_summary').then(value => { if (!disposed && value) setSummary(value); }).catch(() => undefined);
    void listen<HubSummary>('hub-summary', event => { if (!disposed) setSummary(event.payload); }).then(unlisten => {
      if (disposed) unlisten(); else stop = unlisten;
    });
    return () => { disposed = true; stop?.(); };
  }, []);
  const level = summary?.level ?? 'unknown';
  // The tray tooltip lists providers as "Codex all out · Claude 1 low · Grok ok"; one per line here.
  const lines = summary?.tooltipText.split(' · ').map(line => line.trim()).filter(Boolean) ?? [];
  return <main className={`mini-hub level-${level}`} aria-label={t('nd.mini.title')}>
    <header>
      <span className="mini-hub-dot" aria-hidden="true" />
      <strong>{summary ? t(`nd.mini.level.${level === 'low' || level === 'out' ? level : 'ok'}`) : t('nd.mini.waiting')}</strong>
    </header>
    {lines.length > 0 && <ul>{lines.slice(0, 6).map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ul>}
    <button type="button" className="secondary-button compact-button" onClick={() => void invoke('show_main_from_mini').catch(() => undefined)}>{t('nd.mini.open')}</button>
  </main>;
}
