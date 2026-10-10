import { describe, expect, it } from 'bun:test';
import { claudeAllOut, fallbackModels } from '../src/services/claudeFallback';
import { quotaKey, type QuotaState } from '../src/services/quotaService';

const now = Date.parse('2026-10-10T12:00:00Z');
const file = (name: string, extra: Record<string, unknown> = {}) =>
  ({ name: `${name}.json`, auth_index: name, provider: 'claude', status: 'active', disabled: false, ...extra });
const quota = (percent: number): QuotaState => ({ status: 'success', fetchedAt: now, rows: [
  { scope: 'account', label: '7-day window', remainingPercent: percent, resetAtMs: now + 86_400_000 },
] });

describe('switching Claude Code while Claude is out', () => {
  it('is only offered when every enabled Claude account is out', () => {
    const a = file('a'), b = file('b'), off = file('off', { disabled: true });
    expect(claudeAllOut([a, b, off], { [quotaKey(a)]: quota(0), [quotaKey(b)]: quota(0) }, now)).toBe(true);
    expect(claudeAllOut([a, b], { [quotaKey(a)]: quota(0), [quotaKey(b)]: quota(30) }, now)).toBe(false);
    expect(claudeAllOut([a], {}, now)).toBe(false);
    expect(claudeAllOut([], {}, now)).toBe(false);
  });

  it('offers only non-Claude models, without duplicates', () => {
    expect(fallbackModels([
      { name: 'claude-opus-5-5' }, { name: 'gpt-5.5' }, { name: 'gemini-3-pro' }, { name: 'gpt-5.5' }, { name: 'x', alias: 'grok-5' },
    ])).toEqual(['gemini-3-pro', 'gpt-5.5', 'grok-5']);
  });
});
