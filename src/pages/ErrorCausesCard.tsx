import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useI18n } from '../i18n';
import { groupFailures, type ErrorCauseGroup, type FailedRequest } from '../services/errorCauses';
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
