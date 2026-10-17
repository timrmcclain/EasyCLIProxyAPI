import { describe, expect, it } from 'bun:test';
import { boostedPriority, focusHoldsProvider, restorePriority, type AccountFocus } from '../src/services/accountFocus';
import type { AuthFile } from '../src/services/quotaService';

const file = (name: string, provider: string, priority: number, disabled = false) => ({ name, provider, priority, disabled }) as unknown as AuthFile;
const focus: AccountFocus = { name: 'a.json', provider: 'claude', originalPriority: 2, boostedPriority: 11, until: 1_000 };

describe('use an account first for an hour', () => {
  it('raises the account just above every other enabled account of its provider', () => {
    const files = [file('a.json', 'claude', 2), file('b.json', 'claude', 10), file('c.json', 'claude', 5), file('x.json', 'codex', 50)];
    expect(boostedPriority(files, files[0])).toBe(11);
  });
  it('ignores disabled accounts and other providers', () => {
    const files = [file('a.json', 'claude', 2), file('b.json', 'claude', 40, true), file('x.json', 'codex', 50)];
    expect(boostedPriority(files, files[0])).toBe(2);
  });
  it('never lowers an account that already ranks highest', () => {
    const files = [file('a.json', 'claude', 30), file('b.json', 'claude', 4)];
    expect(boostedPriority(files, files[0])).toBe(30);
  });
  it('puts the original priority back only if nobody changed it since', () => {
    expect(restorePriority(focus, 11)).toBe(2);
    expect(restorePriority(focus, 7)).toBeNull();
    expect(restorePriority(focus, undefined)).toBeNull();
  });
  it('keeps automatic routing off that provider only until the hour ends', () => {
    expect(focusHoldsProvider(focus, 'claude', 999)).toBe(true);
    expect(focusHoldsProvider(focus, 'claude', 1_000)).toBe(false);
    expect(focusHoldsProvider(focus, 'codex', 500)).toBe(false);
    expect(focusHoldsProvider(null, 'claude', 500)).toBe(false);
  });
});
