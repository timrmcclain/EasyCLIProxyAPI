import { useI18n } from '../i18n';
import { accountSummary, resetCountdown } from '../services/accountDashboard';
import { forecastQuota, useQuotaHistory } from '../services/quotaForecast';
import { quotaAvailability } from '../services/quotaAvailability';
import { quotaKey, type AuthFile, type QuotaState } from '../services/quotaService';
import { privateText } from '../services/dashboardActivity';
import { QuotaAvailabilityNotice } from './QuotaAvailabilityNotice';
import './AccountDashboard.css';

/**
 * An account's status explanation, shared by Overview's row details and the Accounts page's Details,
 * so the same account reads the same in both: why it can or can't take requests, when it may recover,
 * the pace estimate, and what the proxy reports about the credential.
 */
export function AccountStatusSection({ file, quota, now, stale = false, hideEmails = false, notice = true, credential = true }: {
  file: AuthFile; quota: QuotaState; now: number; stale?: boolean; hideEmails?: boolean;
  /** Off where the row already shows the full availability notice. */
  notice?: boolean;
  /** Off where a cooldown/health panel already reports the credential. */
  credential?: boolean;
}) {
  const { t } = useI18n();
  const history = useQuotaHistory();
  const summary = accountSummary(file);
  const availability = quotaAvailability(file, quota, now, stale);
  // A pace estimate, only for accounts that can still take requests; blocked ones say when they're back instead.
  const forecast = availability.kind === 'available' ? forecastQuota(history[quotaKey(file)], now) : undefined;
  return <div className="account-status-section">
    {notice && <QuotaAvailabilityNotice state={availability} now={now} />}
    {/* A reset time is the provider's estimate, not a promise the account works again. */}
    {availability.recoveryAt && ['exhausted', 'limited', 'creditBacked'].includes(availability.kind) && <p className="ad-card-note ad-recovery-hint">{t('ux.recoveryHint')}</p>}
    {forecast?.kind === 'runsOut' && <p className="ad-card-note ad-forecast">{t('glance.forecast.runsOut', { time: resetCountdown(forecast.emptyAt, now) })}</p>}
    {credential && summary.health.message && <p className="ad-card-note">{privateText(summary.health.message, hideEmails)}</p>}
    {credential && <p className="ad-card-note"><strong>{t('desk.credentialHealth')}: </strong>{stale ? t('accountDashboard.stale') : summary.health.tone === 'success' ? t('desk.active') : t(summary.health.label)} · {t('desk.healthHint')}</p>}
  </div>;
}
