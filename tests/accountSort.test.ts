import { describe, expect, it } from 'bun:test';
import { sortAccounts } from '../src/services/accountSort';
import type { AuthFile, QuotaState } from '../src/services/quotaService';

const now = 1_000_000_000_000;
const H = 3_600_000;
const file = (name: string, provider: string, extra: Partial<AuthFile> = {}): AuthFile => ({ name: `${name}.json`, auth_index: name, provider, status: 'active', ...extra });
const quota = (left: number, resetIn: number): QuotaState => ({
  status: 'success',
  fetchedAt: now,
  rows: [{ label: '5h', scope: 'account', windowId: 'five_hour', remainingPercent: left, resetAtMs: now + resetIn * H }],
});

// Routing order as the proxy returns it.
const a = file('a', 'codex'), b = file('b', 'claude'), c = file('c', 'claude'), off = file('off', 'antigravity', { disabled: true });
const files = [a, b, c, off];
const quotas: Record<string, QuotaState> = { a: quota(80, 4), b: quota(0, 2), c: quota(30, 1), off: quota(100, 3) };
const sorted = (mode: Parameters<typeof sortAccounts>[1]) =>
  sortAccounts(files, mode, f => String(f.provider), f => quotas[String(f.auth_index)], now).map(f => f.auth_index);

describe('sortAccounts', () => {
  it('keeps routing order by default', () => {
    expect(sorted('routing')).toEqual(['a', 'b', 'c', 'off']);
  });
  it('groups by provider, keeping routing order inside each provider', () => {
    expect(sorted('provider')).toEqual(['off', 'b', 'c', 'a']);
  });
  it('puts accounts that ran out first and switched-off accounts last', () => {
    expect(sorted('status')).toEqual(['b', 'a', 'c', 'off']);
  });
  it('orders by least quota left, and by soonest reset', () => {
    expect(sorted('quota')).toEqual(['b', 'c', 'a', 'off']);
    expect(sorted('reset')).toEqual(['c', 'b', 'off', 'a']);
  });
  it('puts accounts with no quota reading after those with one', () => {
    const unread = file('u', 'claude');
    const order = sortAccounts([unread, ...files], 'quota', f => String(f.provider), f => quotas[String(f.auth_index)], now);
    expect(order.at(-1)?.auth_index).toBe('u');
  });
});
