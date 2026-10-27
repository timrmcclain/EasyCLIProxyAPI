import { describe, expect, it } from 'bun:test';
import type { AttentionItem } from '../src/services/homeGlance';
import { miniProviders } from '../src/services/miniSummary';
import { quotaKey, type AuthFile, type QuotaState } from '../src/services/quotaService';

const file = (name: string, provider = 'claude'): AuthFile => ({ name: `${name}.json`, auth_index: name, provider });
const item = (f: AuthFile, severity: AttentionItem['severity'], percent: number | null = null, resetAt?: number): AttentionItem => ({ file: f, severity, percent, resetAt });
const quota = (percent: number): QuotaState => ({ status: 'success', rows: [{ label: 'Weekly', remainingPercent: percent }] } as QuotaState);
const providerOf = (f: AuthFile) => String(f.provider);
const names = { claude: 'Claude', codex: 'Codex' };

describe('mini window providers', () => {
  it('gives one segment per account, best quota left, and the worst provider first', () => {
    const a = file('a'), b = file('b'), c = file('c'), x = file('x', 'codex');
    const result = miniProviders([x, a, b, c], [item(a, 'blocked', 0, 9000), item(b, 'low', 8)],
      { [quotaKey(c)]: quota(62), [quotaKey(b)]: quota(8), [quotaKey(x)]: quota(90) }, providerOf, names);
    expect(result.map(provider => provider.name)).toEqual(['Claude', 'Codex']);
    expect(result[0].accounts).toEqual([{ state: 'ok', percent: 62 }, { state: 'low', percent: 8 }, { state: 'out', percent: 0 }]);
    expect(result[0].percent).toBe(62);
    expect(result[1]).toMatchObject({ percent: 90, accounts: [{ state: 'ok', percent: 90 }] });
  });
  it('says when a provider whose accounts are all out comes back', () => {
    const a = file('a'), b = file('b');
    const [claude] = miniProviders([a, b], [item(a, 'blocked', 0, 9000), item(b, 'blocked', 0, 4000)], {}, providerOf, names);
    expect(claude).toMatchObject({ percent: null, resetAt: 4000 });
    expect(claude.accounts.every(account => account.state === 'out')).toBe(true);
  });
  it('leaves out accounts that are not confirmed yet', () => {
    const a = file('a'), b = file('b');
    const [claude] = miniProviders([a, b], [item(a, 'unconfirmed')], {}, providerOf, names);
    expect(claude.accounts).toEqual([{ state: 'ok', percent: null }]);
  });
});
