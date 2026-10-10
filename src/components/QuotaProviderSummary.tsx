import { useState, type CSSProperties, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { quotaAvailability, quotaPercent } from '../services/quotaAvailability';
import { providerForFile, quotaKey, type AuthFile, type QuotaState } from '../services/quotaService';
import { QuotaAvailabilityNotice } from './QuotaAvailabilityNotice';
import { resetCountdown } from '../services/accountDashboard';
import { orderedQuotaRows, primaryQuotaRow, quotaPercentLeft } from '../services/quotaLedger';
import { forecastQuota, useQuotaHistory } from '../services/quotaForecast';

export function QuotaProviderSummary({ accounts, quotas, name, icon, now, stale, labelFor, selected = false, onSelect, provider }: {
  accounts: AuthFile[]; quotas: Record<string, QuotaState>; name: string; icon: ReactNode;
  now: number; stale: boolean; labelFor: (file: AuthFile) => string;
  selected?: boolean; onSelect?: () => void; provider?: string;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const states = accounts.map(file => quotaAvailability(file, quotas[quotaKey(file)], now, stale));
  const unknownReasons = [...new Set(states.filter(state => state.kind === 'unknown').map(state => state.reason))];
  const summaryReason = unknownReasons.length === 1 ? unknownReasons[0] : undefined;
  const count = (kind: string) => states.filter(state => state.kind === kind).length;
  // Available accounts fill to their primary window's remaining quota, matching the account rows below.
  const primaries = accounts.map((file, index) => primaryQuotaRow(orderedQuotaRows(quotas[quotaKey(file)]?.rows ?? []), states[index].blockers));
  const fills = primaries.map((row, index) => states[index].kind === 'available' ? quotaPercentLeft(row) : null);
  // When an account is below half, say when its window refills: that's how long the provider runs short.
  const lowestIndex = fills.reduce<number>((best, fill, index) => fill && fill.tone !== 'healthy' && (best < 0 || fill.percent < fills[best]!.percent) ? index : best, -1);
  const lowestReset = lowestIndex >= 0 && primaries[lowestIndex]?.resetAtMs && primaries[lowestIndex]!.resetAtMs! > now ? primaries[lowestIndex]!.resetAtMs : undefined;
  const runningLow = fills.filter(fill => fill !== null && fill.tone === 'critical').length;
  // The soonest any usable account empties at its recent pace, if that's before its window resets.
  const history = useQuotaHistory();
  const runsOutAt = accounts.reduce<number | undefined>((soonest, file, index) => {
    if (states[index].kind !== 'available') return soonest;
    const forecast = forecastQuota(history[quotaKey(file)], now);
    return forecast.kind === 'runsOut' && (soonest === undefined || forecast.emptyAt < soonest) ? forecast.emptyAt : soonest;
  }, undefined);
  const creditOnly = states.length > 0 && states.every(state => state.kind === 'creditBacked');
  const resets = states.flatMap(state => state.kind === 'exhausted' && state.recoveryAt ? [state.recoveryAt] : []);
  const groupBased = accounts.every(file => providerForFile(file) === 'antigravity');
  const groups = states.flatMap((state, index) => (state.groups ?? []).map(group => ({ ...group, account: accounts[index] })));
  const unconfirmed = states.every(state => state.kind === 'unknown' || state.kind === 'resetDue');
  const groupUnknown = !groups.length || groups.every(group => group.kind === 'unknown' || group.kind === 'resetDue');
  const summaryLabel = groupBased ? groups.length ? 'availability.ofGroups' : states.length === 1 ? `availability.${states[0].kind}` as const : 'availability.unknown'
    : unconfirmed ? 'availability.unknown' : 'availability.ofAccounts';
  // Each provider keeps one identity colour (palette.css --provider-*), shown as the card's top stripe.
  const accent = provider ? { '--provider-accent': `var(--provider-${provider}, var(--provider-other))` } as CSSProperties : undefined;
  return <div className={`quota-provider-summary-cell${selected ? ' is-selected' : ''}`} style={accent}>
    <div className="quota-summary-heading">{onSelect
      ? <button type="button" className="quota-summary-filter" aria-pressed={selected} title={t('glance.runway.filter', { provider: name })} onClick={onSelect}>{icon}<strong>{name}</strong></button>
      : <>{icon}<strong>{name}</strong></>}<span>{accounts.length === 1 ? t('quotaLedger.credential') : t('quotaLedger.credentials', { count: accounts.length })}</span></div>
    <div className="quota-summary-total" title={t(groupBased ? 'availability.reportedGroups' : 'availability.included')}><strong className="quota-summary-value">{creditOnly ? '—' : groupBased ? (groupUnknown ? '—' : groups.filter(group => group.kind === 'available').length) : unconfirmed ? '—' : count('available')}</strong><span>{creditOnly ? t('credits.reported') : t(summaryLabel, { count: groupBased && groups.length ? groups.length : accounts.length })}</span></div>
    <div className="quota-account-states">{states.map((state, index) => {
      const fill = fills[index];
      const label = `${labelFor(accounts[index])}: ${t(`availability.${state.kind}`)}${fill ? ` · ${t('accountDashboard.remaining', { percent: quotaPercent(fill.percent) })}` : ''}`;
      return <span key={quotaKey(accounts[index])} className={`quota-account-state ${state.kind}${fill ? ` tone-${fill.tone}` : ''}`}
        style={fill ? { '--quota-fill': `${fill.percent}%` } as CSSProperties : undefined} title={label} aria-label={label} />;
    })}</div>
    <div className="quota-state-counts">{!!runningLow && <span className="quota-count-runningLow">{runningLow} {t('availability.runningLow')}</span>}{(['exhausted', 'creditBacked', 'limited', 'unknown', 'resetDue', 'unavailable', 'disabled'] as const).filter(kind => count(kind)).map(kind => <span key={kind} className={`quota-count-${kind}`}>{count(kind)} {kind === 'unknown' && summaryReason ? t(`availability.${summaryReason}Short`) : kind === 'unavailable' && states.filter(state => state.kind === 'unavailable').every(state => state.reason === 'planBlocked') ? t('availability.planBlockedLabel') : t(`availability.${kind}`)}</span>)}</div>
    {runsOutAt !== undefined && <div className="quota-summary-forecast">{t('glance.forecast.runsOut', { time: resetCountdown(runsOutAt, now) })}</div>}
    {lowestReset !== undefined && !resets.length && <div className="quota-summary-reset">{t('glance.runway.lowest', { time: resetCountdown(lowestReset, now) })}</div>}
    {!!resets.length && !groupBased && <div className="quota-summary-reset">{accounts.every(file => providerForFile(file) === 'codex') ? t('credits.renews', { time: resetCountdown(Math.min(...resets), now) }) : `${t('availability.recovery')} · ${resetCountdown(Math.min(...resets), now)}`}</div>}
    <div className="quota-summary-extra"><button type="button" aria-expanded={expanded} title={t('availability.scopeHint')} onClick={() => setExpanded(value => !value)}>{t(expanded ? 'quotaLedger.hide' : 'quotaLedger.show')}</button></div>
    {expanded && groupBased && <div className="quota-provider-groups">{groups.map(group => <div key={`${quotaKey(group.account)}:${group.id}`} className={`quota-availability-${group.kind}`}>
      <span>{accounts.length > 1 ? `${labelFor(group.account)} · ` : ''}{group.label}</span><strong>{t(`availability.${group.kind}`)}</strong>
      {group.recoveryAt && <small>{t('availability.wait', { time: resetCountdown(group.recoveryAt, now) })}</small>}
    </div>)}</div>}
    {expanded && <div className="quota-summary-breakdown">{accounts.map((file, index) => <div key={quotaKey(file)}><strong className="quota-summary-account-name">{labelFor(file)}</strong><QuotaAvailabilityNotice state={states[index]} now={now} /></div>)}</div>}
  </div>;
}
