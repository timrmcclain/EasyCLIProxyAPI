import { afterEach, describe, expect, it } from 'bun:test';
import {
  CORE_HEALTH_AUTO_INTERVAL_MS,
  isAutoCheckDue,
  pickAutoCheckModels,
  pruneHealthResults,
  readAutoCheckState,
  readStoredHealthResults,
  saveAutoCheckState,
  saveStoredHealthResults,
} from '../src/services/coreHealthAuto';

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});
const memoryStorage = () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  return values;
};

describe('scheduled model health checks', () => {
  it('picks one inexpensive chat model per provider', () => {
    const picks = pickAutoCheckModels([
      { name: 'claude-opus-5-5', provider: 'anthropic' },
      { name: 'claude-haiku-4-5-20251001', provider: 'anthropic' },
      { name: 'gemini-3.1-flash-image', provider: 'antigravity' },
      { name: 'gemini-3.1-pro-low', provider: 'antigravity' },
      { name: 'gemini-3.1-flash-lite', provider: 'antigravity' },
      { name: 'claude-custom-1', provider: 'antigravity' },
      { name: 'gpt-image-2', provider: 'openai' },
      { name: 'gpt-6-sol', provider: 'openai' },
      { name: 'gpt-6-luna', provider: 'openai' },
      { name: 'grok-imagine-video', provider: 'xai' },
      { name: 'grok-3-mini', provider: 'xai' },
      { name: 'kimi-k2.6', provider: 'moonshot' },
      { name: 'kimi-k3', provider: 'moonshot' },
      { name: 'deepseek-chat' },
    ]);
    expect(picks.map((model) => model.name)).toEqual([
      'claude-haiku-4-5-20251001', 'gemini-3.1-flash-lite', 'gpt-6-luna', 'grok-3-mini', 'kimi-k2.6', 'deepseek-chat',
    ]);
  });

  it('is due after the interval, while enabled, and when the clock moved backwards', () => {
    const now = 10 * CORE_HEALTH_AUTO_INTERVAL_MS;
    expect(isAutoCheckDue({ enabled: true, lastRunAt: 0 }, now)).toBe(true);
    expect(isAutoCheckDue({ enabled: true, lastRunAt: now - CORE_HEALTH_AUTO_INTERVAL_MS + 1 }, now)).toBe(false);
    expect(isAutoCheckDue({ enabled: true, lastRunAt: now - CORE_HEALTH_AUTO_INTERVAL_MS }, now)).toBe(true);
    expect(isAutoCheckDue({ enabled: false, lastRunAt: 0 }, now)).toBe(false);
    expect(isAutoCheckDue({ enabled: true, lastRunAt: now + 1 }, now)).toBe(true);
  });

  it('persists results and schedule, rejecting malformed entries', () => {
    const values = memoryStorage();
    expect(readAutoCheckState()).toEqual({ enabled: true, lastRunAt: 0 });
    saveAutoCheckState({ enabled: false, lastRunAt: 123 });
    expect(readAutoCheckState()).toEqual({ enabled: false, lastRunAt: 123 });
    const healthy = { model: 'a', success: true, status: 'healthy' as const, checkedAt: 5, responseLatencyMs: 9 };
    saveStoredHealthResults({ a: healthy });
    expect(readStoredHealthResults()).toEqual({ a: healthy });
    values.set('personal.coreHealth.results', JSON.stringify({ a: healthy, b: { ...healthy }, c: { model: 'c', success: true } }));
    expect(readStoredHealthResults()).toEqual({ a: healthy });
    values.set('personal.coreHealth.results', 'invalid');
    expect(readStoredHealthResults()).toEqual({});
  });

  it('keeps results until the model list loads, then drops unpublished models', () => {
    const result = (model: string) => ({ model, success: true, status: 'healthy' as const, checkedAt: 1 });
    const stored = { a: result('a'), b: result('b') };
    expect(pruneHealthResults(stored, [])).toEqual(stored);
    expect(pruneHealthResults(stored, [{ name: 'b' }])).toEqual({ b: result('b') });
  });

  it('works without storage', () => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw Error('Denied'); } });
    expect(readStoredHealthResults()).toEqual({});
    expect(readAutoCheckState()).toEqual({ enabled: true, lastRunAt: 0 });
    saveAutoCheckState({ enabled: true, lastRunAt: 1 });
  });
});
