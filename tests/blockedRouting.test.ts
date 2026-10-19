import { describe, expect, it } from 'bun:test';
import { planBlockedRouting, priorityBelowOthers } from '../src/services/blockedRouting';
import type { PlanBlock } from '../src/services/planBlock';
import type { AuthFile } from '../src/services/quotaService';

const file = (name: string, index: string, priority: number, provider = 'claude', disabled = false) =>
  ({ name, auth_index: index, provider, priority, disabled }) as unknown as AuthFile;
const terms: PlanBlock = { kind: 'terms', message: 'Accept the updated terms', at: 500 };
const empty = () => ({ demoted: {}, released: {} });

describe('routing away from refused accounts', () => {
  it('moves a refused account just below the other enabled accounts of its provider', () => {
    const files = [file('a.json', '1', 10), file('b.json', '2', 5), file('c.json', '3', 1, 'claude', true), file('x.json', '9', -50, 'codex')];
    const { changes, state } = planBlockedRouting(files, { '1': terms }, empty(), 1_000);
    expect(changes).toEqual([{ name: 'a.json', priority: 4 }]);
    expect(state.demoted['a.json']).toMatchObject({ originalPriority: 10, demotedPriority: 4, kind: 'terms' });
  });
  it('leaves an account alone when there is nothing else to use, or it already ranks lowest', () => {
    expect(planBlockedRouting([file('a.json', '1', 10)], { '1': terms }, empty(), 1_000).changes).toEqual([]);
    expect(priorityBelowOthers([file('a.json', '1', 10)], file('a.json', '1', 10))).toBeNull();
    expect(planBlockedRouting([file('a.json', '1', 0), file('b.json', '2', 5)], { '1': terms }, empty(), 1_000).changes).toEqual([]);
  });
  it('puts the old priority back once the refusal stops', () => {
    const state = { demoted: { 'a.json': { provider: 'claude', originalPriority: 10, demotedPriority: 4, kind: 'terms' as const, since: 1 } }, released: {} };
    const { changes, state: next } = planBlockedRouting([file('a.json', '1', 4), file('b.json', '2', 5)], {}, state, 2_000);
    expect(changes).toEqual([{ name: 'a.json', priority: 10 }]);
    expect(next.demoted).toEqual({});
  });
  it('lets a priority someone else set win', () => {
    const state = { demoted: { 'a.json': { provider: 'claude', originalPriority: 10, demotedPriority: 4, kind: 'terms' as const, since: 1 } }, released: {} };
    const { changes, state: next } = planBlockedRouting([file('a.json', '1', 20), file('b.json', '2', 5)], { '1': terms }, state, 2_000);
    expect(changes).toEqual([]);
    expect(next.demoted).toEqual({});
    expect(next.released['a.json']).toBe(2_000);
  });
  it('does not move an account whose priority is being held for the hour', () => {
    const files = [file('a.json', '1', 10), file('b.json', '2', 5)];
    expect(planBlockedRouting(files, { '1': terms }, empty(), 1_000, f => f.name === 'a.json').changes).toEqual([]);
  });
  it('stays below an account that moved lower since', () => {
    const state = { demoted: { 'a.json': { provider: 'claude', originalPriority: 10, demotedPriority: 4, kind: 'terms' as const, since: 1 } }, released: {} };
    const { changes } = planBlockedRouting([file('a.json', '1', 4), file('b.json', '2', 2)], { '1': terms }, state, 2_000);
    expect(changes).toEqual([{ name: 'a.json', priority: 1 }]);
  });
  it('ignores refusals from before you said it was fixed, but not newer ones', () => {
    const files = [file('a.json', '1', 10), file('b.json', '2', 5)];
    expect(planBlockedRouting(files, { '1': terms }, { demoted: {}, released: { 'a.json': 600 } }, 1_000).changes).toEqual([]);
    expect(planBlockedRouting(files, { '1': { ...terms, at: 700 } }, { demoted: {}, released: { 'a.json': 600 } }, 1_000).changes)
      .toEqual([{ name: 'a.json', priority: 4 }]);
  });
  it('treats plan refusals the same way', () => {
    const files = [file('a.json', '1', 3), file('b.json', '2', 3)];
    const { changes } = planBlockedRouting(files, { '2': { kind: 'plan', message: 'Not on your plan' } }, empty(), 1_000);
    expect(changes).toEqual([{ name: 'b.json', priority: 2 }]);
  });
});
