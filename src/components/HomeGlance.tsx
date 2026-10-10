import { useEffect, useState } from 'react';
import { Activity, ArrowRight, CircleCheck, Shrink } from 'lucide-react';
import { useI18n } from '../i18n';
import { compressionService, lifetimeSavingsPercent, type CompressionStats, type CompressionStatus } from '../services/compression';
import { busiestClient, hourlyActivity, type AttentionItem } from '../services/homeGlance';
import type { HomeUsageSummary } from '../services/homeOverview';
import { requestClient, type DashboardActivity } from '../services/dashboardActivity';
import { resetCountdown } from '../services/accountDashboard';
import { navigateHelp } from '../services/uxNavigation';
import { quotaPercent } from '../services/quotaAvailability';
import { quotaKey, type AuthFile } from '../services/quotaService';
import { forecastQuota, useQuotaHistory } from '../services/quotaForecast';
import { formatTokens } from '../pages/CompressionPage';
import { ProviderLogo } from './AuthFileProviderIcon';
import './HomeGlance.css';

const ATTENTION_ROWS = 4;
const COMPRESSION_REFRESH_MS = 30_000;

type GlanceProps = {
  usage: HomeUsageSummary | null; usageLoading: boolean; activity: DashboardActivity | null;
  attention: AttentionItem[]; now: number; labelFor: (file: AuthFile) => string; providerOf: (file: AuthFile) => string;
  /** The account that served the latest successful request, if it could be matched. */
  latestAccount?: string;
  onView: (file: AuthFile) => void; onMore: () => void;
};

/** The at-a-glance row under the provider runway: what the proxy is doing, what compression saves, and what needs you. */
export function HomeGlance(props: GlanceProps) {
  return <div className="home-glance">
    <ActivityTile usage={props.usage} loading={props.usageLoading} activity={props.activity} now={props.now} latestAccount={props.latestAccount} />
    <CompressionTile />
    <AttentionTile {...props} />
  </div>;
}

function ActivityTile({ usage, loading, activity, now, latestAccount }: { usage: HomeUsageSummary | null; loading: boolean; activity: DashboardActivity | null; now: number; latestAccount?: string }) {
  const { t, formatNumber, locale } = useI18n();
  const buckets = hourlyActivity(usage?.timeline ?? [], now);
  const peak = Math.max(1, ...buckets.map(bucket => bucket.requests));
  const busiest = activity ? busiestClient(activity.items) : null;
  const hour = (at: number) => new Date(at).toLocaleTimeString(locale, { hour: 'numeric' });
  return <article className="glance-tile glance-activity" aria-labelledby="glance-activity-title" aria-busy={loading}>
    <header><h3 id="glance-activity-title"><Activity size={14} aria-hidden="true" />{t('glance.activity.title')}</h3>
      <button type="button" className="glance-open" onClick={() => window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'usage-records' }))}>{t('glance.open')}<ArrowRight size={12} aria-hidden="true" /></button></header>
    {!usage ? <p className="glance-muted">{t(loading ? 'common.loading' : 'home.overview.unavailable')}</p>
      : !usage.totalRequests ? <p className="glance-muted">{t('glance.activity.none')}</p>
      : <>
        <p className="glance-figure"><strong>{formatNumber(usage.totalRequests)}</strong> <span>{t('glance.activity.requests')}</span></p>
        <svg className="glance-spark" viewBox="0 0 240 40" preserveAspectRatio="none" role="img" aria-label={t('glance.activity.chart', { count: formatNumber(usage.totalRequests) })}>
          {buckets.map((bucket, index) => {
            const height = bucket.requests ? Math.max(2, bucket.requests / peak * 38) : 1;
            const failed = bucket.requests ? bucket.failures / bucket.requests * height : 0;
            return <g key={bucket.at}><title>{t('glance.activity.hour', { time: hour(bucket.at), requests: formatNumber(bucket.requests), failures: formatNumber(bucket.failures) })}</title>
              <rect className={bucket.requests ? 'spark-ok' : 'spark-empty'} x={index * 10 + 1} y={40 - height} width={8} height={height} rx={1.5} />
              {failed > 0 && <rect className="spark-failed" x={index * 10 + 1} y={40 - failed} width={8} height={failed} rx={1.5} />}
            </g>;
          })}
        </svg>
        <p className="glance-meta">
          {usage.successRate !== null && <span className={usage.successRate < 90 ? 'glance-warn' : undefined}>{t('glance.activity.success', { rate: formatNumber(usage.successRate, { maximumFractionDigits: 1 }) })}</span>}
          {usage.failureCount > 0 && <span className="glance-bad">{t('glance.activity.failed', { count: formatNumber(usage.failureCount) })}</span>}
          {busiest && <span>{t('glance.activity.busiest', { client: busiest.client })}</span>}
        </p>
      </>}
    {activity?.latest && <p className="glance-latest" title={`${activity.latest.model} · ${new Date(activity.latest.timestamp).toLocaleString()}`}>
      {t('glance.activity.latest', { client: requestClient(activity.latest) ?? t('ledger.unknownClient'), account: latestAccount ?? t('ledger.unmatched') })}</p>}
  </article>;
}

function useCompressionGlance() {
  const [status, setStatus] = useState<CompressionStatus | null>(null);
  const [stats, setStats] = useState<CompressionStats | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await compressionService.status();
        if (cancelled) return;
        setStatus(next);
        if (next.enabled && next.running) {
          const result = await compressionService.stats();
          if (!cancelled) setStats(result);
        }
      } catch {
        // The tile is a summary; the Compression page reports errors.
      }
    };
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, COMPRESSION_REFRESH_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  return { status, stats };
}

function CompressionTile() {
  const { t, locale, formatNumber } = useI18n();
  const { status, stats } = useCompressionGlance();
  const lifetime = stats?.persistentSavings?.lifetime;
  const percent = lifetimeSavingsPercent(lifetime);
  const usd = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(lifetime?.compression_savings_usd ?? 0);
  const on = Boolean(status?.enabled);
  return <article className={`glance-tile glance-compression ${on ? '' : 'is-off'}`} aria-labelledby="glance-compression-title">
    <header><h3 id="glance-compression-title"><Shrink size={14} aria-hidden="true" />{t('glance.compression.title')}</h3>
      <button type="button" className="glance-open" onClick={() => navigateHelp('compression')}>{t('glance.open')}<ArrowRight size={12} aria-hidden="true" /></button></header>
    {!status ? <p className="glance-muted">{t('common.loading')}</p>
      : !on ? <><p className="glance-figure"><strong>{t('glance.compression.off')}</strong></p><p className="glance-muted">{t('glance.compression.offDetail')}</p></>
      : !status.routed ? <p className="glance-warn">{t('glance.compression.fallback')}</p>
      : !lifetime?.requests ? <p className="glance-muted">{t('glance.compression.waiting')}</p>
      : <>
        <p className="glance-figure"><strong>{usd}</strong> <span>{t('glance.compression.saved')}</span></p>
        <p className="glance-meta">
          <span>{t('glance.compression.tokens', { tokens: formatTokens(lifetime.tokens_saved ?? 0, locale) })}</span>
          {percent !== null && <span>{t('glance.compression.average', { percent: formatNumber(percent, { maximumFractionDigits: 1 }) })}</span>}
        </p>
      </>}
  </article>;
}

function AttentionTile({ attention, now, labelFor, providerOf, onView, onMore }: GlanceProps) {
  const { t } = useI18n();
  const shown = attention.slice(0, ATTENTION_ROWS);
  const history = useQuotaHistory();
  const runsOut = (item: AttentionItem) => {
    if (item.severity !== 'low') return undefined;
    const forecast = forecastQuota(history[quotaKey(item.file)], now);
    return forecast.kind === 'runsOut' ? forecast.emptyAt : undefined;
  };
  const status = (item: AttentionItem) => item.severity === 'blocked' ? t('glance.attention.blocked')
    : item.severity === 'low' ? t('glance.attention.low', { percent: quotaPercent(item.percent ?? 0) }) : t('glance.attention.unconfirmed');
  return <article className={`glance-tile glance-attention ${attention.length ? `worst-${attention[0].severity}` : 'is-clear'}`} aria-labelledby="glance-attention-title">
    <header><h3 id="glance-attention-title">{t('glance.attention.title')}{attention.length > 0 && <span className="glance-count">{attention.length}</span>}</h3></header>
    {!attention.length ? <div className="glance-clear"><CircleCheck size={18} aria-hidden="true" /><span><strong>{t('glance.attention.none')}</strong><small>{t('glance.attention.noneDetail')}</small></span></div>
      : <ul className="glance-attention-list">
        {shown.map(item => <li key={quotaKey(item.file)} className={`attention-${item.severity}`}>
          <ProviderLogo provider={providerOf(item.file)} />
          <span className="glance-attention-name" title={labelFor(item.file)}>{labelFor(item.file)}</span>
          <span className="glance-attention-state">{status(item)}{runsOut(item) !== undefined ? <small className="glance-forecast">{t('glance.forecast.runsOut', { time: resetCountdown(runsOut(item), now) })}</small>
            : item.resetAt ? <small>{t('glance.attention.resets', { time: resetCountdown(item.resetAt, now) })}</small> : null}</span>
          <button type="button" className="glance-open" onClick={() => onView(item.file)} aria-label={`${t('glance.attention.view')}: ${labelFor(item.file)}`}>{t('glance.attention.view')}</button>
        </li>)}
        {attention.length > shown.length && <li className="glance-attention-more"><button type="button" className="glance-open" onClick={onMore}>{t('glance.attention.more', { count: attention.length - shown.length })}</button></li>}
      </ul>}
  </article>;
}
