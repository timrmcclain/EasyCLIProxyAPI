import { orderedQuotaRows, primaryQuotaRow } from './quotaLedger';
import { quotaAvailability, type AvailabilityKind } from './quotaAvailability';
import type { AuthFile, QuotaState } from './quotaService';

export const accountSorts = ['routing', 'provider', 'status', 'quota', 'reset'] as const;
export type AccountSort = typeof accountSorts[number];

/** Problems first, switched-off accounts last. */
const statusRank: Record<AvailabilityKind, number> = {
  unavailable: 0, exhausted: 1, resetDue: 1, limited: 2, creditBacked: 2, unknown: 3, available: 4, disabled: 5,
};

/**
 * Reorders the Accounts list. 'routing' keeps the order it arrived in (priority, then file name), and
 * every other order falls back to it for ties, so equal accounts never jump around between refreshes.
 */
export function sortAccounts(
  files: AuthFile[],
  mode: AccountSort,
  providerOf: (file: AuthFile) => string,
  quotaFor: (file: AuthFile) => QuotaState | undefined,
  now: number,
): AuthFile[] {
  if (mode === 'routing') return files;
  const keyed = files.map((file, index) => {
    const quota = quotaFor(file);
    const availability = quotaAvailability(file, quota, now);
    const row = quota?.status === 'success' ? primaryQuotaRow(orderedQuotaRows(quota.rows), availability.blockers) : undefined;
    const resets = (quota?.status === 'success' ? quota.rows : [])
      .map(r => r.resetAtMs).filter((at): at is number => typeof at === 'number' && Number.isFinite(at) && at > now);
    return {
      file, index,
      provider: providerOf(file).toLowerCase(),
      status: statusRank[availability.kind],
      left: typeof row?.remainingPercent === 'number' ? row.remainingPercent : Infinity,
      reset: availability.recoveryAt ?? (resets.length ? Math.min(...resets) : Infinity),
    };
  });
  const compare = {
    provider: (a: typeof keyed[number], b: typeof keyed[number]) => a.provider.localeCompare(b.provider),
    status: (a: typeof keyed[number], b: typeof keyed[number]) => a.status - b.status,
    quota: (a: typeof keyed[number], b: typeof keyed[number]) => a.left - b.left || a.status - b.status,
    reset: (a: typeof keyed[number], b: typeof keyed[number]) => a.reset - b.reset,
  }[mode];
  return keyed.sort((a, b) => (compare(a, b) || a.index - b.index)).map(entry => entry.file);
}
