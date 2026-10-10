import { describe, expect, it } from 'bun:test';
import { providerRunways, upcomingResets } from '../src/services/quotaRunway';
import { quotaKey, type QuotaState } from '../src/services/quotaService';
import type { QuotaSample } from '../src/services/quotaForecast';

const now = Date.parse('2026-10-09T12:00:00Z');
const H = 3_600_000;
const file = (name: string, provider = 'claude', extra: Record<string, unknown> = {}) =>
  ({ name: `${name}.json`, auth_index: name, provider, status: 'active', disabled: false, ...extra });
const quota = (rows: Array<{ label: string; remainingPercent: number | null; resetAtMs?: number }>): QuotaState => ({
  status: 'success', fetchedAt: now, rows: rows.map(row => ({ scope: 'account' as const, ...row })),
});
/** A falling series ending now at `percent`, losing `perHour` points an hour. */
const falling = (percent: number, perHour: number, resetAt?: number): QuotaSample[] =>
  [2, 1, 0].map(hoursAgo => ({ at: now - hoursAgo * H, percent: percent + perHour * hoursAgo, window: 'w', resetAt }));
const providerOf = (f: Record<string, unknown>) => String(f.provider);

describe('provider runway', () => {
  it('lasts until reset when any account outlasts its window at the current pace', () => {
    const a = file('a'), b = file('b');
    const quotas = {
      [quotaKey(a)]: quota([{ label: 'w', remainingPercent: 10, resetAtMs: now + 48 * H }]),
      [quotaKey(b)]: quota([{ label: 'w', remainingPercent: 90, resetAtMs: now + 2 * H }]),
    };
    const history = { [quotaKey(a)]: falling(10, 5, now + 48 * H), [quotaKey(b)]: falling(90, 1, now + 2 * H) };
    expect(providerRunways([a, b], quotas, history, now, false, providerOf)).toEqual([
      { provider: 'claude', kind: 'lasts', accounts: 2 },
    ]);
  });

  it('runs out at the latest account empty time when every account runs out first', () => {
    const a = file('a'), b = file('b');
    const quotas = {
      [quotaKey(a)]: quota([{ label: 'w', remainingPercent: 10, resetAtMs: now + 48 * H }]),
      [quotaKey(b)]: quota([{ label: 'w', remainingPercent: 30, resetAtMs: now + 48 * H }]),
    };
    const history = { [quotaKey(a)]: falling(10, 5, now + 48 * H), [quotaKey(b)]: falling(30, 10, now + 48 * H) };
    const [runway] = providerRunways([a, b], quotas, history, now, false, providerOf);
    expect(runway.kind).toBe('runsOut');
    expect(runway.kind === 'runsOut' && runway.emptyAt).toBe(now + 3 * H);
  });

  it('reports all out with the first account back when every account is blocked', () => {
    const a = file('a', 'codex'), b = file('b', 'codex');
    const quotas = {
      [quotaKey(a)]: quota([{ label: 'w', remainingPercent: 0, resetAtMs: now + 5 * H }]),
      [quotaKey(b)]: quota([{ label: 'w', remainingPercent: 0, resetAtMs: now + 2 * H }]),
    };
    expect(providerRunways([a, b], quotas, {}, now, false, providerOf)).toEqual([
      { provider: 'codex', kind: 'allOut', accounts: 2, backAt: now + 2 * H },
    ]);
  });

  it('says unknown until there is enough history, and skips disabled accounts', () => {
    const a = file('a'), off = file('off', 'claude', { disabled: true });
    const quotas = { [quotaKey(a)]: quota([{ label: 'w', remainingPercent: 50, resetAtMs: now + 48 * H }]) };
    const history = { [quotaKey(a)]: [{ at: now - 60_000, percent: 50, window: 'w' }] };
    expect(providerRunways([a, off], quotas, history, now, false, providerOf)).toEqual([
      { provider: 'claude', kind: 'unknown', accounts: 1 },
    ]);
  });

  it('says unconfirmed when no account is confirmed available, and puts the worst provider first', () => {
    const c = file('c', 'claude'), d = file('d', 'devin'), x = file('x', 'codex');
    const quotas = { [quotaKey(x)]: quota([{ label: 'w', remainingPercent: 0, resetAtMs: now + H }]) };
    expect(providerRunways([d, c, x], quotas, {}, now, false, providerOf).map(r => [r.provider, r.kind])).toEqual([
      ['codex', 'allOut'], ['devin', 'unconfirmed'], ['claude', 'unconfirmed'],
    ]);
  });
});

describe('upcoming resets', () => {
  it('lists partly used windows soonest first, skipping full ones and past resets', () => {
    const a = file('a'), b = file('b', 'codex');
    const quotas = {
      [quotaKey(a)]: quota([
        { label: '5-hour window', remainingPercent: 40, resetAtMs: now + 2 * H },
        { label: '7-day window', remainingPercent: 100, resetAtMs: now + 90 * H },
      ]),
      [quotaKey(b)]: quota([
        { label: 'Weekly', remainingPercent: 5, resetAtMs: now + 30 * H },
        { label: 'Old', remainingPercent: 5, resetAtMs: now - H },
      ]),
    };
    const resets = upcomingResets([a, b], quotas, now, 5);
    expect(resets.map(reset => [reset.file.name, reset.label, reset.at, reset.percent])).toEqual([
      ['a.json', '5-hour window', now + 2 * H, 40],
      ['b.json', 'Weekly', now + 30 * H, 5],
    ]);
  });

  it('keeps only the soonest few', () => {
    const files = [1, 2, 3, 4].map(n => file(`f${n}`));
    const quotas = Object.fromEntries(files.map((f, i) => [quotaKey(f), quota([{ label: 'w', remainingPercent: 50, resetAtMs: now + (4 - i) * H }])]));
    expect(upcomingResets(files, quotas, now, 2).map(reset => reset.file.name)).toEqual(['f4.json', 'f3.json']);
  });
});
