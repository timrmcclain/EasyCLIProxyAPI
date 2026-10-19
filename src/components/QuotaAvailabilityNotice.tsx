import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { resetCountdown } from '../services/accountDashboard';
import { readBlockedRouting, releaseBlockedAccount } from '../services/blockedRouting';
import type { Availability } from '../services/quotaAvailability';
import { fileName, type AuthFile } from '../services/quotaService';

const blockedKinds = new Set<Availability['kind']>(['exhausted', 'limited', 'creditBacked']);
const stateMark = (kind: Availability['kind']) => kind === 'exhausted' || kind === 'unavailable' ? '⊘' : kind === 'available' ? '✓' : '•';

/** Whether the hub has moved this account below the others because the provider refuses it; follows changes live. */
function useRoutedAway(name: string | undefined) {
  const read = () => Boolean(name && readBlockedRouting().demoted[name]);
  const [routedAway, setRoutedAway] = useState(read);
  useEffect(() => {
    const sync = () => setRoutedAway(read());
    sync();
    window.addEventListener('app:blocked-routing', sync);
    return () => window.removeEventListener('app:blocked-routing', sync);
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps
  return routedAway;
}

/**
 * `onAccounts`: shown on the Accounts page, so the text names the control beside it instead of sending you to Accounts.
 * `file`: the account, so a refused one can say where requests go instead and be put back in use.
 */
export function QuotaAvailabilityNotice({ state, now, compact = false, onAccounts = false, file }: { state: Availability; now: number; compact?: boolean; onAccounts?: boolean; file?: AuthFile }) {
  const { t } = useI18n();
  const name = file ? fileName(file) : undefined;
  const routedAway = useRoutedAway(name);
  const [released, setReleased] = useState(false);
  const useAgain = async () => {
    if (!file || !name) return;
    await releaseBlockedAccount(name).catch(() => undefined);
    setReleased(true);
  };
  const label = state.reason === 'modelNotFound' ? t('availability.modelPaused') : state.reason === 'planBlocked' ? t('availability.planBlockedLabel') : state.reason === 'termsRequired' ? t('availability.termsRequiredLabel') : t(`availability.${state.kind}`);
  const reasonKey = state.reason === 'modelNotFound' && onAccounts ? 'availability.modelNotFoundHere' as const : state.reason ? `availability.${state.reason}` as const : null;
  const reasonText = reasonKey ? t(reasonKey, { model: state.pausedModel ?? '', message: state.planMessage ?? '' }) : '';
  if (compact) {
    // One-line chip for dense rows; the explanation stays reachable on hover and in the full notice.
    const hint = [
      state.blockers.map(row => row.label).join(' · '),
      state.recoveryAt && !state.groups ? t(state.includedOnly ? 'credits.renews' : 'availability.wait', { time: resetCountdown(state.recoveryAt, now) }) : '',
      state.uncertainty ? t(`ux.${state.uncertainty}`) : '',
      reasonText,
      ...(state.groups ?? []).map(group => `${group.label}: ${t(`availability.${group.kind}`)}`),
    ].filter(Boolean).join('\n');
    // A blocked row leads with when it comes back: the window that blocks it, not whichever resets soonest.
    const recovery = state.recoveryAt && state.recoveryAt > now && !state.groups && blockedKinds.has(state.kind) && !state.reason;
    const chipLabel = state.kind === 'exhausted' && !state.reason ? t('availability.chipUnavailable') : label;
    return <span className={`quota-availability-chip quota-availability-${state.kind}`} title={hint || undefined}>
      <span aria-hidden="true">{stateMark(state.kind)}</span>{recovery ? t('availability.chipResets', { label: chipLabel, time: resetCountdown(state.recoveryAt!, now) }) : chipLabel}
    </span>;
  }
  return <div className={`quota-availability quota-availability-${state.kind}`}>
    <strong><span aria-hidden="true">{stateMark(state.kind)}</span> {label}</strong>
    {(state.kind === 'exhausted' || state.kind === 'creditBacked') && !state.groups && <span>{state.recoveryAt ? t(state.includedOnly ? 'credits.renews' : 'availability.wait', { time: resetCountdown(state.recoveryAt, now) }) : t('accountDashboard.noReset')}</span>}
    {state.kind === 'creditBacked' && <small>{state.creditBalance !== undefined ? t('credits.balance', { count: new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(state.creditBalance) }) : t('credits.reported')} · {t('credits.hint')}</small>}
    {!!state.resetsAvailable && <small>{t(onAccounts ? 'credits.resetsHere' : 'credits.resets', { count: state.resetsAvailable })}</small>}
    {!!state.blockers.length && <small>{state.blockers.map(row => row.label).join(' · ')}</small>}
    {state.recoveryAt && !state.groups && <time dateTime={new Date(state.recoveryAt).toISOString()}>{new Date(state.recoveryAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>}
    {state.uncertainty && <small>{t(`ux.${state.uncertainty}`)}</small>}
    {reasonText && <small>{reasonText}</small>}
    {/* A fixed address, never a link taken from the provider's message. */}
    {state.reason === 'termsRequired' && <button type="button" className="secondary-button compact-button quota-availability-action" onClick={() => void invoke('open_external_url', { url: 'https://claude.ai/' }).catch(() => undefined)}>{t('availability.openClaude')}</button>}
    {routedAway && !released && <>
      <small className="quota-routed-away">{t('availability.routedAway')}</small>
      <button type="button" className="secondary-button compact-button quota-availability-action" onClick={() => void useAgain()}>{t('availability.useAgain')}</button>
    </>}
    {released && <small role="status">{t('availability.usedAgain')}</small>}
    {state.updating && <small>{t('accountDashboard.refreshing')}</small>}
    {state.groups?.map(group => <small key={group.id} className={`quota-group-state quota-availability-${group.kind}`}>
      {group.label}: {t(`availability.${group.kind}`)}
      {group.recoveryAt ? ` · ${t('availability.wait', { time: resetCountdown(group.recoveryAt, now) })}` : ''}
    </small>)}
  </div>;
}
