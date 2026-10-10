import { describe, expect, it } from 'bun:test';
import { priorityChanges, routingPlan } from '../src/services/quotaRouting';
import { quotaKey, type QuotaState } from '../src/services/quotaService';

const now = Date.parse('2026-10-10T12:00:00Z');
const H = 3_600_000;
const D = 24 * H;
const file = (name: string, priority: number, extra: Record<string, unknown> = {}) =>
  ({ name: `${name}.json`, auth_index: name, provider: 'claude', status: 'active', disabled: false, priority, ...extra });
const quota = (week: number, weekReset: number, session = 80): QuotaState => ({
  status: 'success', fetchedAt: now, rows: [
    { scope: 'account', label: '5-hour window', windowId: 'five_hour', remainingPercent: session, resetAtMs: now + 3 * H },
    { scope: 'account', label: '7-day window', windowId: 'seven_day', remainingPercent: week, resetAtMs: now + weekReset },
  ],
});
const order = (plans: ReturnType<typeof routingPlan>) => plans.map(plan => [plan.provider, plan.order.map(entry => entry.file.name)]);

describe('quota-aware routing order', () => {
  it('puts the account whose weekly window resets soonest first, so its quota is not wasted', () => {
    const gmail = file('gmail', 10), work = file('work', 0);
    const quotas = { [quotaKey(gmail)]: quota(81, 5 * D), [quotaKey(work)]: quota(40, 4 * D) };
    const plans = routingPlan([gmail, work], quotas, now);
    expect(order(plans)).toEqual([['claude', ['work.json', 'gmail.json']]]);
    expect(plans[0].order.map(entry => entry.priority)).toEqual([20, 10]);
  });

  it('moves low accounts behind healthy ones, and blocked ones last', () => {
    const low = file('low', 0), out = file('out', 0), ok = file('ok', 0);
    const quotas = {
      [quotaKey(low)]: quota(7, 1 * D),
      [quotaKey(out)]: quota(0, 2 * D),
      [quotaKey(ok)]: quota(60, 6 * D),
    };
    expect(order(routingPlan([low, out, ok], quotas, now))).toEqual([['claude', ['ok.json', 'low.json', 'out.json']]]);
  });

  it('treats an empty 5-hour window as low even with weekly quota left', () => {
    const resting = file('resting', 0), ready = file('ready', 0);
    const quotas = { [quotaKey(resting)]: quota(90, 1 * D, 0), [quotaKey(ready)]: quota(50, 6 * D) };
    expect(order(routingPlan([resting, ready], quotas, now))[0][1][0]).toBe('ready.json');
  });

  it('leaves alone single-account providers, disabled accounts, and providers with an unchecked account', () => {
    const solo = file('solo', 0, { provider: 'codex' });
    const a = file('a', 0), b = file('b', 0), off = file('off', 0, { disabled: true });
    const g1 = file('g1', 0, { provider: 'xai' }), g2 = file('g2', 0, { provider: 'xai' });
    const quotas = {
      [quotaKey(solo)]: quota(50, D), [quotaKey(a)]: quota(50, D), [quotaKey(b)]: quota(50, 2 * D),
      [quotaKey(g1)]: quota(50, D),
    };
    expect(order(routingPlan([solo, a, b, off, g1, g2], quotas, now))).toEqual([['claude', ['a.json', 'b.json']]]);
  });

  it('only reports accounts whose priority actually changes', () => {
    const first = file('first', 20), second = file('second', 0);
    const quotas = { [quotaKey(first)]: quota(50, D), [quotaKey(second)]: quota(50, 2 * D) };
    expect(priorityChanges(routingPlan([first, second], quotas, now)).map(change => [change.file.name, change.priority]))
      .toEqual([['second.json', 10]]);
  });
});
