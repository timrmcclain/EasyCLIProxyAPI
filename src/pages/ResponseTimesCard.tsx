import { useI18n } from '../i18n';
import { formatDuration, modelTimings, type TimedRequest } from '../services/responseTimes';
import './ResponseTimesCard.css';

/** Activity → Requests: how long each busy model takes, from successful requests matching the filters. */
export function ResponseTimesCard({ requests }: { requests: TimedRequest[] }) {
  const { t } = useI18n();
  const timings = modelTimings(requests);
  const slowest = Math.max(1, ...timings.map(timing => timing.p95Ms));

  return (
    <section className="panel response-times" aria-labelledby="response-times-title">
      {/* Collapsed by default: the Activity page is one screen tall, so an open table would squeeze the request list. */}
      <details>
        <summary>
          <h3 id="response-times-title">{t('timings.title')}</h3>
          <span>{timings.length ? t('timings.summary', { count: timings.length }) : t('timings.none')}</span>
        </summary>
        {timings.length > 0 && <p>{t('timings.subtitle', { count: requests.length })}</p>}
      {timings.length > 0 && (
        <div className="response-times-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{t('timings.model')}</th>
              <th scope="col">{t('timings.requests')}</th>
              <th scope="col">{t('timings.firstToken')}</th>
              <th scope="col">{t('timings.median')}</th>
              <th scope="col">{t('timings.p95')}</th>
              <th scope="col" aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {timings.map(timing => (
              <tr key={timing.model}>
                <th scope="row" title={timing.model}>{timing.model}</th>
                <td>{timing.count}</td>
                <td>{timing.ttftMedianMs === null ? '—' : formatDuration(timing.ttftMedianMs)}</td>
                <td>{formatDuration(timing.medianMs)}</td>
                <td>{formatDuration(timing.p95Ms)}</td>
                <td aria-hidden="true" className="response-times-bar">
                  <span className="response-times-p95" style={{ width: `${(timing.p95Ms / slowest) * 100}%` }} />
                  <span className="response-times-median" style={{ width: `${(timing.medianMs / slowest) * 100}%` }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      </details>
    </section>
  );
}
