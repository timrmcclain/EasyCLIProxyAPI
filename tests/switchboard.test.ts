import { describe, expect, it } from 'bun:test';
import { accountColor, ACCOUNT_COLORS } from '../src/services/accountIdentity';
import { quotaKey, type QuotaState } from '../src/services/quotaService';
import { emptyRoutingState, routingPlans } from '../src/services/routingOrder';
import { appFlows, hubLanes, hubState, keptBack, resetCalendar, servedByHour } from '../src/services/switchboard';

const now = Date.parse('2026-10-26T19:00:00Z');
const H = 3_600_000;
const D = 24 * H;
const file = (name: string, priority: number) =>
  ({ name: `${name}.json`, auth_index: name, provider: 'claude', status: 'active', disabled: false, priority, email: `${name}@example.com` });
const quota = (week: number, weekReset: number, session = 80): QuotaState => ({
  status: 'success', fetchedAt: now, rows: [
    { scope: 'account', label: '5-hour window', windowId: 'five_hour', remainingPercent: session, resetAtMs: now + 3 * H },
    { scope: 'account', label: '7-day window', windowId: 'seven_day', remainingPercent: week, resetAtMs: now + weekReset },
  ],
});
const request = (index: string, minutesAgo: number, agent = 'claude-cli/2.0', failed = false) =>
  ({ timestamp: new Date(now - minutesAgo * 60_000).toISOString(), auth_index: index, model: 'claude', user_agent: agent, failed, canceled: false });

describe('switchboard', () => {
  const timothy = file('timothy', 30), work = file('work', 20), gmail = file('gmail', 10);
  const files = [timothy, work, gmail];

  it('names the serving account per provider and counts its live requests', () => {
    const quotas = { [quotaKey(timothy)]: quota(82, 4 * D, 40), [quotaKey(work)]: quota(50, 2 * D), [quotaKey(gmail)]: quota(60, 1 * D) };
    const state = { ...emptyRoutingState('manual'), reserve: [quotaKey(gmail)] };
    const lanes = hubLanes(routingPlans(files, quotas, now, state), quotas, [request('timothy', 1), request('timothy', 10), request('work', 2, 'x', true)], {}, now);
    expect(lanes).toHaveLength(1);
    expect(lanes[0].serving?.name).toBe('timothy.json');
    expect(lanes[0].weekly).toBe(82);
    expect(lanes[0].session).toBe(40);
    expect(lanes[0].live).toBe(1);
    expect(keptBack(lanes[0]).map(entry => entry.name)).toEqual(['gmail.json']);
    expect(hubState(true, lanes)).toBe('working');
    expect(hubState(false, lanes)).toBe('down');
  });

  it('says reserve when the kept-back account is the one paying, and blocked when nobody can', () => {
    const outFirst = { [quotaKey(timothy)]: quota(0, 4 * D), [quotaKey(work)]: quota(0, 2 * D), [quotaKey(gmail)]: quota(60, 1 * D) };
    const state = { ...emptyRoutingState('manual'), reserve: [quotaKey(gmail)] };
    expect(hubState(true, hubLanes(routingPlans(files, outFirst, now, state), outFirst, [], {}, now))).toBe('reserve');
    const allOut = { ...outFirst, [quotaKey(gmail)]: quota(0, 1 * D) };
    expect(hubState(true, hubLanes(routingPlans(files, allOut, now, state), allOut, [], {}, now))).toBe('blocked');
  });

  it('lists apps from the last hour, busiest first, and marks the ones sending now', () => {
    const items = [request('a', 1, 'claude-cli/2'), request('a', 30, 'claude-cli/2'), request('a', 5, 'codex_cli'), request('a', 90, 'claude-desktop')];
    expect(appFlows(items, now)).toEqual([
      { client: 'Claude Code CLI', count: 2, live: true },
      { client: 'Codex', count: 1, live: false },
    ]);
  });

  it('puts weekly refills in the next seven days on the calendar, soonest first', () => {
    const quotas = { [quotaKey(timothy)]: quota(50, 9 * D), [quotaKey(work)]: quota(50, 2 * D), [quotaKey(gmail)]: quota(50, 1 * D) };
    const marks = resetCalendar(routingPlans(files, quotas, now, emptyRoutingState()), quotas, now);
    expect(marks.map(mark => mark.file.name)).toEqual(['gmail.json', 'work.json']);
  });

  it('buckets each account’s hourly requests into the last 24 hours', () => {
    const hour = (offset: number) => {
      const date = new Date(Math.floor(now / H) * H - offset * H);
      return [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours()].map(part => String(part).padStart(2, '0')).join('-');
    };
    const slices = servedByHour({ a: [{ hour: hour(0), requests: 3 }, { hour: hour(30), requests: 9 }, { hour: 'not an hour', requests: 5 }], b: [{ hour: hour(0), requests: 1 }] }, now);
    expect(slices).toHaveLength(24);
    expect(slices[23]).toMatchObject({ total: 4, byKey: { a: 3, b: 1 } });
    expect(slices.reduce((sum, slice) => sum + slice.total, 0)).toBe(4);
  });

  it('gives each account a stable colour unless you picked one', () => {
    expect(ACCOUNT_COLORS).toContain(accountColor('claude.json::1') as typeof ACCOUNT_COLORS[number]);
    expect(accountColor('claude.json::1')).toBe(accountColor('claude.json::1'));
    expect(accountColor('claude.json::1', { 'claude.json::1': '#123456' })).toBe('#123456');
  });
});
