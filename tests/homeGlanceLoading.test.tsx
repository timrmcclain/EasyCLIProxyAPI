import { describe, expect, it } from 'bun:test';
import { attentionEmptyState } from '../src/components/HomeGlance';

describe('Needs attention before the account list arrives', () => {
  it('says it is loading, not that there are no accounts', () => {
    expect(attentionEmptyState(true, 0, 'loading')).toBe('loading');
  });
  it('says the list could not be loaded when the fetch failed', () => {
    expect(attentionEmptyState(true, 0, 'failed')).toBe('failed');
  });
  it('only says there are no accounts once an empty list has actually arrived', () => {
    expect(attentionEmptyState(true, 0, 'loaded')).toBe('noAccounts');
  });
  it('lists rows once accounts exist, and a stopped proxy outranks everything', () => {
    expect(attentionEmptyState(true, 3, 'loading')).toBeNull();
    expect(attentionEmptyState(false, 0, 'loading')).toBe('proxyDown');
  });
});
