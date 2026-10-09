import { authFileHealth } from './authFileHealth';
import { getCurrentLocale, translate } from '../i18n';
import { quotaKey, type AuthFile, type QuotaRow, type QuotaState } from './quotaService';

export const remaining = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;

function windowRank(label: string) {
  const t = (key: Parameters<typeof translate>[1]) => translate(getCurrentLocale(), key);
  if (label === t('quota.service.window.sevenDayFable')) return 0;
  if (label === t('quota.service.window.fiveHour') || /5.hour|5h/i.test(label)) return 1;
  if (label === t('quota.service.window.sevenDay') || label === t('quota.service.weekly')) return 2;
  return 3;
}

export function ledgerWindows(accounts: AuthFile[], quotas: Record<string, QuotaState>) {
  return [...new Set(accounts.flatMap(file => quotas[quotaKey(file)]?.rows.map(row => row.label) ?? []))]
    .sort((a, b) => windowRank(a) - windowRank(b));
}

export function summarizeWindow(accounts: AuthFile[], quotas: Record<string, QuotaState>, label: string) {
  const rows = accounts.map(file => {
    const quota = quotas[quotaKey(file)];
    // Disabled accounts and failed/loading snapshots must not inflate usable totals.
    return !authFileHealth(file).disabled && quota?.status === 'success'
      ? quota.rows.find(row => row.label === label) : undefined;
  });
  const values = rows.map(row => remaining(row?.remainingPercent));
  const reported = values.filter((value): value is number => value !== null);
  const resets = rows.flatMap(row => typeof row?.resetAtMs === 'number' && Number.isFinite(row.resetAtMs) ? [row.resetAtMs] : []);
  return {
    label, rows, values, reported: reported.length, accounts: accounts.length,
    total: reported.length ? Math.round(reported.reduce((sum, value) => sum + value, 0)) : null,
    capacity: reported.length * 100,
    resetAt: resets.length ? Math.min(...resets) : undefined,
  };
}

export function summaryWindows(accounts: AuthFile[], quotas: Record<string, QuotaState>) {
  const labels = ledgerWindows(accounts, quotas);
  const weekly = labels.filter(label => /week|7.day|7\s*天|7\s*日|週|周/i.test(label));
  const ordered = weekly.length ? [...weekly, ...labels.filter(label => !weekly.includes(label))] : labels;
  return ordered.map(label => summarizeWindow(accounts, quotas, label));
}

export function orderedQuotaRows(rows: QuotaRow[], columns?: string[]): QuotaRow[] {
  if (!columns?.length) return [...rows].sort((a, b) => windowRank(a.label) - windowRank(b.label));
  return [...columns.map(label => rows.find(row => row.label === label) ?? { label, remainingPercent: null }),
    ...rows.filter(row => !columns.includes(row.label))];
}

/** The window that decides an account's state: a blocker if any, otherwise the lowest remaining. */
export function primaryQuotaRow(rows: QuotaRow[], blockers: QuotaRow[]): QuotaRow | undefined {
  const lowest = rows.reduce<QuotaRow | undefined>((best, row) => {
    const value = remaining(row.remainingPercent);
    if (value === null) return best;
    const bestValue = best ? remaining(best.remainingPercent) : null;
    return bestValue === null || value < bestValue ? row : best;
  }, undefined);
  return blockers.find(row => rows.includes(row)) ?? lowest ?? rows[0];
}

export const quotaTone = (percent: number | null): 'critical' | 'low' | 'healthy' | 'unknown' =>
  percent === null ? 'unknown' : percent < 15 ? 'critical' : percent < 50 ? 'low' : 'healthy';

export function quotaPercentLeft(row: QuotaRow | undefined): { percent: number; tone: 'critical' | 'low' | 'healthy' } | null {
  const percent = remaining(row?.remainingPercent);
  return percent === null ? null : { percent, tone: quotaTone(percent) as 'critical' | 'low' | 'healthy' };
}
