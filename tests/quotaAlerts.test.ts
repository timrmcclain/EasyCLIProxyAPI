import { describe, expect, it } from 'bun:test';
import type { AttentionItem } from '../src/services/homeGlance';
import { emptyAlertMemory, providerTallies, quotaAlerts, type AlertMemory } from '../src/services/quotaAlerts';
import { quotaKey, type AuthFile } from '../src/services/quotaService';

const file = (name: string, provider = 'claude'): AuthFile => ({ name: `${name}.json`, auth_index: name, provider });
const a = file('a'), b = file('b'), x = file('x', 'codex');
const files = [a, b, x];
const item = (f: AuthFile, severity: AttentionItem['severity'], percent: number | null = null, resetAt?: number): AttentionItem => ({ file: f, severity, percent, resetAt });
const providerOf = (f: AuthFile) => String(f.provider);
const labelFor = (f: AuthFile) => String(f.name).replace('.json', '');
const run = (previous: AlertMemory | null, attention: AttentionItem[]) => quotaAlerts(previous, files, attention, providerOf, labelFor);

describe('quota alerts', () => {
  it('stays silent on the first check and only records a baseline', () => {
    const { alerts, memory } = run(null, [item(a, 'blocked', 0)]);
    expect(alerts).toEqual([]);
    expect(memory.accounts).toMatchObject({ [quotaKey(a)]: 'blocked', [quotaKey(b)]: 'ok' });
  });
  it('alerts once when an account gets low, then again when it is blocked', () => {
    const base = run(null, []).memory;
    const low = run(base, [item(a, 'low', 9)]);
    expect(low.alerts.map(alert => [alert.kind, alert.account, alert.percent])).toEqual([['low', 'a', 9]]);
    expect(run(low.memory, [item(a, 'low', 7)]).alerts).toEqual([]);
    expect(run(low.memory, [item(a, 'blocked', 0)]).alerts.map(alert => alert.kind)).toEqual(['blocked']);
  });
  it('announces a whole provider going down instead of each account', () => {
    const base = run(null, [item(a, 'blocked', 0, 5000)]).memory;
    const { alerts } = run(base, [item(a, 'blocked', 0, 5000), item(b, 'blocked', 0, 3000)]);
    expect(alerts.map(alert => [alert.kind, alert.provider, alert.resetAt])).toEqual([['providerExhausted', 'claude', 3000]]);
  });
  it('says when a blocked account is available again, but not when a low one recovers', () => {
    const blocked = run(null, [item(a, 'blocked', 0)]).memory;
    expect(run(blocked, []).alerts.map(alert => [alert.kind, alert.account])).toEqual([['recovered', 'a']]);
    const low = run(null, [item(a, 'low', 9)]).memory;
    expect(run(low, []).alerts).toEqual([]);
  });
  it('never alerts about unconfirmed accounts', () => {
    const base = run(null, []).memory;
    expect(run(base, [item(x, 'unconfirmed')]).alerts).toEqual([]);
    expect(emptyAlertMemory().accounts).toEqual({});
  });
});

describe('provider tallies for the tray', () => {
  it('counts low and blocked accounts per provider, worst first, ignoring unconfirmed ones', () => {
    const c = file('c', 'codex'), g = file('g', 'xai');
    const tallies = providerTallies([a, b, x, c, g], [item(a, 'low', 7), item(x, 'blocked', 0), item(c, 'blocked', 0), item(g, 'unconfirmed')], providerOf);
    expect(tallies).toEqual([
      { provider: 'codex', total: 2, low: 0, blocked: 2 },
      { provider: 'claude', total: 2, low: 1, blocked: 0 },
    ]);
  });
});
