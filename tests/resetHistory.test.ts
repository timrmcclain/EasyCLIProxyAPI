import { describe, expect, it } from 'bun:test';
import { recordResetHistory, summarizeResets, type ResetHistory } from '../src/services/resetHistory';
import { quotaKey, type QuotaState } from '../src/services/quotaService';

const H = 3_600_000;
const D = 24 * H;
const file = { name: 'a.json', provider: 'claude', type: 'claude' };
const key = quotaKey(file);
const start = Date.parse('2030-01-01T00:00:00Z');
const check = (at: number, remaining: number, resetAt: number): QuotaState => ({
  status: 'success', fetchedAt: at,
  rows: [{ label: 'Weekly limit', scope: 'account', windowId: 'seven_day', remainingPercent: remaining, resetAtMs: resetAt }],
});
const run = (checks: QuotaState[], history: ResetHistory = {}) =>
  checks.reduce((current, quota) => recordResetHistory(current, [file], { [key]: quota }, quota.fetchedAt!), history);

describe('quota reset history', () => {
  it('records how much of a window was used once a later check shows the next window', () => {
    const history = run([
      check(start, 90, start + 2 * D),
      check(start + D, 30, start + 2 * D + 60_000), // reset time drifts a minute: same window
      check(start + 2 * D + H, 100, start + 9 * D), // the next window
    ]);
    expect(history[key].completed).toEqual([{ window: 'seven_day', label: 'Weekly limit', endedAt: start + 2 * D + 60_000, used: 70 }]);
  });

  it('does not count a window as ended before its reset time has passed', () => {
    const history = run([check(start, 80, start + 2 * D), check(start + H, 70, start + 5 * D)]);
    expect(history[key].completed).toEqual([]);
  });

  it('summarizes resets, average use and run-outs, and forgets windows older than 4 weeks', () => {
    const now = start + 40 * D;
    const history: ResetHistory = { [key]: { open: [], completed: [
      { window: 'seven_day', label: 'Weekly limit', endedAt: start, used: 50 }, // over 4 weeks old
      { window: 'seven_day', label: 'Weekly limit', endedAt: now - 14 * D, used: 100 },
      { window: 'seven_day', label: 'Weekly limit', endedAt: now - 7 * D, used: 60 },
    ] } };
    expect(summarizeResets(history[key], now)).toEqual([{ label: 'Weekly limit', resets: 2, averageUsed: 80, ranOut: 1 }]);
  });

  it('keeps tracking through a failed check instead of losing the open window', () => {
    const failed: QuotaState = { status: 'error', rows: [], fetchedAt: start + H };
    const history = run([check(start, 40, start + D), failed, check(start + D + H, 100, start + 8 * D)]);
    expect(history[key].completed.map(entry => entry.used)).toEqual([60]);
  });
});
