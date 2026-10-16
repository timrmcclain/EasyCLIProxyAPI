import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useI18n } from '../i18n';
import { classifyFailure, failureMessage, groupFailures, type ErrorCauseGroup, type FailedRequest } from '../services/errorCauses';
import { useAccountLabelBySource } from '../services/accountLabelBySource';
import './ErrorCausesCard.css';

const ago = (iso: string) => {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};

/** Activity → Overview: failed requests grouped by cause, worst first, each with what the provider said and where to fix it. */
export function ErrorCausesCard({ failures, truncated }: { failures: FailedRequest[]; truncated: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  const groups = groupFailures(failures);
  const accountLabel = useAccountLabelBySource();
  const SHOWN = 8;
  // The requests behind a cause, newest first, so "12 sign-in failures" can be traced to accounts.
  const requestsFor = (group: ErrorCauseGroup) => failures.filter(item => classifyFailure(item.failure_status, item.failure_body) === group.cause);
  const fix = (group: ErrorCauseGroup) => window.dispatchEvent(new CustomEvent('app:navigate', { detail: group.target }));

  return (
    <section className="panel error-causes" aria-labelledby="error-causes-title">
      <header>
        <h3 id="error-causes-title">{t('errors.title')}</h3>
        <p>{groups.length ? t('errors.subtitle') : t('errors.none')}</p>
      </header>
      {groups.length > 0 && (
        <ul>
          {groups.map(group => {
            const expanded = open === group.cause;
            return (
              <li key={group.cause} className={`error-cause error-cause-${group.target ? 'fixable' : 'transient'}`}>
                <button type="button" className="error-cause-row" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : group.cause)}>
                  {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                  <strong>{t(`errors.cause.${group.cause}`)}</strong>
                  <span className="error-cause-count">{group.count}</span>
                  <span className="error-cause-meta">
                    {group.providers.slice(0, 3).map(provider => `${provider.name} ${provider.count}`).join(' · ')}
                    {group.statuses.length > 0 && ` · HTTP ${group.statuses.slice(0, 3).join('/')}`}
                    {` · ${t('errors.lastSeen', { time: ago(group.lastSeen) })}`}
                  </span>
                </button>
                {expanded && (
                  <div className="error-cause-detail">
                    <p>{t(`errors.help.${group.cause}`)}</p>
                    {group.example && <blockquote>{group.example}</blockquote>}
                    <ul className="error-cause-requests" aria-label={t('errors.recent')}>
                      {requestsFor(group).slice(0, SHOWN).map((item, index) => <li key={`${item.timestamp}-${index}`}>
                        <time dateTime={item.timestamp} title={new Date(item.timestamp).toLocaleString()}>{ago(item.timestamp)}</time>
                        <strong>{accountLabel(item.source_display || item.source) || item.provider}</strong>
                        <span title={item.failure_body}>{item.failure_status > 0 ? `HTTP ${item.failure_status} · ` : ''}{failureMessage(item.failure_body)}</span>
                      </li>)}
                      {requestsFor(group).length > SHOWN && <li className="error-cause-more">{t('errors.more', { count: requestsFor(group).length - SHOWN })}</li>}
                    </ul>
                    {group.target && (
                      <button type="button" className="secondary-button compact-button" onClick={() => fix(group)}>{t('errors.openAccounts')}</button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {truncated && <p className="error-causes-note">{t('errors.truncated', { count: failures.length })}</p>}
    </section>
  );
}
