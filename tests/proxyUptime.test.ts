import { describe, expect, it } from 'bun:test';
import { recordProxyCheck, summarizeUptime } from '../src/services/proxyUptime';

const MIN = 60_000;
const up = { ready: true, starting: false };
const down = { ready: false, starting: false };
const starting = { ready: false, starting: true };

describe('proxy uptime', () => {
  it('counts checks into 10-minute buckets', () => {
    const base = Date.UTC(2026, 9, 10, 12, 0);
    let history = recordProxyCheck([], up, base);
    history = recordProxyCheck(history, up, base + 5 * MIN);
    history = recordProxyCheck(history, down, base + 9 * MIN);
    history = recordProxyCheck(history, up, base + 11 * MIN);
    expect(history).toEqual([{ at: base, up: 2, down: 1 }, { at: base + 10 * MIN, up: 1, down: 0 }]);
  });

  it('ignores a proxy that is still starting, and treats no answer as down', () => {
    const base = Date.UTC(2026, 9, 10, 12, 0);
    expect(recordProxyCheck([], starting, base)).toEqual([]);
    expect(recordProxyCheck([], null, base)).toEqual([{ at: base, up: 0, down: 1 }]);
  });

  it('drops checks older than a week', () => {
    const base = Date.UTC(2026, 9, 10, 12, 0);
    const old = recordProxyCheck([], up, base - 8 * 24 * 60 * MIN);
    expect(recordProxyCheck(old, up, base)).toEqual([{ at: base, up: 1, down: 0 }]);
  });

  it('summarizes uptime and counts separate outages', () => {
    const base = new Date(2026, 9, 10, 12, 0).getTime();
    const history = [
      { at: base - 40 * MIN, up: 20, down: 0 },
      { at: base - 30 * MIN, up: 0, down: 20 },
      { at: base - 20 * MIN, up: 20, down: 0 },
      { at: base - 10 * MIN, up: 0, down: 20 },
      { at: base, up: 20, down: 0 },
    ];
    const summary = summarizeUptime(history, base + MIN);
    expect(summary.percent).toBeCloseTo(60);
    expect(summary.outages).toBe(2);
    expect(summary.days).toHaveLength(7);
    expect(summary.days[6].percent).toBeCloseTo(60);
    expect(summary.days[0].percent).toBeNull();
  });

  it('counts a short outage inside a bucket that was otherwise up', () => {
    const base = new Date(2026, 9, 10, 12, 0).getTime();
    const history = [{ at: base - 10 * MIN, up: 10, down: 10 }, { at: base, up: 20, down: 0 }];
    expect(summarizeUptime(history, base + MIN).outages).toBe(1);
    // A single failed check is a restart, not an outage.
    expect(summarizeUptime([{ at: base, up: 19, down: 1 }], base + MIN).outages).toBe(0);
  });

  it('has no figure before any check', () => {
    expect(summarizeUptime([], Date.now()).percent).toBeNull();
  });
});
