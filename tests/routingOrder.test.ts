import { describe, expect, it } from 'bun:test';
import { quotaKey, type QuotaState } from '../src/services/quotaService';
import {
  emptyRoutingState, orderMismatch, priorityWrites, providerPlan, readRoutingState, routingPlans, withProviderChange,
  type RoutingState,
} from '../src/services/routingOrder';

const now = Date.parse('2026-10-26T19:00:00Z');
const H = 3_600_000;
const D = 24 * H;
const file = (name: string, priority: number) =>
  ({ name: `${name}.json`, auth_index: name, provider: 'claude', status: 'active', disabled: false, priority });
const quota = (week: number, weekReset: number, session = 80): QuotaState => ({
  status: 'success', fetchedAt: now, rows: [
    { scope: 'account', label: '5-hour window', windowId: 'five_hour', remainingPercent: session, resetAtMs: now + 3 * H },
    { scope: 'account', label: '7-day window', windowId: 'seven_day', remainingPercent: week, resetAtMs: now + weekReset },
  ],
});
const names = (state: RoutingState, files: ReturnType<typeof file>[], quotas: Record<string, QuotaState>) =>
  providerPlan('claude', files, quotas, now, state).entries.map(entry => `${entry.name.replace('.json', '')}:${entry.role}`);
const storage = (values: Record<string, string>) => ({ getItem: (key: string) => values[key] ?? null });

describe('routing order', () => {
  it('carries the old switch and Save for last over: Smart, with the saved account in Reserve', () => {
    const gmail = file('gmail', 20);
    const state = readRoutingState(storage({ 'personal.quotaRouting': 'true', 'personal.routingLast': JSON.stringify([quotaKey(gmail)]) }));
    expect(state.defaultMode).toBe('smart');
    expect(state.reserve).toEqual([quotaKey(gmail)]);
    expect(readRoutingState(storage({})).defaultMode).toBe('manual');
  });

  it("keeps Gmail last even though its weekly limit resets soonest (this morning's mix-up)", () => {
    const timothy = file('timothy', 30), work = file('work', 10), gmail = file('gmail', 20);
    const quotas = {
      [quotaKey(timothy)]: quota(82, 4 * D), [quotaKey(work)]: quota(0, 1 * D), [quotaKey(gmail)]: quota(13, 2 * D),
    };
    const state = { ...emptyRoutingState('smart'), reserve: [quotaKey(gmail)] };
    expect(names(state, [timothy, work, gmail], quotas)).toEqual(['timothy:primary', 'work:next', 'gmail:reserve']);
    const plan = providerPlan('claude', [timothy, work, gmail], quotas, now, state);
    expect(plan.next?.name).toBe('timothy.json');
  });

  it('follows your order in manual mode, and new accounts join below it by their current priority', () => {
    const a = file('a', 0), b = file('b', 0), c = file('c', 50);
    const quotas = { [quotaKey(a)]: quota(50, 3 * D), [quotaKey(b)]: quota(50, 3 * D), [quotaKey(c)]: quota(50, 3 * D) };
    const state = { ...emptyRoutingState('manual'), providers: { claude: { mode: 'manual' as const, order: [quotaKey(b), quotaKey(a)] } } };
    expect(names(state, [a, b, c], quotas)).toEqual(['b:primary', 'a:next', 'c:next']);
  });

  it('skips an out account when naming who gets the next request, without moving it in your order', () => {
    const a = file('a', 20), b = file('b', 10);
    const quotas = { [quotaKey(a)]: quota(0, 1 * D), [quotaKey(b)]: quota(40, 3 * D) };
    const plan = providerPlan('claude', [a, b], quotas, now, emptyRoutingState('manual'));
    expect(plan.entries.map(entry => entry.role)).toEqual(['next', 'primary']);
    expect(plan.entries[0].reason).toBe('out');
    expect(plan.next?.name).toBe('b.json');
  });

  it('holds an account back below its keep-back floor or outside its hours, above the reserve', () => {
    const a = file('a', 30), b = file('b', 20), c = file('c', 10);
    const quotas = { [quotaKey(a)]: quota(15, 3 * D), [quotaKey(b)]: quota(60, 3 * D), [quotaKey(c)]: quota(90, 3 * D) };
    const hour = new Date(now).getHours();
    const state: RoutingState = {
      ...emptyRoutingState('manual'), reserve: [quotaKey(c)],
      rules: { [quotaKey(a)]: { keepPercent: 20 } },
    };
    expect(names(state, [a, b, c], quotas)).toEqual(['b:primary', 'a:held', 'c:reserve']);
    const outside = { ...state, rules: { [quotaKey(b)]: { hours: { from: (hour + 2) % 24, to: (hour + 4) % 24 } } } };
    expect(names(outside, [a, b, c], quotas)).toEqual(['a:primary', 'b:held', 'c:reserve']);
  });

  it('writes nothing when the proxy already has the accounts in this order', () => {
    const a = file('a', 7), b = file('b', 3);
    const quotas = { [quotaKey(a)]: quota(50, 3 * D), [quotaKey(b)]: quota(50, 3 * D) };
    expect(priorityWrites(providerPlan('claude', [a, b], quotas, now, emptyRoutingState('manual')))).toEqual([]);
    const reversed = { ...emptyRoutingState('manual'), providers: { claude: { mode: 'manual' as const, order: [quotaKey(b), quotaKey(a)] } } };
    expect(priorityWrites(providerPlan('claude', [a, b], quotas, now, reversed))).toEqual([{ name: 'b.json', priority: 20 }, { name: 'a.json', priority: 10 }]);
  });

  it("leaves the proxy's priorities alone in Your order until you save one, even when they tie", () => {
    const a = file('a', 0), b = file('b', 0);
    const quotas = { [quotaKey(a)]: quota(50, 3 * D), [quotaKey(b)]: quota(50, 3 * D) };
    const plan = providerPlan('claude', [a, b], quotas, now, emptyRoutingState('manual'));
    expect(plan.owned).toBe(false);
    expect(priorityWrites(plan)).toEqual([]);
  });

  it("leaves Smart's order alone until every account's quota has been checked", () => {
    const a = file('a', 1), b = file('b', 2);
    const plan = providerPlan('claude', [a, b], { [quotaKey(a)]: quota(50, 1 * D) }, now, emptyRoutingState('smart'));
    expect(plan.checked).toBe(false);
    expect(priorityWrites(plan)).toEqual([]);
  });

  it('warns when a Reserve account served a real share of recent traffic while one above it had quota', () => {
    const a = file('a', 20), g = file('g', 10);
    const quotas = { [quotaKey(a)]: quota(50, 3 * D), [quotaKey(g)]: quota(50, 2 * D) };
    const plan = providerPlan('claude', [a, g], quotas, now, { ...emptyRoutingState('manual'), reserve: [quotaKey(g)] });
    expect(orderMismatch(plan, { [quotaKey(a)]: 6, [quotaKey(g)]: 4 })).toEqual({ key: quotaKey(g), served: 4, total: 10 });
    expect(orderMismatch(plan, { [quotaKey(a)]: 9, [quotaKey(g)]: 1 })).toBeNull();
    expect(orderMismatch(plan, { [quotaKey(g)]: 3 })).toBeNull();
  });

  it('records your change with what it replaced, so it can be undone', () => {
    const state = emptyRoutingState('smart');
    const next = withProviderChange(state, 'claude', { provider: { mode: 'manual', order: ['x', 'y'] }, reserve: ['y'], rules: {} }, 'you', ['x', 'y'], now);
    expect(next.providers.claude).toEqual({ mode: 'manual', order: ['x', 'y'] });
    expect(next.history.at(-1)?.before?.provider.mode).toBe('smart');
  });

  it('only plans providers with a choice to make and skips turned-off accounts', () => {
    const solo = { ...file('solo', 0), provider: 'codex' };
    const off = { ...file('off', 0), disabled: true };
    expect(routingPlans([solo, file('a', 0), off], {}, now, emptyRoutingState())).toEqual([]);
  });
});
