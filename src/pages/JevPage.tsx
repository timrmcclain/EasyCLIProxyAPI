import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CircleCheck, CircleX, ExternalLink, RefreshCw } from 'lucide-react';
import { useI18n } from '../i18n';
import { resetCountdown } from '../services/accountDashboard';
import { interventionCounts, jevService, jevStatusRows, jevTime, type JevIntervention, type JevInterventionKind, type JevOverview, type JevStatusLevel, type JevStatusRow } from '../services/jev';
import './HealthCheckPage.css';
import './JevPage.css';

const icons: Record<JevStatusLevel, typeof CircleCheck> = { ok: CircleCheck, warn: AlertTriangle, fail: CircleX };
const kinds: JevInterventionKind[] = ['sentBack', 'blocked', 'guarded', 'asked', 'loopStopped'];

/** "3h 5m" for how long ago a Jev timestamp was. */
const ago = (at: number, now: number) => resetCountdown(now + Math.max(60_000, now - at), now);

/** What Jev runs in every Claude Code session, whether it pays off, and when it stepped in. Read-only. */
export function JevPage() {
  const { t } = useI18n();
  const [overview, setOverview] = useState<JevOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setOverview(await jevService.overview());
      setError(null);
    } catch (cause) {
      setError(String(cause));
    }
    setNow(Date.now());
  }, []);

  useEffect(() => { void load(); }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      await jevService.refreshReport();
      await load();
    } catch (cause) {
      setRefreshError(String(cause));
    } finally {
      setRefreshing(false);
    }
  };

  const statusText = (row: JevStatusRow) => {
    const time = Number.isFinite(row.values.at as number) ? ago(row.values.at as number, now) : '';
    switch (row.id) {
      case 'hooks': return t(row.level === 'ok' ? 'jev.status.hooks.ok' : 'jev.status.hooks.fail', { count: row.values.count });
      case 'selftest': return row.level === 'fail' ? t('jev.status.selftest.fail', { ...row.values, time })
        : row.level === 'ok' ? t('jev.status.selftest.ok', { ...row.values, time }) : t('jev.status.selftest.warn');
      case 'replay': return (row.values.problems as number) > 0 ? t('jev.status.replay.problems', row.values)
        : row.level === 'ok' ? t('jev.status.replay.ok', { time }) : t('jev.status.replay.warn');
      case 'report': return row.level === 'ok' ? t('jev.status.report.ok', { time }) : t('jev.status.report.warn');
    }
  };

  const detail = (item: JevIntervention) => {
    if (item.kind === 'loopStopped') return t('jev.detail.loop', { count: item.detail });
    if (item.detail === 'edit') return t('jev.detail.edit');
    if (item.detail === 'remote patch') return t('jev.detail.remotePatch');
    if (item.detail === 'command') return t('jev.detail.command');
    return item.detail;
  };

  if (error) return <div className="health-page jev-page"><p role="alert" className="ad-notice ad-error">{t('jev.loadError', { error })}</p></div>;
  if (overview && !overview.installed) return <div className="health-page jev-page"><header className="health-heading"><div><h1>{t('jev.title')}</h1><p>{t('jev.notInstalled')}</p></div></header></div>;

  const report = overview?.report;
  const counts = interventionCounts(overview?.interventions ?? []);
  return <div className="health-page jev-page" aria-busy={overview === null || undefined}>
    <header className="health-heading">
      <div>
        <h1>{t('jev.title')}</h1>
        <p>{t('jev.subtitle')}</p>
      </div>
    </header>

    <section aria-labelledby="jev-status-title">
      <h2 id="jev-status-title" className="jev-section-title">{t('jev.status.title')}</h2>
      <ul className="health-list">
        {overview && jevStatusRows(overview, now).map(row => {
          const Icon = icons[row.level];
          return <li key={row.id} className={`health-item level-${row.level}`}>
            <Icon size={18} aria-hidden="true" />
            <span className="health-text">{statusText(row)}</span>
          </li>;
        })}
      </ul>
    </section>

    <section aria-labelledby="jev-payoff-title" className="jev-card">
      <header className="jev-card-heading">
        <h2 id="jev-payoff-title" className="jev-section-title">{t('jev.payoff.title', { days: report?.days ?? 7 })}</h2>
        <div className="jev-actions">
          {overview?.reportPath && <button type="button" className="secondary-button compact-button" onClick={() => void jevService.openReport().catch(() => undefined)}>
            {t('jev.payoff.open')}<ExternalLink size={12} aria-hidden="true" />
          </button>}
          <button type="button" className="secondary-button compact-button" disabled={refreshing} onClick={() => void refresh()}>
            <RefreshCw size={14} className={refreshing ? 'spin' : undefined} aria-hidden="true" />{refreshing ? t('jev.payoff.refreshing') : t('jev.payoff.refresh')}
          </button>
        </div>
      </header>
      {refreshError && <p role="alert" className="jev-error">{t('jev.payoff.refreshFailed', { error: refreshError })}</p>}
      {!report?.answers?.length ? <p className="glance-muted">{t('jev.payoff.empty')}</p>
        : <ul className="jev-answers">
          {report.answers.map(answer => <li key={answer.question} className={`tone-${answer.tone}`}>
            <span className="jev-question">{answer.question}</span>
            <strong className="jev-answer">{answer.answer}</strong>
            {answer.evidence && <details><summary>{t('jev.payoff.details')}</summary><p>{answer.evidence}</p></details>}
          </li>)}
          {(report.spend_usd !== undefined || report.ms_per_check !== undefined) && <li className="tone-neutral">
            <span className="jev-question">{t('jev.payoff.cost')}</span>
            <strong className="jev-answer">{t('jev.payoff.costDetail', { usd: (report.spend_usd ?? 0).toFixed(2), ms: report.ms_per_check ?? 0 })}</strong>
          </li>}
        </ul>}
      {report?.alerts && report.alerts.length > 0 && <div className="jev-alerts">
        <h3>{t('jev.payoff.alerts')}</h3>
        <ul>{report.alerts.map(alert => <li key={alert}><AlertTriangle size={14} aria-hidden="true" />{alert}</li>)}</ul>
      </div>}
    </section>

    <section aria-labelledby="jev-interventions-title" className="jev-card">
      <header className="jev-card-heading">
        <div>
          <h2 id="jev-interventions-title" className="jev-section-title">{t('jev.interventions.title')}</h2>
          <p className="jev-subtitle">{t('jev.interventions.subtitle')}</p>
        </div>
        <p className="jev-counts">{kinds.filter(kind => counts[kind]).map(kind => <span key={kind} className={`jev-kind-${kind}`}>{kind === 'loopStopped' && counts[kind] === 1 ? t('jev.kind.count.loopStoppedOne') : t(`jev.kind.count.${kind}` as 'jev.kind.count.blocked', { count: counts[kind] ?? 0 })}</span>)}</p>
      </header>
      {!overview?.interventions.length ? <p className="glance-muted">{t('jev.interventions.none')}</p>
        : <ul className="jev-interventions">
          {overview.interventions.map((item, index) => {
            const at = jevTime(item.ts);
            const text = detail(item);
            return <li key={`${item.ts}-${index}`} className={`jev-kind-${item.kind}`}>
              <time dateTime={item.ts} title={new Date(at).toLocaleString()}>{ago(at, now)}</time>
              <span className="jev-intervention-text"><strong>{t(`jev.kind.${item.kind}` as 'jev.kind.blocked')}</strong>{text ? <span>{text}</span> : null}</span>
              {item.project && <span className="jev-project">{item.project}</span>}
            </li>;
          })}
        </ul>}
    </section>
  </div>;
}
