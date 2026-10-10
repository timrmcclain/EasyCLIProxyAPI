import { describe, expect, it } from 'bun:test';
import {
  captureQuotaCacheGeneration,
  commitQuotaCacheIfCurrent,
  getQuotaCacheSnapshot,
  pruneQuotaCache,
  quotaResultUpdater,
  updateQuotaCache,
} from '../src/services/quotaCache';

describe('额度跨页面缓存', () => {
  it('保留仍存在的认证文件额度并清理失效项', () => {
    updateQuotaCache({
      first: { status: 'success', rows: [], fetchedAt: 1 },
      removed: { status: 'error', rows: [], error: 'old' },
    });
    pruneQuotaCache(new Set(['first']));

    expect(getQuotaCacheSnapshot()).toEqual({
      first: { status: 'success', rows: [], fetchedAt: 1 },
    });
  });

  it('认证文件集合变化后拒绝过期请求写回', () => {
    updateQuotaCache({
      stale: { status: 'loading', rows: [] },
      retained: { status: 'loading', rows: [] },
    });
    const generation = captureQuotaCacheGeneration();
    pruneQuotaCache(new Set(['retained']));
    let committed = false;

    expect(commitQuotaCacheIfCurrent(generation, () => {
      committed = true;
    })).toBe(false);
    expect(committed).toBe(false);
    expect(getQuotaCacheSnapshot().retained).toEqual({ status: 'idle', rows: [] });
  });

  it('没有文件被移除时，仍会把卡住的 loading 项重置为 idle（不能仅凭数量相同就判定未变化）', () => {
    updateQuotaCache({
      stuck: { status: 'loading', rows: [] },
      settled: { status: 'success', rows: [], fetchedAt: 1 },
    });
    const generation = captureQuotaCacheGeneration();
    // Same file set as before — nothing is actually removed, so a length-only
    // "did anything change" check would wrongly call this a no-op.
    pruneQuotaCache(new Set(['stuck', 'settled']));
    let committed = false;

    expect(getQuotaCacheSnapshot().stuck).toEqual({ status: 'idle', rows: [] });
    expect(getQuotaCacheSnapshot().settled).toEqual({ status: 'success', rows: [], fetchedAt: 1 });
    expect(commitQuotaCacheIfCurrent(generation, () => {
      committed = true;
    })).toBe(false);
    expect(committed).toBe(false);
  });

  it('额度百分比回升时标记该窗口为刚刚重置', () => {
    updateQuotaCache({
      acct: {
        status: 'success',
        rows: [{ label: '7-day', windowId: 'seven_day', remainingPercent: 0 }],
        fetchedAt: 1,
      },
    });
    updateQuotaCache(quotaResultUpdater('acct', {
      status: 'success',
      rows: [{ label: '7-day', windowId: 'seven_day', remainingPercent: 93 }],
      fetchedAt: 2,
    }));

    expect(getQuotaCacheSnapshot().acct.rows[0].justReset).toBe(true);
  });

  it('百分比未回升（或首次成功获取）时不标记重置', () => {
    updateQuotaCache({
      acct: {
        status: 'success',
        rows: [{ label: '5-hour', windowId: 'five_hour', remainingPercent: 50 }],
        fetchedAt: 1,
      },
    });
    updateQuotaCache(quotaResultUpdater('acct', {
      status: 'success',
      rows: [{ label: '5-hour', windowId: 'five_hour', remainingPercent: 40 }],
      fetchedAt: 2,
    }));
    expect(getQuotaCacheSnapshot().acct.rows[0].justReset).toBeUndefined();

    updateQuotaCache(quotaResultUpdater('fresh', {
      status: 'success',
      rows: [{ label: '5-hour', windowId: 'five_hour', remainingPercent: 90 }],
      fetchedAt: 1,
    }));
    expect(getQuotaCacheSnapshot().fresh.rows[0].justReset).toBeUndefined();
  });
});

describe('keeping the last good reading', () => {
  const row = { label: '7-day window', windowId: 'seven_day', remainingPercent: 81, resetAtMs: 1 };
  const now = Date.now();

  it('keeps a recent successful reading when a later check fails, and says why', () => {
    updateQuotaCache({ acct: { status: 'success', rows: [row], plan: 'Max', fetchedAt: now - 10 * 60_000 } });
    updateQuotaCache(quotaResultUpdater('acct', { status: 'error', rows: [], error: 'HTTP 429: Rate limited' }, true));
    const kept = getQuotaCacheSnapshot().acct;
    expect(kept.status).toBe('success');
    expect(kept.rows).toEqual([row]);
    expect(kept.plan).toBe('Max');
    expect(kept.fetchedAt).toBe(now - 10 * 60_000);
    expect(kept.refreshError).toBe('HTTP 429: Rate limited');
  });

  it('a later success replaces it and clears the failure note', () => {
    updateQuotaCache(quotaResultUpdater('acct', { status: 'success', rows: [{ ...row, remainingPercent: 80 }], fetchedAt: now }));
    expect(getQuotaCacheSnapshot().acct.refreshError).toBeUndefined();
    expect(getQuotaCacheSnapshot().acct.rows[0].remainingPercent).toBe(80);
  });

  it('shows other failures, and any failure from a refresh you clicked', () => {
    updateQuotaCache({ acct: { status: 'success', rows: [row], fetchedAt: now } });
    updateQuotaCache(quotaResultUpdater('acct', { status: 'error', rows: [], error: 'Session expired' }, true));
    expect(getQuotaCacheSnapshot().acct.status).toBe('error');
    updateQuotaCache({ acct: { status: 'success', rows: [row], fetchedAt: now } });
    updateQuotaCache(quotaResultUpdater('acct', { status: 'error', rows: [], error: 'HTTP 429' }));
    expect(getQuotaCacheSnapshot().acct.status).toBe('error');
  });

  it('does not keep readings older than 30 minutes', () => {
    updateQuotaCache({ acct: { status: 'success', rows: [row], fetchedAt: now - 31 * 60_000 } });
    updateQuotaCache(quotaResultUpdater('acct', { status: 'error', rows: [], error: 'HTTP 429' }, true));
    expect(getQuotaCacheSnapshot().acct.status).toBe('error');
    updateQuotaCache({});
  });
});
