import { quotaAvailability } from './quotaAvailability';
import { quotaKey, type AuthFile, type QuotaState } from './quotaService';
import type { DashboardRequest } from './dashboardActivity';

export function recoveryEvents(files: AuthFile[], quotas: Record<string, QuotaState>, now: number, stale = false) {
  return files.flatMap(file => {
    const state = quotaAvailability(file, quotas[quotaKey(file)], now, stale);
    if (state.groups) return state.groups.flatMap(group => group.recoveryAt && group.recoveryAt > now
      ? [{ file, at: group.recoveryAt, group: group.label, includedOnly: false }] : []);
    return state.recoveryAt && state.recoveryAt > now
      ? [{ file, at: state.recoveryAt, group: '', includedOnly: Boolean(state.includedOnly) }] : [];
  }).sort((a, b) => a.at - b.at);
}

export function recoveredAccounts(before: Record<string, string>, after: Record<string, string>) {
  return Object.keys(after).filter(key => ['exhausted', 'limited', 'creditBacked', 'resetDue'].includes(before[key]) && after[key] === 'available');
}
export function failureIdentity(item: DashboardRequest) {
  return [item.timestamp, item.auth_index, item.model, item.user_agent, item.failure_status].join('|');
}

export type OverviewAlert = { key: string; text: string; rank: number; at: number };
/** Most urgent first: what needs you (a rejected sign-in) before what will pass, and good news last. */
export const ALERT_RANK = { auth: 0, limit: 1, model: 2, network: 3, other: 4, recovered: 9 } as const;

/** Keeps the most important alerts when there are too many, newest first within the same rank. */
export function rankAlerts(alerts: OverviewAlert[], max = 5): OverviewAlert[] {
  return [...alerts].sort((a, b) => a.rank - b.rank || b.at - a.at).slice(0, max);
}
