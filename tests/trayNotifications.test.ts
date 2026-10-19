import { describe, expect, it } from 'bun:test';
import { batchNotifications, trayQuotaLevel } from '../src/services/quotaWatcher';

const tally = (total: number, low: number, blocked: number) => ({ provider: 'claude', total, low, blocked });
const message = (n: number) => ({ title: `Alert ${n}`, body: '' });
const more = (count: number) => ({ title: `And ${count} more`, body: '' });

describe('tray dot', () => {
  it('is "out" when every account of some provider is out', () => {
    expect(trayQuotaLevel([tally(2, 0, 2), tally(3, 0, 0)])).toBe('out');
  });
  it('is "low" when any account is low or out but each provider still has one', () => {
    expect(trayQuotaLevel([tally(2, 0, 1)])).toBe('low');
    expect(trayQuotaLevel([tally(2, 1, 0)])).toBe('low');
  });
  it('is "ok" otherwise', () => {
    expect(trayQuotaLevel([tally(2, 0, 0)])).toBe('ok');
    expect(trayQuotaLevel([])).toBe('ok');
  });
});

describe('notification batches', () => {
  it('sends up to three as they are', () => {
    expect(batchNotifications([message(1), message(2), message(3)], more)).toEqual([message(1), message(2), message(3)]);
  });
  it('says how many more instead of dropping the rest', () => {
    expect(batchNotifications([1, 2, 3, 4, 5].map(message), more)).toEqual([message(1), message(2), more(3)]);
  });
});
