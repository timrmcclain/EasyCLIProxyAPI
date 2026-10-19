import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight, Copy, UserRound, X } from 'lucide-react';
import { getCurrentLocale, useI18n } from '../i18n';
import { requestAccountSearch } from '../accountNavigation';
import { useAccountLabelBySource } from '../services/accountLabelBySource';
import type { UsageRecord } from '../pages/UsageEventsView';
import { useDialogFocusTrap } from './useDialogFocusTrap';
import './RequestDetailDialog.css';

const seconds = (ms: number | null | undefined) => (typeof ms === 'number' && ms > 0 ? `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s` : '—');
/** Same order as the backend's client classification. */
const appName = (agent: string) => {
  const value = agent.toLowerCase();
  if (value.includes('claude-desktop')) return 'Claude Desktop';
  if (value.includes('claude-cli')) return 'Claude Code';
  if (value.includes('codex')) return 'Codex';
  return agent;
};
const count = (value: number) => (value ? value.toLocaleString() : '0');

/** Everything the hub recorded about one request, opened from a row in Activity → Requests. Previous and Next
 * (or the arrow keys) step through the rows as listed. */
export function RequestDetailDialog({ record, onClose, onPrevious, onNext, position }: {
  record: UsageRecord | null; onClose: () => void;
  onPrevious?: (() => void) | null; onNext?: (() => void) | null; position?: { index: number; total: number };
}) {
  const { t } = useI18n();
  const dialogRef = useDialogFocusTrap<HTMLDivElement>({ active: Boolean(record), onEscape: onClose });
  const accountLabel = useAccountLabelBySource();
  const [copied, setCopied] = useState(false);
  useEffect(() => { setCopied(false); }, [record]);
  if (!record) return null;
  const state = record.canceled ? 'canceled' : record.failed ? 'failed' : 'success';
  const rows: Array<[string, string]> = [
    [t('reqdetail.time'), new Date(record.timestamp).toLocaleString(getCurrentLocale())],
    [t('reqdetail.result'), record.failed && record.failure_status ? `${t(`usage.result.${state}`)} · HTTP ${record.failure_status}` : t(`usage.result.${state}`)],
    [t('reqdetail.account'), accountLabel(record.source_display || record.source) || '—'],
    [t('reqdetail.provider'), record.provider || '—'],
    [t('reqdetail.model'), record.model || '—'],
    ...(record.alias ? [[t('reqdetail.alias'), record.alias] as [string, string]] : []),
    ...(record.response_model && record.response_model !== record.model ? [[t('reqdetail.answeredBy'), record.response_model] as [string, string]] : []),
    ...(record.reasoning_effort ? [[t('reqdetail.effort'), record.reasoning_effort] as [string, string]] : []),
    ...(record.user_agent ? [[t('reqdetail.client'), appName(record.user_agent)] as [string, string]] : []),
    [t('reqdetail.endpoint'), record.endpoint || '—'],
    [t('reqdetail.total'), seconds(record.latency_ms)],
    [t('reqdetail.firstToken'), seconds(record.ttft_ms)],
    [t('reqdetail.tokensIn'), count(record.tokens.input_tokens)],
    [t('reqdetail.tokensOut'), count(record.tokens.output_tokens)],
    ...(record.tokens.reasoning_tokens ? [[t('reqdetail.tokensReasoning'), count(record.tokens.reasoning_tokens)] as [string, string]] : []),
    [t('reqdetail.cacheRead'), count(record.tokens.cache_read_tokens)],
    [t('reqdetail.cacheWrite'), count(record.tokens.cache_creation_tokens)],
    ...(record.cost ? [[t('reqdetail.cost'), `$${record.cost.total.toFixed(4)}`] as [string, string]] : []),
    [t('reqdetail.key'), [record.api_key_display, record.api_key_remark].filter(Boolean).join(' · ') || '—'],
    ...(record.request_id ? [[t('reqdetail.requestId'), record.request_id] as [string, string]] : []),
  ];
  const copy = async () => {
    const text = [...rows.map(([label, value]) => `${label}: ${value}`), ...(record.failure_body.trim() ? ['', record.failure_body.trim()] : [])].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const openAccount = () => {
    onClose();
    requestAccountSearch(record.source);
  };
  // Arrow keys step through requests, except while selecting text in the error body.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement).closest('pre')) return;
    if (event.key === 'ArrowLeft' && onPrevious) { event.preventDefault(); onPrevious(); }
    if (event.key === 'ArrowRight' && onNext) { event.preventDefault(); onNext(); }
  };
  return (
    <div className="command-palette-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="glossary-dialog request-detail" role="dialog" aria-modal="true" aria-labelledby="request-detail-title" onKeyDown={onKeyDown}>
        <header>
          <h2 id="request-detail-title">{t('reqdetail.title')}</h2>
          <button type="button" className="icon-button quiet" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <dl className="request-detail-grid">
          {rows.map(([label, value]) => (
            <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
          ))}
        </dl>
        {record.failure_body.trim() && <section className="request-detail-error">
          <h3>{t('reqdetail.errorBody')}</h3>
          <pre>{record.failure_body}</pre>
        </section>}
        <footer className="request-detail-actions">
          <div className="request-detail-step">
            <button type="button" className="secondary-button compact-button" disabled={!onPrevious} onClick={() => onPrevious?.()} aria-label={t('reqdetail.previous')} title={t('reqdetail.previous')}>
              <ChevronLeft size={15} aria-hidden="true" />
            </button>
            {position ? <span aria-live="polite">{t('reqdetail.position', { index: position.index + 1, total: position.total })}</span> : null}
            <button type="button" className="secondary-button compact-button" disabled={!onNext} onClick={() => onNext?.()} aria-label={t('reqdetail.next')} title={t('reqdetail.next')}>
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </div>
          <div className="request-detail-step">
            <button type="button" className="secondary-button compact-button" onClick={() => void copy()}>
              <Copy size={14} aria-hidden="true" />{copied ? t('reqdetail.copied') : t('reqdetail.copy')}
            </button>
            {record.source ? <button type="button" className="secondary-button compact-button" onClick={openAccount}>
              <UserRound size={14} aria-hidden="true" />{t('reqdetail.openAccount')}
            </button> : null}
          </div>
        </footer>
      </div>
    </div>
  );
}
