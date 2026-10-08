import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Gauge, Loader2 } from 'lucide-react';
import { FeedbackNotice, useAppNotice } from '../appNotice';
import { useI18n } from '../i18n';
import { compressionText, type CompressionTextKey } from '../i18n/compression';
import {
  compressionService,
  dailySavings,
  lifetimeSavingsPercent,
  type CompressionStats,
  type CompressionStatus,
} from '../services/compression';
import { CompressionLearnings } from './CompressionLearnings';
import './CompressionPage.css';

const REFRESH_MS = 15_000;

export function formatTokens(value: number, locale: string) {
  return new Intl.NumberFormat(locale, { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
}

export default function CompressionPage() {
  const { locale } = useI18n();
  const t = useCallback(
    (key: CompressionTextKey, values?: Record<string, string | number>) => compressionText(key, locale, values),
    [locale],
  );
  const feedback = useAppNotice();
  const [status, setStatus] = useState<CompressionStatus | null>(null);
  const [stats, setStats] = useState<CompressionStats | null>(null);
  const [statsError, setStatsError] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await compressionService.status();
      setStatus(next);
      if (next.running) {
        try {
          setStats(await compressionService.stats());
          setStatsError(false);
        } catch {
          setStatsError(true);
        }
      }
    } catch (error) {
      feedback.showNotice(String(error), 'error');
    }
  }, [feedback.showNotice]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      setStatus(await compressionService.setEnabled(enabled));
      await refresh();
    } catch (error) {
      feedback.showNotice(t(enabled ? 'turnOnFailed' : 'turnOffFailed', { error: String(error) }), 'error');
    } finally {
      setBusy(false);
    }
  };

  const setRoute = async (claudeCode: boolean, claudeDesktop: boolean) => {
    setBusy(true);
    try {
      setStatus(await compressionService.setRoutes(claudeCode, claudeDesktop));
    } catch (error) {
      feedback.showNotice(t('routeFailed', { error: String(error) }), 'error');
    } finally {
      setBusy(false);
    }
  };

  const setMemory = async (memory: boolean) => {
    setBusy(true);
    try {
      setStatus(await compressionService.setMemory(memory));
    } catch (error) {
      feedback.showNotice(t('routeFailed', { error: String(error) }), 'error');
    } finally {
      setBusy(false);
    }
  };

  const lifetime = stats?.persistentSavings?.lifetime;
  const days = useMemo(() => dailySavings(stats?.persistentSavings?.recent_history), [stats]);
  const maxDay = Math.max(1, ...days.map((day) => day.tokens));
  const percent = lifetimeSavingsPercent(lifetime);
  const models = Object.entries(stats?.persistentSavings?.by_model ?? {})
    .filter(([, model]) => (model.requests ?? 0) > 0)
    .sort((a, b) => (b[1].tokens_saved ?? 0) - (a[1].tokens_saved ?? 0));
  const apps = (stats?.agentUsage?.agents ?? []).filter((agent) => (agent.requests ?? 0) > 0);
  const recent = (stats?.recentRequests ?? [])
    .filter((request) => !String(request.model ?? '').startsWith('passthrough:'))
    .slice(0, 8);
  const fmt = (value: number | undefined) => formatTokens(value ?? 0, locale);
  const usd = (value: number | undefined) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value ?? 0);

  const fallback = Boolean(status?.enabled && !status.routed);
  const stateText = !status
    ? t('stateStarting')
    : busy
      ? t('stateStarting')
      : fallback
        ? t('stateFallback')
        : status.enabled
          ? t('stateOn', { port: status.port })
          : t('stateOff');

  return (
    <div className="compression-page">
      <header className="compression-heading">
        <div>
          <h1>{t('title')}</h1>
          <p>{t('description')}</p>
          <details className="compression-hint">
            <summary>{t('howItWorks')}</summary>
            <p>{t('howItWorksDetail')}</p>
          </details>
        </div>
      </header>

      <FeedbackNotice feedback={feedback} />

      {status && !status.installed ? (
        <section className="compression-card compression-missing" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <div>
            <h2>{t('notInstalled')}</h2>
            <p>{t('notInstalledBody')}</p>
          </div>
        </section>
      ) : (
        <section className="compression-card compression-control" aria-busy={busy || !status}>
          <label className="compression-switch">
            <input
              type="checkbox"
              role="switch"
              checked={Boolean(status?.enabled)}
              disabled={busy || !status}
              onChange={(event) => void toggle(event.target.checked)}
            />
            <span>{t('switchLabel')}</span>
          </label>
          <p className={`compression-state${fallback ? ' warn' : status?.enabled ? ' on' : ''}`} role="status">
            {busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : null}
            {stateText}
          </p>
          {status?.lastError && fallback ? <p className="compression-error">{status.lastError}</p> : null}
          <fieldset className="compression-apps" disabled={busy || !status}>
            <legend>{t('appsTitle')}</legend>
            <label>
              <input
                type="checkbox"
                checked={Boolean(status?.routeClaudeCode)}
                onChange={(event) => void setRoute(event.target.checked, Boolean(status?.routeClaudeDesktop))}
              />
              {t('appClaudeCode')}
            </label>
            <label>
              <input
                type="checkbox"
                checked={Boolean(status?.routeClaudeDesktop)}
                onChange={(event) => void setRoute(Boolean(status?.routeClaudeCode), event.target.checked)}
              />
              {t('appClaudeDesktop')}
            </label>
            <p>{t('appsRestart')}</p>
          </fieldset>
          <label className="compression-memory">
            <input
              type="checkbox"
              role="switch"
              checked={Boolean(status?.memory)}
              disabled={busy || !status}
              onChange={(event) => void setMemory(event.target.checked)}
            />
            <span>
              <strong>{t('memoryLabel')}</strong>
              <small>{t('memoryBody')}</small>
            </span>
          </label>
        </section>
      )}

      {status?.running ? (
        statsError ? (
          <p className="compression-empty" role="alert">{t('statsUnavailable')}</p>
        ) : !lifetime?.requests ? (
          <p className="compression-empty">{t('noTraffic')}</p>
        ) : (
          <>
            <section className="compression-metrics" aria-label={t('lifetime')}>
              <div className="compression-metric">
                <span>{t('tokensSaved')}</span>
                <strong>{fmt(lifetime.tokens_saved)}</strong>
                <small>{t('lifetime')}</small>
              </div>
              <div className="compression-metric">
                <span>{t('savedPercent')}</span>
                <strong>{percent === null ? '—' : `${percent.toFixed(0)}%`}</strong>
                <small>{t('compressedRequests', { count: stats?.summary?.compression?.requests_compressed ?? 0 })}</small>
              </div>
              <div className="compression-metric">
                <span>{t('dollarsSaved')}</span>
                <strong>~{usd(lifetime.compression_savings_usd)}</strong>
                <small className="compression-tag">{t('estimated')}</small>
              </div>
              <div className="compression-metric">
                <span>{t('requests')}</span>
                <strong>{fmt(lifetime.requests)}</strong>
                <small>{t('lifetime')}</small>
              </div>
            </section>

            <section className="compression-card">
              <h2><Gauge size={16} aria-hidden="true" />{t('daily')}</h2>
              <div className="compression-bars" role="img" aria-label={t('daily')}>
                {days.map((day) => (
                  <div key={day.day} className="compression-bar" title={`${day.day}: ${fmt(day.tokens)}`}>
                    <span style={{ height: `${Math.max(2, (day.tokens / maxDay) * 100)}%` }} />
                    <small>{day.day.slice(8)}</small>
                  </div>
                ))}
              </div>
            </section>

            <div className="compression-grid">
              <section className="compression-card">
                <h2>{t('byModel')}</h2>
                <table className="compression-table">
                  <thead><tr><th>{t('colModel')}</th><th>{t('colRequests')}</th><th>{t('colSaved')}</th></tr></thead>
                  <tbody>
                    {models.map(([name, model]) => (
                      <tr key={name}>
                        <td>{name}</td>
                        <td>{fmt(model.requests)}</td>
                        <td>{fmt(model.tokens_saved)}{model.savings_percent ? ` · ${model.savings_percent.toFixed(0)}%` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <section className="compression-card">
                <h2>{t('byApp')}</h2>
                <table className="compression-table">
                  <thead><tr><th>{t('colApp')}</th><th>{t('colRequests')}</th><th>{t('colSaved')}</th></tr></thead>
                  <tbody>
                    {apps.map((agent) => (
                      <tr key={`${agent.agent}-${agent.label}`}>
                        <td>{agent.label ?? agent.agent}</td>
                        <td>{fmt(agent.requests)}</td>
                        <td>{fmt(agent.tokens_saved)}{agent.savings_percent ? ` · ${agent.savings_percent.toFixed(0)}%` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </div>

            {recent.length ? (
              <section className="compression-card">
                <h2>{t('recent')}</h2>
                <table className="compression-table">
                  <thead>
                    <tr><th>{t('colTime')}</th><th>{t('colModel')}</th><th>{t('colBefore')}</th><th>{t('colAfter')}</th><th>{t('colSaved')}</th></tr>
                  </thead>
                  <tbody>
                    {recent.map((request) => (
                      <tr key={request.request_id}>
                        <td>{request.timestamp ? new Date(request.timestamp).toLocaleTimeString(locale) : ''}</td>
                        <td>{request.model}</td>
                        <td>{fmt(request.input_tokens_original)}</td>
                        <td>{fmt(request.input_tokens_optimized)}</td>
                        <td>{request.savings_percent ? `${request.savings_percent.toFixed(0)}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ) : null}
          </>
        )
      ) : null}

      {status ? <CompressionLearnings installed={status.installed} /> : null}

      {status?.logPath ? <p className="compression-footnote">{t('openLog')}: <code>{status.logPath}</code></p> : null}
    </div>
  );
}
