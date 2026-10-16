import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ClipboardCopy, FolderOpen, Pause, Play, ScrollText } from 'lucide-react';
import { useI18n } from '../i18n';
import { readDashboardPreference } from '../services/dashboardPreferences';
import { maskEmail } from '../services/accountLabelBySource';
import { readableError } from '../services/readableError';
import './ProxyLogSection.css';

type CoreLogTail = { lines: string[]; path: string; truncated: boolean; exists: boolean };
type Level = 'all' | 'warn' | 'error';

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** The proxy writes "[2026-10-16 07:52:52] [id] [warn ] ..."; lines without a level count as info. */
export function logLevel(line: string): 'error' | 'warn' | 'info' {
  const match = /\[(error|fatal|panic|warn(?:ing)?)\s*\]/i.exec(line);
  if (!match) return 'info';
  return match[1].toLowerCase().startsWith('warn') ? 'warn' : 'error';
}

/** Settings → Diagnostics: the end of the proxy's own log, refreshed every few seconds unless paused. */
export function ProxyLogSection({ hidden }: { hidden: boolean }) {
  const { t } = useI18n();
  const [tail, setTail] = useState<CoreLogTail | null>(null);
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const [level, setLevel] = useState<Level>('all');
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const hideEmails = readDashboardPreference('hideEmails', ['true', 'false'], 'false') === 'true';

  const load = useCallback(async () => {
    try {
      setTail(await invoke<CoreLogTail>('read_core_log', { limit: 1000 }));
      setError('');
    } catch (reason) {
      setError(readableError(reason));
    }
  }, []);
  useEffect(() => {
    if (hidden || paused) return;
    void load();
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [hidden, paused, load]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (tail?.lines ?? [])
      .map(line => hideEmails ? line.replace(EMAIL, maskEmail) : line)
      .filter(line => level === 'all' || (level === 'error' ? logLevel(line) === 'error' : logLevel(line) !== 'info'))
      .filter(line => !needle || line.toLowerCase().includes(needle));
  }, [tail, level, query, hideEmails]);

  // Follow new lines while scrolled to the bottom; stay put if you've scrolled up to read.
  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shown.join('\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard refused; nothing to report */ }
  };

  return (
    <section hidden={hidden} className="panel proxy-log-panel" aria-labelledby="proxy-log-title">
      <div className="config-panel-heading">
        <div className="config-heading-title">
          <ScrollText size={18} aria-hidden="true" />
          <h2 id="proxy-log-title">{t('proxyLog.title')}</h2>
        </div>
      </div>
      <p className="proxy-log-intro">{t('proxyLog.intro')}</p>
      <div className="proxy-log-toolbar">
        <input type="search" aria-label={t('proxyLog.search')} placeholder={t('proxyLog.search')} value={query} onChange={event => setQuery(event.target.value)} />
        <select aria-label={t('proxyLog.level')} value={level} onChange={event => setLevel(event.target.value as Level)}>
          <option value="all">{t('proxyLog.level.all')}</option>
          <option value="warn">{t('proxyLog.level.warn')}</option>
          <option value="error">{t('proxyLog.level.error')}</option>
        </select>
        <button type="button" className="secondary-button compact-button" aria-pressed={paused} onClick={() => setPaused(value => !value)}>
          {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}{t(paused ? 'proxyLog.resume' : 'proxyLog.pause')}
        </button>
        <button type="button" className="secondary-button compact-button" disabled={!shown.length} onClick={() => void copy()}>
          <ClipboardCopy size={14} aria-hidden="true" />{t(copied ? 'proxyLog.copied' : 'proxyLog.copy')}
        </button>
        <button type="button" className="secondary-button compact-button" onClick={() => void invoke('open_core_logs_directory').catch(() => undefined)}>
          <FolderOpen size={14} aria-hidden="true" />{t('proxyLog.openFolder')}
        </button>
      </div>
      {error ? <p className="proxy-log-message" role="alert">{t('proxyLog.error', { error })}</p>
        : tail && !tail.exists ? <p className="proxy-log-message">{t('proxyLog.missing')}</p>
        : <>
          <pre ref={box} className="proxy-log-lines" tabIndex={0} aria-label={t('proxyLog.title')} aria-busy={!tail}
            onScroll={event => { const el = event.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
            {tail ? shown.length ? shown.map((line, index) => <span key={index} className={`proxy-log-line proxy-log-${logLevel(line)}`}>{line}{'\n'}</span>)
              : <span className="proxy-log-empty">{t('proxyLog.noMatches')}</span> : t('common.loading')}
          </pre>
          {tail?.truncated && <p className="proxy-log-note">{t('proxyLog.truncated', { count: tail.lines.length })}</p>}
        </>}
    </section>
  );
}
