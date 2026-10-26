import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import './ActivityFeed.css';
import { getCurrentLocale, useI18n } from '../i18n';
import { accountColor, readAccountColors } from '../services/accountIdentity';
import { useAccountLabelBySource } from '../services/accountLabelBySource';
import {
  anomalies, cacheSavings, costColumns, groupConversations, matchesSearch, recoveries, usageHeatmap, whyThisAccount,
  type Conversation, type CostBucket, type CostDimension, type PriceRow, type Recovery,
} from '../services/activityFeed';
import { dedupeAuthFiles } from '../services/authFiles';
import { classifyFailure, failureMessage } from '../services/errorCauses';
import { managementApi, responseList } from '../services/managementApi';
import { useQuotaCache } from '../services/quotaCache';
import { quotaKey, type AuthFile } from '../services/quotaService';
import { readableError } from '../services/readableError';
import { readRoutingState, routingPlans } from '../services/routingOrder';
import { formatDuration, formatUsageNumber } from '../services/usageNumber';
import type { UsageRecord } from './UsageEventsView';

/** How many recent requests the feed reads; enough for a few days of normal use without slowing the page. */
const SAMPLE = 1000;
const PAGE = 30;
const HEAT_DAYS = 28;
const PART_COLORS = ['#2f6fdb', '#c2571a', '#1f8a5b', '#8a4fc7', '#b8892a', '#c23a5e', '#2a8a96', '#6b7280'];

type Query = Record<string, string | boolean | number | undefined>;
type Loaded = { records: UsageRecord[]; total: number; prices: PriceRow[]; heat: { hour: string; requests: number }[]; files: AuthFile[] };

const money = (value: number) => new Intl.NumberFormat(getCurrentLocale(), { style: 'currency', currency: 'USD', maximumFractionDigits: value < 1 ? 3 : 2 }).format(value);
const clock = (time: number) => new Date(time).toLocaleString(getCurrentLocale(), { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** Activity → Conversations: requests grouped the way you remember them, with the story of each. */
export function ActivityFeed({ query }: { query: Query }) {
  const { t } = useI18n();
  const labelOf = useAccountLabelBySource();
  const quotas = useQuotaCache();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [dimension, setDimension] = useState<CostDimension>('app');
  const [bucket, setBucket] = useState<CostBucket>('day');
  const [shown, setShown] = useState(PAGE);
  // The page rebuilds its time range from the clock on every render; to the minute is enough to know it changed.
  const queryKey = JSON.stringify(query, (key, value) => (key === 'start' || key === 'end') && typeof value === 'string'
    ? new Date(Math.floor(Date.parse(value) / 60_000) * 60_000).toISOString() : value);

  const load = useCallback(async () => {
    setError('');
    const scope = JSON.parse(queryKey) as Query;
    const { failed: _failed, canceled: _canceled, ...withoutResult } = scope;
    const now = Date.now();
    try {
      const [events, pricing, heat, credentials] = await Promise.all([
        invoke<{ items: UsageRecord[]; total: number }>('get_usage_events', { query: { ...scope, page: 1, page_size: SAMPLE } }),
        invoke<{ rows: PriceRow[] }>('get_usage_pricing', { query: scope }).catch(() => ({ rows: [] })),
        invoke<{ timeline?: { hour: string; requests: number }[] }>('get_usage_overview', {
          query: { ...withoutResult, start: new Date(now - HEAT_DAYS * 86_400_000).toISOString(), end: new Date(now).toISOString() },
        }).catch(() => ({ timeline: [] })),
        managementApi.get('/credentials').then(payload => dedupeAuthFiles(responseList(payload, 'files'))).catch(() => [] as AuthFile[]),
      ]);
      setData({ records: events.items ?? [], total: events.total ?? 0, prices: pricing.rows ?? [], heat: heat.timeline ?? [], files: credentials });
    } catch (cause) { setError(readableError(cause)); }
  }, [queryKey]);
  useEffect(() => { setData(null); setShown(PAGE); void load(); }, [load]);

  const records = useMemo(() => data?.records ?? [], [data]);
  const plans = useMemo(() => data ? routingPlans(data.files, quotas, Date.now(), readRoutingState()) : [], [data, quotas]);
  const matching = useMemo(() => records.filter(record => matchesSearch(record, search, labelOf)), [records, search, labelOf]);
  const conversations = useMemo(() => groupConversations(matching), [matching]);
  const recovered = useMemo(() => new Map(recoveries(records).map(item => [item.failed.id, item])), [records]);
  const unusual = useMemo(() => anomalies(records).slice(0, 3), [records]);
  const failedCount = records.filter(record => record.failed).length;
  const spent = records.reduce((sum, record) => sum + (record.cost?.total ?? 0), 0);
  const saved = data ? cacheSavings(data.prices) : 0;
  const colors = readAccountColors();
  const colorForSource = (source: string) => {
    const file = data?.files.find(item => String(item.email ?? '').toLowerCase() === source.toLowerCase());
    return file ? accountColor(quotaKey(file), colors) : 'var(--text-tertiary)';
  };
  const appName = (client: string) => client === 'other' ? t('af.app.other') : client;

  if (error) return <div className="af-state" role="alert"><p>{t('af.error', { error })}</p><button type="button" className="secondary-button" onClick={() => void load()}>{t('af.retry')}</button></div>;
  if (!data) return <div className="af-state af-skeleton" role="status" aria-busy="true"><span className="sr-only">{t('af.loading')}</span><i /><i /><i /></div>;

  return <div className="activity-feed">
    <section className="af-summary" aria-label={t('af.conversations')}>
      <div><span>{t('af.spent')}</span><strong>{money(spent)}</strong></div>
      <div title={t('af.savedHint')}><span>{t('af.saved')}</span><strong className="af-good">{money(saved)}</strong></div>
      <div><span>{t('af.conversations')}</span><strong>{formatUsageNumber(groupConversations(records).length, getCurrentLocale())}</strong></div>
      <div><span>{t('af.recovered')}</span><strong>{t('af.recoveredValue', { recovered: recovered.size, failed: failedCount })}</strong></div>
      <p className="af-note">{t('af.sample', { count: Math.min(records.length, SAMPLE) })}</p>
    </section>
    {unusual.length > 0 && <section className="af-unusual" aria-label={t('af.unusual')}>
      <strong>{t('af.unusual')}</strong>
      <ul>{unusual.map(item => <li key={`${item.client}-${item.at}`}>{t('af.anomaly', { app: appName(item.client), multiple: item.multiple, time: clock(item.at) })}</li>)}</ul>
    </section>}
    <div className="af-charts">
      <CostChart records={records} dimension={dimension} bucket={bucket} onDimension={setDimension} onBucket={setBucket} labelOf={labelOf} appName={appName} />
      <Heatmap timeline={data.heat} />
    </div>
    <section className="af-feed" aria-label={t('af.conversations')}>
      <div className="af-feed-tools">
        <input type="search" value={search} onChange={event => { setSearch(event.target.value); setShown(PAGE); }} placeholder={t('af.search')} aria-label={t('af.search')} />
        <span role="status">{t('af.results', { shown: Math.min(shown, conversations.length), total: conversations.length })}</span>
      </div>
      {!conversations.length ? <p className="af-note">{t('af.none')}</p> : <ol className="af-list">
        {conversations.slice(0, shown).map(conversation => <ConversationCard key={conversation.id} conversation={conversation} recovered={recovered}
          account={labelOf(conversation.source) || '—'} color={colorForSource(conversation.source)} app={appName(conversation.client)}
          why={whyThisAccount(conversation.source, plans)} provider={conversation.provider} labelOf={labelOf} />)}
      </ol>}
      {conversations.length > shown && <button type="button" className="secondary-button af-more" onClick={() => setShown(value => value + PAGE)}>
        {t('af.more', { count: Math.min(PAGE, conversations.length - shown) })}</button>}
    </section>
  </div>;
}

function ConversationCard({ conversation, recovered, account, color, app, why, provider, labelOf }: {
  conversation: Conversation; recovered: Map<string, Recovery>; account: string; color: string; app: string;
  why: ReturnType<typeof whyThisAccount>; provider: string; labelOf: (source: string) => string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const locale = getCurrentLocale();
  const failures = conversation.items.filter(item => item.failed);
  const providerName = provider ? provider[0].toUpperCase() + provider.slice(1) : '';
  const duration = conversation.end - conversation.start;
  return <li className={`af-card${conversation.failures ? ' has-failures' : ''}`}>
    <header>
      <span className="af-app">{app}</span>
      <span className="af-account"><span className="sb-swatch" style={{ background: color }} aria-hidden="true" />{account}</span>
      <code className="af-model">{conversation.model}</code>
      <time dateTime={new Date(conversation.end).toISOString()}>{clock(conversation.end)}</time>
    </header>
    <p className="af-meta">
      <span>{t('af.card.requests', { count: conversation.requests })}</span>
      <span>{t('af.card.tokens', { count: formatUsageNumber(conversation.tokens, locale) })}</span>
      <span>{conversation.cost > 0 ? t('af.card.cost', { cost: money(conversation.cost) }) : t('af.card.unpriced')}</span>
      {duration > 60_000 && <span>{t('af.card.duration', { time: formatDuration(duration, locale) })}</span>}
      {conversation.failures > 0 && <span className="af-bad">{t('af.card.failed', { count: conversation.failures })}</span>}
    </p>
    {failures.slice(0, 2).map(item => {
      const cause = t(`errors.cause.${classifyFailure(item.failure_status, item.failure_body ?? '')}`);
      const recovery = recovered.get(item.id);
      return <p key={item.id} className={`af-failure${recovery ? ' recovered' : ''}`}>{recovery
        ? recovery.otherAccount ? t('af.card.recoveredOther', { cause, account: labelOf(recovery.retried.source) }) : t('af.card.recoveredSame', { cause })
        : t('af.card.failedPlain', { cause, message: failureMessage(item.failure_body ?? '') || String(item.failure_status) })}</p>;
    })}
    {why.kind !== 'unknown' && <p className="af-why">{why.kind === 'first'
      ? t('af.card.why.first', { account, provider: providerName, position: why.position, total: why.total })
      : t(why.reserve ? 'af.card.why.reserve' : 'af.card.why.below', { account, provider: providerName, position: why.position, total: why.total })}</p>}
    <button type="button" className="af-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>{t(open ? 'af.card.hide' : 'af.card.open')}</button>
    {open && <ul className="af-requests">{conversation.items.slice().reverse().map(item => <li key={item.id}>
      <time>{new Date(item.timestamp).toLocaleTimeString(locale)}</time>
      <span className={item.failed ? 'af-bad' : item.canceled ? 'af-muted' : 'af-good'}>{item.failed ? item.failure_status || '✕' : item.canceled ? '—' : '✓'}</span>
      <span>{formatUsageNumber(item.tokens?.total_tokens ?? 0, locale)}</span>
      <span>{item.cost ? money(item.cost.total) : ''}</span>
      <span>{formatDuration(item.latency_ms, locale)}</span>
    </li>)}</ul>}
  </li>;
}

function CostChart({ records, dimension, bucket, onDimension, onBucket, labelOf, appName }: {
  records: UsageRecord[]; dimension: CostDimension; bucket: CostBucket; onDimension: (value: CostDimension) => void; onBucket: (value: CostBucket) => void;
  labelOf: (source: string) => string; appName: (client: string) => string;
}) {
  const { t } = useI18n();
  const columns = costColumns(records, dimension, bucket, labelOf).slice(-14);
  const totals = new Map<string, number>();
  for (const column of columns) for (const [part, value] of Object.entries(column.parts)) totals.set(part, (totals.get(part) ?? 0) + value);
  const parts = [...totals].sort((a, b) => b[1] - a[1]).map(([part]) => part);
  const colorOf = (part: string) => PART_COLORS[Math.max(0, parts.indexOf(part)) % PART_COLORS.length];
  const peak = Math.max(0, ...columns.map(column => column.total));
  const name = (part: string) => dimension === 'app' ? appName(part) : part;
  const label = (time: number) => new Date(time).toLocaleDateString(getCurrentLocale(), bucket === 'day' ? { weekday: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' });
  return <section className="af-panel af-cost">
    <header>
      <h3>{t('af.cost.title')}</h3>
      <div className="af-segments" role="group" aria-label={t('af.cost.by')}>
        {(['app', 'account', 'model'] as const).map(value => <button key={value} type="button" aria-pressed={dimension === value} onClick={() => onDimension(value)}>{t(`af.cost.${value}`)}</button>)}
      </div>
      <div className="af-segments" role="group">
        {(['day', 'week'] as const).map(value => <button key={value} type="button" aria-pressed={bucket === value} onClick={() => onBucket(value)}>{t(`af.cost.${value}`)}</button>)}
      </div>
    </header>
    {!columns.length || peak <= 0 ? <p className="af-note">{t('af.cost.none')}</p> : <>
      <div className="af-bars">{columns.map(column => {
        const ranked = Object.entries(column.parts).sort((a, b) => b[1] - a[1]);
        const text = t('af.cost.bar', { time: label(column.at), total: money(column.total), top: name(ranked[0][0]) });
        return <div key={column.at} className="af-bar" role="img" aria-label={text} title={text}>
          <span className="af-bar-value">{money(column.total)}</span>
          <span className="af-bar-track"><span className="af-bar-stack" style={{ height: `${Math.max(3, (column.total / peak) * 100)}%` }}>
            {/* Shares, not dollars: flex-grow values adding up to less than 1 would leave the bar part empty. */}
            {ranked.map(([part, value]) => <span key={part} style={{ flex: `${value / column.total} 1 0`, background: colorOf(part) }} />)}
          </span></span>
          <span className="af-bar-label">{label(column.at)}</span>
        </div>;
      })}</div>
      {/* Direct labels instead of a legend: each part's name sits beside its colour, biggest first. */}
      <ul className="af-parts">{parts.slice(0, 6).map(part => <li key={part}><span className="sb-swatch" style={{ background: colorOf(part) }} aria-hidden="true" />{name(part)} <b>{money(totals.get(part) ?? 0)}</b></li>)}</ul>
    </>}
  </section>;
}

function Heatmap({ timeline }: { timeline: { hour: string; requests: number }[] }) {
  const { t } = useI18n();
  const grid = usageHeatmap(timeline);
  const peak = Math.max(0, ...grid.flat());
  return <section className="af-panel af-heat">
    <header><h3>{t('af.heat.title')}</h3></header>
    <p className="af-note">{t('af.heat.hint')}</p>
    {peak <= 0 ? <p className="af-note">{t('af.heat.none')}</p> : <div className="af-heat-grid" role="table" aria-label={t('af.heat.title')}>
      {grid.map((row, day) => <div key={day} className="af-heat-row" role="row">
        <span className="af-heat-day" role="rowheader">{t(`af.weekday.${day}` as 'af.weekday.0')}</span>
        {row.map((count, hour) => {
          const text = t('af.heat.cell', { day: t(`af.weekday.${day}` as 'af.weekday.0'), hour, count });
          return <span key={hour} role="cell" className="af-heat-cell" title={text} aria-label={text}
            style={{ opacity: count ? 0.15 + 0.85 * (count / peak) : 1, background: count ? 'var(--primary-color)' : undefined }} />;
        })}
      </div>)}
      <div className="af-heat-hours" aria-hidden="true"><span /><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>
    </div>}
  </section>;
}

