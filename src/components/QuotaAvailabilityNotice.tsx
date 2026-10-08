import { useI18n } from '../i18n';
import { resetCountdown } from '../services/accountDashboard';
import type { Availability } from '../services/quotaAvailability';

const stateMark = (kind: Availability['kind']) => kind === 'exhausted' || kind === 'unavailable' ? '⊘' : kind === 'available' ? '✓' : '•';

export function QuotaAvailabilityNotice({ state, now, compact = false }: { state: Availability; now: number; compact?: boolean }) {
  const { t } = useI18n();
  const label = state.reason === 'modelNotFound' ? t('availability.modelPaused') : t(`availability.${state.kind}`);
  const reasonText = state.reason ? t(`availability.${state.reason}`, { model: state.pausedModel ?? '' }) : '';
  if (compact) {
    // One-line chip for dense rows; the explanation stays reachable on hover and in the full notice.
    const hint = [
      state.blockers.map(row => row.label).join(' · '),
      state.recoveryAt && !state.groups ? t(state.includedOnly ? 'credits.renews' : 'availability.wait', { time: resetCountdown(state.recoveryAt, now) }) : '',
      state.uncertainty ? t(`ux.${state.uncertainty}`) : '',
      reasonText,
      ...(state.groups ?? []).map(group => `${group.label}: ${t(`availability.${group.kind}`)}`),
    ].filter(Boolean).join('\n');
    return <span className={`quota-availability-chip quota-availability-${state.kind}`} title={hint || undefined}>
      <span aria-hidden="true">{stateMark(state.kind)}</span>{label}
    </span>;
  }
  return <div className={`quota-availability quota-availability-${state.kind}`}>
    <strong><span aria-hidden="true">{stateMark(state.kind)}</span> {label}</strong>
    {(state.kind === 'exhausted' || state.kind === 'creditBacked') && !state.groups && <span>{state.recoveryAt ? t(state.includedOnly ? 'credits.renews' : 'availability.wait', { time: resetCountdown(state.recoveryAt, now) }) : t('accountDashboard.noReset')}</span>}
    {state.kind === 'creditBacked' && <small>{state.creditBalance !== undefined ? t('credits.balance', { count: new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(state.creditBalance) }) : t('credits.reported')} · {t('credits.hint')}</small>}
    {!!state.resetsAvailable && <small>{t('credits.resets', { count: state.resetsAvailable })}</small>}
    {!!state.blockers.length && <small>{state.blockers.map(row => row.label).join(' · ')}</small>}
    {state.recoveryAt && !state.groups && <time dateTime={new Date(state.recoveryAt).toISOString()}>{new Date(state.recoveryAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>}
    {state.uncertainty && <small>{t(`ux.${state.uncertainty}`)}</small>}
    {reasonText && <small>{reasonText}</small>}
    {state.updating && <small>{t('accountDashboard.refreshing')}</small>}
    {state.groups?.map(group => <small key={group.id} className={`quota-group-state quota-availability-${group.kind}`}>
      {group.label}: {t(`availability.${group.kind}`)}
      {group.recoveryAt ? ` · ${t('availability.wait', { time: resetCountdown(group.recoveryAt, now) })}` : ''}
    </small>)}
  </div>;
}
