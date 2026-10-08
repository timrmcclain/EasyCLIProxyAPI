import { describe, expect, it } from 'bun:test';

// The service module imports the Tauri bridge, which only needs to resolve, not run, here.
import { dailySavings, lifetimeSavingsPercent } from '../src/services/compression';

describe('compression savings', () => {
  const now = new Date(2026, 9, 8, 15, 0, 0);

  it('buckets saved tokens by local day and keeps empty days', () => {
    const days = dailySavings(
      [
        { timestamp: new Date(2026, 9, 8, 9, 0).toISOString(), total_tokens_saved: 1000, compression_savings_usd: 0.5 },
        { timestamp: new Date(2026, 9, 8, 14, 0).toISOString(), total_tokens_saved: 250, compression_savings_usd: 0.1 },
        { timestamp: new Date(2026, 9, 6, 12, 0).toISOString(), total_tokens_saved: 40 },
        { timestamp: new Date(2026, 8, 1, 12, 0).toISOString(), total_tokens_saved: 99999 },
        { timestamp: 'not a date', total_tokens_saved: 7 },
      ],
      3,
      now,
    );
    expect(days.map((day) => day.day)).toEqual(['2026-10-06', '2026-10-07', '2026-10-08']);
    expect(days.map((day) => day.tokens)).toEqual([40, 0, 1250]);
    expect(days[2].usd).toBeCloseTo(0.6);
  });

  it('reports the share of input removed, or nothing before any traffic', () => {
    expect(lifetimeSavingsPercent({ tokens_saved: 10437, total_input_tokens: 9152 })).toBeCloseTo(53.28, 1);
    expect(lifetimeSavingsPercent({ tokens_saved: 0, total_input_tokens: 0 })).toBeNull();
    expect(lifetimeSavingsPercent(undefined)).toBeNull();
  });
});
