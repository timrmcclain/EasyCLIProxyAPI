import type { CSSProperties, ReactNode } from 'react';
import { useI18n } from '../i18n';
import { quotaAvailability, quotaPercent, type Availability } from '../services/quotaAvailability';
import { providerForFile, quotaKey, type AuthFile, type QuotaState } from '../services/quotaService';
import { orderedQuotaRows, primaryQuotaRow, quotaPercentLeft } from '../services/quotaLedger';

const blockingKinds: Availability['kind'][] = ['exhausted', 'limited', 'resetDue', 'unavailable'];

/** One label for the accounts that can't take requests: the shared cause when they all have one, else a plain count. */
export function blockingLabel(blocking: Availability[], t: (key: 'availability.termsRequiredLabel' | 'availability.planBlockedLabel' | 'availability.exhausted' | 'availability.cantTakeRequests') => string): string {
  if (blocking.every(state => state.reason === 'termsRequired')) return t('availability.termsRequiredLabel');
  if (blocking.every(state => state.reason === 'planBlocked')) return t('availability.planBlockedLabel');
  if (blocking.every(state => state.kind === 'exhausted')) return t('availability.exhausted');
  return t('availability.cantTakeRequests');
}

export function QuotaProviderSummary({ accounts, quotas, name, icon, now, stale, labelFor, selected = false, onSelect, provider }: {
  accounts: AuthFile[]; quotas: Record<string, QuotaState>; name: string; icon: ReactNode;
  now: number; stale: boolean; labelFor: (file: AuthFile) => string;
  selected?: boolean; onSelect?: () => void; provider?: string;
}) {
  const { t } = useI18n();
  const states = accounts.map(file => quotaAvailability(file, quotas[quotaKey(file)], now, stale));
  const unknownReasons = [...new Set(states.filter(state => state.kind === 'unknown').map(state => state.reason))];
  const summaryReason = unknownReasons.length === 1 ? unknownReasons[0] : undefined;
  const count = (kind: string) => states.filter(state => state.kind === kind).length;
  // Available accounts fill to their primary window's remaining quota, matching the account rows below.
  const primaries = accounts.map((file, index) => primaryQuotaRow(orderedQuotaRows(quotas[quotaKey(file)]?.rows ?? []), states[index].blockers));
  const fills = primaries.map((row, index) => states[index].kind === 'available' ? quotaPercentLeft(row) : null);
  const runningLow = fills.filter(fill => fill !== null && fill.tone === 'critical').length;
  const creditOnly = states.length > 0 && states.every(state => state.kind === 'creditBacked');
  const blocking = states.filter(state => blockingKinds.includes(state.kind));
  const groupBased = accounts.every(file => providerForFile(file) === 'antigravity');
  const groups = states.flatMap((state, index) => (state.groups ?? []).map(group => ({ ...group, account: accounts[index] })));
  const unconfirmed = states.every(state => state.kind === 'unknown' || state.kind === 'resetDue');
  const groupUnknown = !groups.length || groups.every(group => group.kind === 'unknown' || group.kind === 'resetDue');
  const summaryLabel = groupBased ? groups.length ? 'availability.ofGroups' : states.length === 1 ? `availability.${states[0].kind}` as const : 'availability.unknown'
    : unconfirmed ? 'availability.unknown' : 'availability.ofAccounts';
  // Each provider keeps one identity colour (palette.css --provider-*), shown as the card's top stripe.
  const accent = provider ? { '--provider-accent': `var(--provider-${provider}, var(--provider-other))` } as CSSProperties : undefined;
  const countText = [
    runningLow ? `${runningLow} ${t('availability.runningLow')}` : '',
    blocking.length ? `${blocking.length} ${blockingLabel(blocking, t)}` : '',
    ...(['creditBacked', 'unknown', 'disabled'] as const).filter(kind => count(kind)).map(kind => `${count(kind)} ${kind === 'unknown' && summaryReason ? t(`availability.${summaryReason}Short`) : t(`availability.${kind}`)}`),
  ].filter(Boolean).join(' · ');
  // One compact line per provider: it filters the ledger, so the detail lives in the rows.
  return <div className={`quota-provider-summary-cell${selected ? ' is-selected' : ''}`} style={accent} title={countText || undefined}>
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
    {/* The counts stay readable on hover and to screen readers; each ledger row below gives its own cause, reset and groups. */}
    {countText && <span className="sr-only">{countText}</span>}
  </div>;
}
