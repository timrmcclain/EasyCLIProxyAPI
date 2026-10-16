import { useEffect, useState } from 'react';
import { Activity, ArrowRight, Hourglass, Shrink } from 'lucide-react';
import { useI18n } from '../i18n';
import { compressionService, lifetimeSavingsPercent, type CompressionStats, type CompressionStatus } from '../services/compression';
import { busiestClient, canRecheck, hourlyActivity, type AttentionItem, type UnknownReason } from '../services/homeGlance';
import type { HomeUsageSummary } from '../services/homeOverview';
import { requestClient, type DashboardActivity } from '../services/dashboardActivity';
import { resetCountdown } from '../services/accountDashboard';
import { navigateHelp } from '../services/uxNavigation';
import { requestFailedRequests } from '../usageNavigation';
import { type AuthFile, type QuotaState } from '../services/quotaService';
import { providerRunways, type ProviderRunway } from '../services/quotaRunway';
import { useQuotaHistory } from '../services/quotaForecast';
import { formatTokens } from '../pages/CompressionPage';
import { ProviderLogo } from './AuthFileProviderIcon';
import './HomeGlance.css';

/** Worst providers shown; the rest fold into one line so the tile row stays short. */
const RUNWAY_ROWS = 5;
const COMPRESSION_REFRESH_MS = 30_000;

type GlanceProps = {
  usage: HomeUsageSummary | null; usageLoading: boolean; activity: DashboardActivity | null;
  now: number; providerOf: (file: AuthFile) => string;
  /** The account that served the latest successful request, if it could be matched. */
  latestAccount?: string;
  files: AuthFile[]; quotas: Record<string, QuotaState>; stale: boolean; nameFor: (provider: string) => string;
};

/**
 * What the account ledger says when it has no rows to list. An empty list only means "no accounts" once the list
 * has actually arrived; before that it's loading, and if the fetch failed it says so.
 */
export function attentionEmptyState(proxyReady: boolean, accountCount: number, accountsState: 'loading' | 'failed' | 'loaded'): 'proxyDown' | 'loading' | 'failed' | 'noAccounts' | null {
  if (!proxyReady) return 'proxyDown';
  if (accountCount) return null;
  return accountsState === 'loaded' ? 'noAccounts' : accountsState;
}

/** The summary row under the account ledger: what the proxy is doing, what compression saves, and how long each provider lasts. */
export function HomeGlance(props: GlanceProps) {
  return <div className="home-glance">
    <ActivityTile usage={props.usage} loading={props.usageLoading} activity={props.activity} now={props.now} latestAccount={props.latestAccount} />
    <CompressionTile />
    <RunwayTile {...props} />
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
          {usage.failureCount > 0 && <button type="button" className="glance-bad glance-link" onClick={requestFailedRequests} title={t('glance.activity.failedLink')}>{t('glance.activity.failed', { count: formatNumber(usage.failureCount) })}</button>}
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
  // Off means there's nothing to report; the Compression page still has the switch.
  if (status && !on) return null;
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

/** Accounts whose availability isn't confirmed, one line per reason; Check now only where another check could change it. */
export function UnconfirmedLines({ attention, onCheck, checking = false }: { attention: AttentionItem[]; onCheck?: () => void; checking?: boolean }) {
  const { t } = useI18n();
  const items = attention.filter(item => item.severity === 'unconfirmed');
  if (!items.length) return null;
  const count = (reason: UnknownReason) => items.filter(item => item.unknownReason === reason).length;
  const reasonLines = ([['notChecked', 'glance.attention.uncheckedLine'], ['checkFailed', 'glance.attention.checkFailedLine'],
    ['notReported', 'glance.attention.notReportedLine'], ['partial', 'glance.attention.partialLine']] as const)
    .filter(([reason]) => count(reason) > 0);
  return <div className="glance-unconfirmed">
    <span className="glance-unconfirmed-reasons">{reasonLines.map(([reason, key]) => <span key={reason}>{t(key, { count: count(reason) })}</span>)}</span>
    {onCheck && items.some(item => canRecheck(item.unknownReason)) && <button type="button" className="glance-open" disabled={checking} onClick={onCheck}>{t(checking ? 'glance.attention.checking' : 'glance.attention.checkNow')}</button>}
  </div>;
}

/** How long each provider lasts at the current pace, and which windows give quota back next. */
function RunwayTile({ files, quotas, stale, now, providerOf, nameFor }: GlanceProps) {
  const { t } = useI18n();
  const history = useQuotaHistory();
  const runways = providerRunways(files, quotas, history, now, stale, providerOf);
  const verdict = (runway: ProviderRunway) => {
    switch (runway.kind) {
      case 'lasts': return <span className="runway-lasts">{t('glance.runway.lasts')}</span>;
      case 'runsOut': return <span className="runway-out">{t('glance.runway.runsOut', { time: resetCountdown(runway.emptyAt, now) })}</span>;
      case 'allOut': return <span className="runway-all-out">{t('glance.runway.allOut')}{runway.backAt ? <small>{t('glance.runway.backIn', { time: resetCountdown(runway.backAt, now) })}</small> : null}</span>;
      case 'unconfirmed': return <span className="runway-unknown">{t('glance.attention.unconfirmed')}</span>;
      // Says when the forecast will be ready instead of an open-ended "measuring"; one line, so the card does not grow.
      case 'unknown': return <span className="runway-unknown" title={t('glance.runway.unknown')}>{runway.readyAt && runway.readyAt > now
        ? t('glance.runway.readyIn', { time: resetCountdown(runway.readyAt, now) }) : t('glance.runway.readyNext')}</span>;
    }
  };
  return <article className="glance-tile glance-runway" aria-labelledby="glance-runway-title">
    <header><h3 id="glance-runway-title"><Hourglass size={14} aria-hidden="true" />{t('glance.runway.title')}</h3></header>
    <ul className="glance-runway-list">
      {runways.slice(0, RUNWAY_ROWS).map(runway => <li key={runway.provider}>
        <ProviderLogo provider={runway.provider} />
        <span className="glance-attention-name">{nameFor(runway.provider)}</span>
        <span className="glance-runway-verdict">{verdict(runway)}</span>
      </li>)}
      {runways.length > RUNWAY_ROWS && <li className="glance-runway-more">{t('glance.runway.more', { count: runways.length - RUNWAY_ROWS })}</li>}
    </ul>
    <p className="glance-muted glance-runway-note">{t('glance.runway.estimate')}</p>
  </article>;
}
