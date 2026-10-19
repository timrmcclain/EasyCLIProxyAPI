import { describe, expect, it } from 'bun:test';
import { batchNotifications, inQuietHours } from '../src/services/notifications';
import { trayQuotaGauge, trayQuotaLevel } from '../src/services/quotaWatcher';

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

describe('tray gauge', () => {
  it('is the share of accounts not out, across providers', () => {
    expect(trayQuotaGauge([tally(2, 0, 1), tally(2, 1, 0)])).toBe(0.75);
    expect(trayQuotaGauge([tally(3, 0, 3)])).toBe(0);
    expect(trayQuotaGauge([tally(3, 2, 0)])).toBe(1);
  });
  it('is null with no accounts, so the icon stays plain', () => {
    expect(trayQuotaGauge([])).toBeNull();
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


const at = (hours: number, minutes = 0) => new Date(2026, 9, 19, hours, minutes);

describe('quiet hours', () => {
  it('runs past midnight when the start is later than the end', () => {
    const quiet = { enabled: true, start: '22:00', end: '07:00' };
    expect(inQuietHours(quiet, at(23, 30))).toBe(true);
    expect(inQuietHours(quiet, at(3))).toBe(true);
    expect(inQuietHours(quiet, at(7))).toBe(false);
    expect(inQuietHours(quiet, at(12))).toBe(false);
    expect(inQuietHours(quiet, at(22))).toBe(true);
  });
  it('works within one day', () => {
    const quiet = { enabled: true, start: '12:00', end: '13:30' };
    expect(inQuietHours(quiet, at(12, 45))).toBe(true);
    expect(inQuietHours(quiet, at(13, 30))).toBe(false);
  });
  it('does nothing when off, empty or malformed', () => {
    expect(inQuietHours({ enabled: false, start: '00:00', end: '23:59' }, at(12))).toBe(false);
    expect(inQuietHours({ enabled: true, start: '09:00', end: '09:00' }, at(9))).toBe(false);
    expect(inQuietHours({ enabled: true, start: '25:00', end: '07:00' }, at(3))).toBe(false);
    expect(inQuietHours({ enabled: true, start: '', end: '07:00' }, at(3))).toBe(false);
  });
});
