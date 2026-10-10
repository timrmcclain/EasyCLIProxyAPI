import { forecastQuota, type QuotaHistory } from './quotaForecast';
import { quotaAvailability } from './quotaAvailability';
import { orderedQuotaRows, primaryQuotaRow } from './quotaLedger';
import { quotaKey, type AuthFile, type QuotaState } from './quotaService';

export type ProviderRunway =
  /** At least one account outlasts its window at the current pace. */
  | { provider: string; kind: 'lasts'; accounts: number }
  /** Every account runs out before it resets; the proxy fails over, so work stops at the last one. */
  | { provider: string; kind: 'runsOut'; accounts: number; emptyAt: number }
  | { provider: string; kind: 'allOut'; accounts: number; backAt?: number }
  /** No account is confirmed available: each one is blocked or its availability is unknown. */
  | { provider: string; kind: 'unconfirmed'; accounts: number }
  /** Not enough readings yet to judge the pace. */
  | { provider: string; kind: 'unknown'; accounts: number };

type AccountRunway = { kind: 'blocked'; backAt?: number } | { kind: 'unconfirmed' } | { kind: 'lasts' } | { kind: 'runsOut'; emptyAt: number } | { kind: 'unknown' };

const blockedKinds = ['exhausted', 'unavailable', 'limited', 'resetDue'];

function accountRunway(file: AuthFile, quota: QuotaState | undefined, history: QuotaHistory, now: number, stale: boolean): AccountRunway {
  const state = quotaAvailability(file, quota, now, stale);
  if (blockedKinds.includes(state.kind)) {
    const primary = primaryQuotaRow(orderedQuotaRows(quota?.rows ?? []), state.blockers);
    const backAt = state.recoveryAt ?? (primary?.resetAtMs && primary.resetAtMs > now ? primary.resetAtMs : undefined);
    return { kind: 'blocked', backAt };
  }
  if (state.kind !== 'available') return { kind: 'unconfirmed' };
  const forecast = forecastQuota(history[quotaKey(file)], now);
  if (forecast.kind === 'runsOut') return { kind: 'runsOut', emptyAt: forecast.emptyAt };
  if (forecast.kind === 'unknown') return { kind: 'unknown' };
  return { kind: 'lasts' };
}

/** How long each provider can keep serving at the current pace, across all its enabled accounts. */
export function providerRunways(
  files: AuthFile[],
  quotas: Record<string, QuotaState>,
  history: QuotaHistory,
  now: number,
  stale: boolean,
  providerOf: (file: AuthFile) => string,
): ProviderRunway[] {
  const byProvider = new Map<string, AccountRunway[]>();
  for (const file of files) {
    if (file.disabled === true) continue;
    const provider = providerOf(file);
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), accountRunway(file, quotas[quotaKey(file)], history, now, stale)]);
  }
  return [...byProvider].map(([provider, runways]): ProviderRunway => {
    const accounts = runways.length;
    if (runways.some(runway => runway.kind === 'lasts')) return { provider, kind: 'lasts', accounts };
    if (runways.every(runway => runway.kind === 'blocked')) {
      const backs = runways.flatMap(runway => (runway.kind === 'blocked' && runway.backAt ? [runway.backAt] : []));
      return { provider, kind: 'allOut', accounts, ...(backs.length ? { backAt: Math.min(...backs) } : {}) };
    }
    if (runways.every(runway => runway.kind === 'blocked' || runway.kind === 'unconfirmed')) return { provider, kind: 'unconfirmed', accounts };
    if (runways.some(runway => runway.kind === 'unknown')) return { provider, kind: 'unknown', accounts };
    const empties = runways.flatMap(runway => (runway.kind === 'runsOut' ? [runway.emptyAt] : []));
    return { provider, kind: 'runsOut', accounts, emptyAt: Math.max(...empties) };
  }).sort((a, b) => runwayRank[a.kind] - runwayRank[b.kind] || emptyOf(a) - emptyOf(b));
}

/** Worst first, matching the Needs attention tile. */
const runwayRank: Record<ProviderRunway['kind'], number> = { allOut: 0, runsOut: 1, unconfirmed: 2, unknown: 3, lasts: 4 };
const emptyOf = (runway: ProviderRunway) => (runway.kind === 'runsOut' ? runway.emptyAt : 0);

export type UpcomingReset = { file: AuthFile; label: string; at: number; percent: number };

/** The soonest window resets that will actually give something back (partly used windows only). */
export function upcomingResets(files: AuthFile[], quotas: Record<string, QuotaState>, now: number, limit: number): UpcomingReset[] {
  return files
    .filter(file => file.disabled !== true)
    .flatMap(file => (quotas[quotaKey(file)]?.rows ?? []).flatMap((row): UpcomingReset[] => {
      const percent = row.remainingPercent;
      if (row.scope === 'paid' || typeof percent !== 'number' || percent >= 100) return [];
      if (!row.resetAtMs || row.resetAtMs <= now) return [];
      return [{ file, label: row.label, at: row.resetAtMs, percent }];
    }))
    .sort((a, b) => a.at - b.at)
    .slice(0, limit);
}
