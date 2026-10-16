import type { AttentionItem } from './homeGlance';
import { forecastQuota, type QuotaHistory } from './quotaForecast';
import { quotaKey, type AuthFile } from './quotaService';

export type AccountLevel = 'ok' | 'low' | 'blocked' | 'unavailable';
export type AlertMemory = { accounts: Record<string, AccountLevel>; exhaustedProviders: string[] };
export type QuotaAlert = {
  kind: 'low' | 'blocked' | 'unavailable' | 'providerExhausted' | 'recovered' | 'working';
  key: string;
  account?: string;
  provider: string;
  percent?: number | null;
  resetAt?: number;
};

export const emptyAlertMemory = (): AlertMemory => ({ accounts: {}, exhaustedProviders: [] });

/**
 * Compares this check with the last one and returns only changes worth interrupting for:
 * an account getting low or blocked, every account of a provider blocked, or a blocked account
 * coming back. The first check after start only records the baseline, so opening the app never
 * produces a burst of alerts. Unconfirmed accounts never alert.
 */
export function quotaAlerts(
  previous: AlertMemory | null,
  files: AuthFile[],
  attention: AttentionItem[],
  providerOf: (file: AuthFile) => string,
  labelFor: (file: AuthFile) => string,
): { memory: AlertMemory; alerts: QuotaAlert[] } {
  const byKey = new Map(attention.map(item => [quotaKey(item.file), item]));
  const accounts: Record<string, AccountLevel> = {};
  const alerts: QuotaAlert[] = [];
  const providers = new Map<string, { total: number; blocked: number }>();

  for (const file of files) {
    const key = quotaKey(file);
    const item = byKey.get(key);
    if (item?.severity === 'unconfirmed') {
      // One failed check mustn't erase what was last known, or the change after it (say blocked → ok) goes unnoticed.
      const known = previous?.accounts[key];
      if (known !== undefined) accounts[key] = known;
      continue;
    }
    const level: AccountLevel = item?.severity === 'blocked' ? (item.unavailable ? 'unavailable' : 'blocked') : item?.severity === 'low' ? 'low' : 'ok';
    accounts[key] = level;
    const provider = providerOf(file);
    const counts = providers.get(provider) ?? { total: 0, blocked: 0 };
    providers.set(provider, { total: counts.total + 1, blocked: counts.blocked + (level === 'blocked' || level === 'unavailable' ? 1 : 0) });

    const before = previous?.accounts[key];
    if (!previous || before === undefined || before === level) continue;
    const base = { key, account: labelFor(file), provider, percent: item?.percent, resetAt: item?.resetAt };
    if (level === 'blocked' || level === 'unavailable') alerts.push({ kind: level, ...base });
    else if (level === 'low' && before === 'ok') alerts.push({ kind: 'low', ...base });
    // Coming back from a sign-in problem isn't a quota reset, so it gets its own wording.
    else if (level === 'ok' && before === 'blocked') alerts.push({ kind: 'recovered', ...base });
    else if (level === 'ok' && before === 'unavailable') alerts.push({ kind: 'working', ...base });
  }

  const exhaustedProviders = [...providers].filter(([, c]) => c.total > 0 && c.blocked === c.total).map(([name]) => name);
  if (previous) {
    for (const provider of exhaustedProviders) {
      if (previous.exhaustedProviders.includes(provider)) continue;
      const soonest = attention
        .filter(item => providerOf(item.file) === provider && item.resetAt)
        .reduce<number | undefined>((min, item) => (min === undefined || item.resetAt! < min ? item.resetAt : min), undefined);
      alerts.unshift({ kind: 'providerExhausted', key: `provider:${provider}`, provider, resetAt: soonest });
    }
  }
  // A whole provider going down says it all; don't also list each of its accounts.
  const silenced = new Set(alerts.filter(a => a.kind === 'providerExhausted').map(a => a.provider));
  return {
    memory: { accounts, exhaustedProviders },
    alerts: alerts.filter(a => a.kind === 'providerExhausted' || a.kind === 'recovered' || a.kind === 'working' || !silenced.has(a.provider)),
  };
}

export type ProviderTally = { provider: string; total: number; low: number; blocked: number };

/** Per-provider counts for the tray line, worst providers first. Unconfirmed accounts are left out. */
export function providerTallies(files: AuthFile[], attention: AttentionItem[], providerOf: (file: AuthFile) => string): ProviderTally[] {
  const byKey = new Map(attention.map(item => [quotaKey(item.file), item.severity]));
  const tallies = new Map<string, ProviderTally>();
  for (const file of files) {
    const severity = byKey.get(quotaKey(file));
    if (severity === 'unconfirmed') continue;
    const provider = providerOf(file);
    const tally = tallies.get(provider) ?? { provider, total: 0, low: 0, blocked: 0 };
    tally.total += 1;
    if (severity === 'low') tally.low += 1;
    if (severity === 'blocked') tally.blocked += 1;
    tallies.set(provider, tally);
  }
  const rank = (tally: ProviderTally) => (tally.blocked === tally.total ? 0 : tally.blocked ? 1 : tally.low ? 2 : 3);
  return [...tallies.values()].sort((a, b) => rank(a) - rank(b));
}

/** Which window each account was last warned about, so the pace warning comes once per window. */
export type PaceMemory = Record<string, string>;
export type PaceAlert = { key: string; account: string; provider: string; emptyAt: number; resetAt?: number };

/** Warn this far ahead of an account running out at its recent pace. */
export const PACE_WARNING_MS = 2 * 3_600_000;

/**
 * Accounts that aren't low yet but, at their recent pace, will run out within two hours and before
 * their window resets. Each window warns once; the first check after start only records the baseline.
 */
export function paceAlerts(
  previous: PaceMemory | null,
  files: AuthFile[],
  history: QuotaHistory,
  attention: AttentionItem[],
  now: number,
  providerOf: (file: AuthFile) => string,
  labelFor: (file: AuthFile) => string,
): { memory: PaceMemory; alerts: PaceAlert[] } {
  const severity = new Map(attention.map(item => [quotaKey(item.file), item.severity]));
  const memory: PaceMemory = {};
  const alerts: PaceAlert[] = [];
  for (const file of files) {
    const key = quotaKey(file);
    const samples = history[key];
    const window = samples?.[samples.length - 1]?.window;
    if (!window) continue;
    if (previous?.[key] === window) { memory[key] = window; continue; }
    // Low, blocked or unconfirmed accounts already have their own alerts (or none on purpose).
    if (severity.has(key)) continue;
    const forecast = forecastQuota(samples, now);
    if (forecast.kind !== 'runsOut' || forecast.emptyAt <= now || forecast.emptyAt - now > PACE_WARNING_MS) continue;
    memory[key] = window;
    if (previous) alerts.push({ key, account: labelFor(file), provider: providerOf(file), emptyAt: forecast.emptyAt, resetAt: forecast.resetAt });
  }
  return { memory, alerts };
}
