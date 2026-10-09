import { describe, expect, it } from 'bun:test';
import { attentionItems, busiestClient, hourlyActivity, parseHourKey } from '../src/services/homeGlance';
import { quotaKey, type QuotaState } from '../src/services/quotaService';

const now = Date.parse('2026-10-09T12:30:00Z');
const file = (name: string, extra: Record<string, unknown> = {}) => ({ name: `${name}.json`, auth_index: name, provider: 'claude', status: 'active', disabled: false, ...extra });
const quota = (rows: Array<{ label: string; remainingPercent: number | null; resetAtMs?: number }>): QuotaState => ({
  status: 'success', fetchedAt: now, rows: rows.map(row => ({ scope: 'account' as const, resetAtMs: now + 86_400_000, ...row })),
});

describe('attention items', () => {
  it('lists blocked accounts first, then ones running low, then unconfirmed ones', () => {
    const healthy = file('healthy'), low = file('low'), blocked = file('blocked'), unknown = file('unknown');
    const quotas = {
      [quotaKey(healthy)]: quota([{ label: '7-day window', remainingPercent: 80, resetAtMs: now + 1000 }]),
      [quotaKey(low)]: quota([{ label: '7-day window', remainingPercent: 7, resetAtMs: now + 4 * 86_400_000 }]),
      [quotaKey(blocked)]: quota([{ label: '7-day window', remainingPercent: 0, resetAtMs: now + 3_600_000 }]),
    };
    const items = attentionItems([healthy, low, unknown, blocked], quotas, now, false);
    expect(items.map(item => [item.file.name, item.severity])).toEqual([['blocked.json', 'blocked'], ['low.json', 'low'], ['unknown.json', 'unconfirmed']]);
    expect(items[1].percent).toBe(7);
    expect(items[1].resetAt).toBe(now + 4 * 86_400_000);
    expect(items[0].resetAt).toBe(now + 3_600_000);
  });
  it('orders accounts running low by how little is left', () => {
    const a = file('a'), b = file('b');
    const quotas = {
      [quotaKey(a)]: quota([{ label: 'w', remainingPercent: 12 }]),
      [quotaKey(b)]: quota([{ label: 'w', remainingPercent: 4 }]),
    };
    expect(attentionItems([a, b], quotas, now, false).map(item => item.file.name)).toEqual(['b.json', 'a.json']);
  });
  it('leaves out disabled accounts and accounts above the low threshold', () => {
    const off = file('off', { disabled: true }), amber = file('amber');
    const quotas = { [quotaKey(amber)]: quota([{ label: 'w', remainingPercent: 30 }]) };
    expect(attentionItems([off, amber], quotas, now, false)).toEqual([]);
  });
});

describe('hourly activity', () => {
  it('returns 24 hourly buckets ending with the current hour, filling gaps with zero', () => {
    const buckets = hourlyActivity([
      { hour: '2026-10-09T12:00:00Z', requests: 9, failure: 1 },
      { hour: '2026-10-09T10:00:00Z', requests: 4, failure: 0 },
      { hour: '2026-10-07T10:00:00Z', requests: 99, failure: 0 },
    ], now);
    expect(buckets).toHaveLength(24);
    expect(buckets[23]).toEqual({ at: Date.parse('2026-10-09T12:00:00Z'), requests: 9, failures: 1 });
    expect(buckets[21].requests).toBe(4);
    expect(buckets[22].requests).toBe(0);
    expect(buckets.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(13);
  });
  it('reads the local half-hour keys the usage store returns and adds both halves of an hour', () => {
    const key = (date: Date, minute: string) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}-${minute}`;
    const current = new Date(now);
    expect(parseHourKey(key(current, '30'))).toBe(new Date(current.getFullYear(), current.getMonth(), current.getDate(), current.getHours(), 30).getTime());
    const buckets = hourlyActivity([{ hour: key(current, '00'), requests: 2, failure: 0 }, { hour: key(current, '30'), requests: 3, failure: 1 }], now);
    expect(buckets[23]).toMatchObject({ requests: 5, failures: 1 });
  });
  it('ignores malformed points', () => {
    expect(hourlyActivity([{ hour: 'nope', requests: 3, failure: 0 }, null as never], now).every(bucket => bucket.requests === 0)).toBe(true);
  });
});

describe('busiest client', () => {
  it('names the app that sent the most recent requests', () => {
    const request = (agent: string) => ({ timestamp: '', model: 'm', user_agent: agent, failed: false, canceled: false });
    expect(busiestClient([request('claude-cli/2'), request('claude-cli/2'), request('codex_cli'), request('claude-desktop')])).toEqual({ client: 'Claude Code CLI', count: 2 });
    expect(busiestClient([request('curl')])).toBeNull();
    expect(busiestClient([])).toBeNull();
  });
});
