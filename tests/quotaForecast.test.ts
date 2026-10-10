import { describe, expect, it } from 'bun:test';
import { forecastQuota, recordQuotaSamples, type QuotaSample } from '../src/services/quotaForecast';
import { quotaKey, type QuotaState } from '../src/services/quotaService';

const HOUR = 3_600_000;
const now = Date.parse('2026-10-09T12:00:00Z');
const file = { name: 'a.json', auth_index: 'a', provider: 'claude', status: 'active', disabled: false };
const key = quotaKey(file);
const quota = (percent: number, at: number, label = '5-hour window', resetAtMs = now + 10 * HOUR): QuotaState => ({
  status: 'success', fetchedAt: at, rows: [{ scope: 'account', label, remainingPercent: percent, resetAtMs }],
});
const series = (points: Array<[hoursAgo: number, percent: number]>, resetAt?: number): QuotaSample[] =>
  points.map(([ago, percent]) => ({ at: now - ago * HOUR, percent, window: 'w', resetAt }));

describe('recording samples', () => {
  it('adds one sample per new fetch and ignores repeats of the same fetch', () => {
    let history = recordQuotaSamples({}, [file], { [key]: quota(80, now - HOUR) }, now);
    history = recordQuotaSamples(history, [file], { [key]: quota(80, now - HOUR) }, now);
    history = recordQuotaSamples(history, [file], { [key]: quota(70, now) }, now);
    expect(history[key].map(s => s.percent)).toEqual([80, 70]);
  });
  it('starts a fresh series after a reset or a change of window', () => {
    let history = recordQuotaSamples({}, [file], { [key]: quota(20, now - 2 * HOUR) }, now);
    history = recordQuotaSamples(history, [file], { [key]: quota(95, now - HOUR) }, now);
    expect(history[key].map(s => s.percent)).toEqual([95]);
    history = recordQuotaSamples(history, [file], { [key]: quota(60, now, '7-day window') }, now);
    expect(history[key].map(s => s.window)).toEqual(['7-day window']);
  });
  it('drops samples older than 12 hours and keeps failed fetches out', () => {
    const history = recordQuotaSamples({ [key]: series([[13, 90], [1, 50]]) }, [file], { [key]: { status: 'error', rows: [] } }, now);
    expect(history[key].map(s => s.percent)).toEqual([50]);
  });
});

describe('forecast', () => {
  it('needs at least two readings 20 minutes apart', () => {
    expect(forecastQuota(series([[0, 50]]), now).kind).toBe('unknown');
    expect(forecastQuota(series([[0.1, 52], [0, 50]]), now).kind).toBe('unknown');
  });
  it('predicts running out before the reset at a steady pace', () => {
    const forecast = forecastQuota(series([[2, 50], [1, 40], [0, 30]], now + 10 * HOUR), now);
    expect(forecast.kind).toBe('runsOut');
    if (forecast.kind !== 'runsOut') return;
    expect(forecast.ratePerHour).toBeCloseTo(10);
    expect(forecast.emptyAt).toBeCloseTo(now + 3 * HOUR, -3);
  });
  it('says it lasts when the window resets before it would empty', () => {
    const forecast = forecastQuota(series([[2, 50], [1, 40], [0, 30]], now + HOUR), now);
    expect(forecast.kind).toBe('lastsToReset');
  });
  it('treats very light use as steady, and judges pace on the last three hours only', () => {
    expect(forecastQuota(series([[2, 50.4], [0, 50]]), now).kind).toBe('steady');
    const forecast = forecastQuota(series([[8, 100], [2, 40], [1, 39.8], [0, 39.6]]), now);
    expect(forecast.kind).toBe('steady');
  });
});
