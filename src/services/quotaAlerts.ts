import type { AttentionItem } from './homeGlance';
import { quotaKey, type AuthFile } from './quotaService';

export type AccountLevel = 'ok' | 'low' | 'blocked';
export type AlertMemory = { accounts: Record<string, AccountLevel>; exhaustedProviders: string[] };
export type QuotaAlert = {
  kind: 'low' | 'blocked' | 'providerExhausted' | 'recovered';
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
    if (item?.severity === 'unconfirmed') continue;
    const level: AccountLevel = item?.severity === 'blocked' ? 'blocked' : item?.severity === 'low' ? 'low' : 'ok';
    accounts[key] = level;
    const provider = providerOf(file);
    const counts = providers.get(provider) ?? { total: 0, blocked: 0 };
    providers.set(provider, { total: counts.total + 1, blocked: counts.blocked + (level === 'blocked' ? 1 : 0) });

    const before = previous?.accounts[key];
    if (!previous || before === undefined || before === level) continue;
    const base = { key, account: labelFor(file), provider, percent: item?.percent, resetAt: item?.resetAt };
    if (level === 'blocked') alerts.push({ kind: 'blocked', ...base });
    else if (level === 'low' && before === 'ok') alerts.push({ kind: 'low', ...base });
    else if (level === 'ok' && before === 'blocked') alerts.push({ kind: 'recovered', ...base });
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
    alerts: alerts.filter(a => a.kind === 'providerExhausted' || a.kind === 'recovered' || !silenced.has(a.provider)),
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
