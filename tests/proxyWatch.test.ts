import { describe, expect, it } from 'bun:test';
import { initialProxyWatch, nextProxyWatch, type ProxyWatchState } from '../src/services/proxyWatch';

const ready = { ready: true, starting: false };
const stopped = { ready: false, starting: false };
const starting = { ready: false, starting: true };
const run = (statuses: ({ ready: boolean; starting: boolean } | null)[]) => {
  let state: ProxyWatchState = initialProxyWatch;
  return statuses.map(status => { const next = nextProxyWatch(state, status); state = next.state; return next.alert; });
};

describe('proxy watch', () => {
  it('reports down only after two failed checks in a row, once, then back on recovery', () => {
    expect(run([ready, stopped, stopped, stopped, ready, ready])).toEqual([null, null, 'down', null, 'back', null]);
  });

  it('ignores a single failed check, a proxy that is starting, and treats a failed status call as a failure', () => {
    expect(run([ready, stopped, ready])).toEqual([null, null, null]);
    expect(run([ready, starting, starting, ready])).toEqual([null, null, null, null]);
    expect(run([null, null])).toEqual([null, 'down']);
  });
});
