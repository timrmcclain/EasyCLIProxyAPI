import type { AttentionItem } from './homeGlance';
import { primaryQuotaRow, quotaPercentLeft } from './quotaLedger';
import { quotaKey, type AuthFile, type QuotaState } from './quotaService';

export type MiniAccountState = 'ok' | 'low' | 'out';
export type MiniAccount = { state: MiniAccountState; percent: number | null };
/** One provider in the mini window: a bar with one segment per account, and the best quota left among them. */
export type MiniProvider = { provider: string; name: string; accounts: MiniAccount[]; percent: number | null; resetAt?: number };

const stateRank: Record<MiniAccountState, number> = { ok: 0, low: 1, out: 2 };

/**
 * What the mini window draws per provider, worst provider first (all out, then some out, then low, then fine).
 * Accounts not confirmed yet are left out, as in the tray's tallies; an out account counts as 0% left.
 */
export function miniProviders(files: AuthFile[], attention: AttentionItem[], quotas: Record<string, QuotaState>,
  providerOf: (file: AuthFile) => string, names: Record<string, string>): MiniProvider[] {
  const byKey = new Map(attention.map(item => [quotaKey(item.file), item]));
  const providers = new Map<string, MiniProvider>();
  for (const file of files) {
    const key = quotaKey(file);
    const item = byKey.get(key);
    if (item?.severity === 'unconfirmed') continue;
    const id = providerOf(file);
    const entry = providers.get(id) ?? { provider: id, name: names[id] ?? id, accounts: [], percent: null };
    const state: MiniAccountState = item?.severity === 'blocked' ? 'out' : item?.severity === 'low' ? 'low' : 'ok';
    const left = quotaPercentLeft(primaryQuotaRow(quotas[key]?.rows ?? [], []))?.percent ?? item?.percent ?? null;
    const percent = state === 'out' ? 0 : left;
    entry.accounts.push({ state, percent });
    if (state !== 'out' && percent !== null) entry.percent = Math.max(entry.percent ?? 0, percent);
    if (state === 'out' && item?.resetAt !== undefined) entry.resetAt = Math.min(entry.resetAt ?? Infinity, item.resetAt);
    providers.set(id, entry);
  }
  const rank = (entry: MiniProvider) => {
    const out = entry.accounts.filter(account => account.state === 'out').length;
    return out === entry.accounts.length ? 0 : out ? 1 : entry.accounts.some(account => account.state === 'low') ? 2 : 3;
  };
  return [...providers.values()]
    .map(entry => ({ ...entry, accounts: [...entry.accounts].sort((a, b) => stateRank[a.state] - stateRank[b.state] || (b.percent ?? -1) - (a.percent ?? -1)) }))
    .sort((a, b) => rank(a) - rank(b));
}
