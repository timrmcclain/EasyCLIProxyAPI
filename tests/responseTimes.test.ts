import { describe, expect, it } from 'bun:test';
import { formatDuration, modelTimings, type TimedRequest } from '../src/services/responseTimes';

const req = (model: string, latency: number, ttft: number | null = null): TimedRequest => ({ model, latency_ms: latency, ttft_ms: ttft });

describe('response times by model', () => {
  it('reports median, 95th percentile and time to first token, busiest model first', () => {
    const requests = [
      ...[100, 200, 300, 400, 500, 600, 700, 800, 900, 10_000].map((ms, i) => req('opus', ms, i < 5 ? 50 * (i + 1) : null)),
      req('haiku', 50), req('haiku', 60), req('haiku', 70),
    ];
    expect(modelTimings(requests)).toEqual([
      { model: 'opus', count: 10, medianMs: 500, p95Ms: 10_000, ttftMedianMs: 150 },
      { model: 'haiku', count: 3, medianMs: 60, p95Ms: 70, ttftMedianMs: null },
    ]);
  });

  it('skips models with too few requests and requests without a duration', () => {
    expect(modelTimings([req('rare', 100), req('rare', 200), req('opus', 0), req('opus', Number.NaN)])).toEqual([]);
  });

  it('formats durations for reading', () => {
    expect([formatDuration(820), formatDuration(4300), formatDuration(42_000), formatDuration(125_000)]).toEqual(['820 ms', '4.3 s', '42 s', '2m 5s']);
    // Rounding near a whole minute never shows "60s".
    expect([formatDuration(59_999), formatDuration(119_600)]).toEqual(['1m 0s', '2m 0s']);
  });
});
