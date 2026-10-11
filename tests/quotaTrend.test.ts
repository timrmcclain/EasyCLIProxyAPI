import { describe, expect, it } from 'bun:test';
import { recordQuotaTrends, type QuotaTrends } from '../src/services/quotaTrend';
import { quotaKey, type AuthFile, type QuotaState } from '../src/services/quotaService';

const HOUR = 3_600_000;
const file = { name: 'claude-a.json', provider: 'claude' } as unknown as AuthFile;
const quota = (fiveHour: number, weekly: number, at: number, weeklyLabel = '7-day window'): Record<string, QuotaState> => ({
  [quotaKey(file)]: {
    status: 'success', fetchedAt: at,
    rows: [
      { label: '5-hour window', remainingPercent: fiveHour, resetAtMs: at + 2 * HOUR },
      { label: weeklyLabel, remainingPercent: weekly, resetAtMs: at + 90 * HOUR },
    ],
  } as unknown as QuotaState,
});
const key = quotaKey(file);

describe('quota trends', () => {
  it('follows the longest window and keeps one reading per hour', () => {
    let trends: QuotaTrends = {};
    trends = recordQuotaTrends(trends, [file], quota(10, 80, 0), 0);
    trends = recordQuotaTrends(trends, [file], quota(5, 78, 20 * 60_000), 20 * 60_000);
    trends = recordQuotaTrends(trends, [file], quota(90, 70, HOUR + 1), HOUR + 1);
    expect(trends[key]).toEqual({ label: '7-day window', samples: [{ at: 20 * 60_000, percent: 78 }, { at: HOUR + 1, percent: 70 }] });
  });

  it('drops readings older than a week and starts afresh when the window changes', () => {
    let trends = recordQuotaTrends({}, [file], quota(50, 80, 0), 0);
    trends = recordQuotaTrends(trends, [file], quota(50, 60, 8 * 24 * HOUR), 8 * 24 * HOUR);
    expect(trends[key].samples).toEqual([{ at: 8 * 24 * HOUR, percent: 60 }]);
    trends = recordQuotaTrends(trends, [file], quota(50, 55, 8 * 24 * HOUR + 2 * HOUR, 'Weekly Opus'), 8 * 24 * HOUR + 2 * HOUR);
    expect(trends[key]).toEqual({ label: 'Weekly Opus', samples: [{ at: 8 * 24 * HOUR + 2 * HOUR, percent: 55 }] });
  });

  it('keeps the existing line through a failed check, and forgets removed accounts', () => {
    const trends = recordQuotaTrends({}, [file], quota(50, 80, 0), 0);
    const failed = { [key]: { status: 'error', rows: [] } as unknown as QuotaState };
    expect(recordQuotaTrends(trends, [file], failed, HOUR)[key].samples).toHaveLength(1);
    expect(recordQuotaTrends(trends, [], {}, HOUR)).toEqual({});
  });
});
