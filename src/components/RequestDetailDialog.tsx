import { X } from 'lucide-react';
import { getCurrentLocale, useI18n } from '../i18n';
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

/** Everything the hub recorded about one request, opened from a row in Activity → Requests. */
export function RequestDetailDialog({ record, onClose }: { record: UsageRecord | null; onClose: () => void }) {
  const { t } = useI18n();
  const dialogRef = useDialogFocusTrap<HTMLDivElement>({ active: Boolean(record), onEscape: onClose });
  if (!record) return null;
  const state = record.canceled ? 'canceled' : record.failed ? 'failed' : 'success';
  const rows: Array<[string, string]> = [
    [t('reqdetail.time'), new Date(record.timestamp).toLocaleString(getCurrentLocale())],
    [t('reqdetail.result'), record.failed && record.failure_status ? `${t(`usage.result.${state}`)} · HTTP ${record.failure_status}` : t(`usage.result.${state}`)],
    [t('reqdetail.account'), record.source_display || record.source || '—'],
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
  return (
    <div className="command-palette-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="glossary-dialog request-detail" role="dialog" aria-modal="true" aria-labelledby="request-detail-title">
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
      </div>
    </div>
  );
}
