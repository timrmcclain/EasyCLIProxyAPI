import { describe, expect, it } from 'bun:test';
import {
  anomalies, cacheSavings, costColumns, groupConversations, matchesSearch, recoveries, usageHeatmap, whyThisAccount,
} from '../src/services/activityFeed';
import { emptyRoutingState, routingPlans } from '../src/services/routingOrder';
import type { UsageRecord } from '../src/pages/UsageEventsView';

const now = Date.parse('2026-10-26T19:00:00Z');
const M = 60_000;
let id = 0;
const record = (minutesAgo: number, extra: Partial<UsageRecord> = {}): UsageRecord => ({
  id: `r${++id}`, row_id: String(id), timestamp: new Date(now - minutesAgo * M).toISOString(), latency_ms: 900, ttft_ms: 200,
  source: 'tim@example.com', source_display: 'Claude', failed: false, canceled: false, failure_status: 0, failure_body: '',
  provider: 'claude', model: 'claude-sonnet-4-6', alias: '', reasoning_effort: '', endpoint: '/v1/messages',
  api_key_hash: 'h', api_key_display: 'k', api_key_remark: '', user_agent: 'claude-cli/2.1',
  cost: { total: 0.1, pricing_model: 'claude-sonnet-4-6' },
  tokens: { input_tokens: 100, output_tokens: 50, reasoning_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 150 },
  ...extra,
});

describe('activity feed', () => {
  it('groups requests from one app, account and model into a conversation until a long gap', () => {
    const items = [record(60), record(55), record(50), record(20), record(18, { user_agent: 'codex_cli' })];
    const conversations = groupConversations(items);
    expect(conversations.map(item => [item.client, item.requests])).toEqual([['Codex', 1], ['Claude Code CLI', 1], ['Claude Code CLI', 3]]);
    expect(conversations[2].cost).toBeCloseTo(0.3);
    expect(conversations[2].tokens).toBe(450);
  });

  it('explains a failure the hub recovered from, and on which account', () => {
    const failed = record(10, { failed: true, failure_status: 529 });
    const items = [failed, record(9.5, { source: 'work@example.com' }), record(5, { failed: true, failure_status: 429 })];
    const found = recoveries(items);
    expect(found).toHaveLength(1);
    expect(found[0].failed.id).toBe(failed.id);
    expect(found[0].otherAccount).toBe(true);
  });

  it('splits cost by app per day', () => {
    const columns = costColumns([record(10), record(9, { user_agent: 'claude-desktop/1' }), record(8, { cost: null })], 'app', 'day');
    expect(columns).toHaveLength(1);
    expect(columns[0].total).toBeCloseTo(0.2);
    expect(Object.keys(columns[0].parts).sort()).toEqual(['Claude Code CLI', 'Claude Desktop']);
  });

  it('values cache reads at the difference between the input and cache prices', () => {
    expect(cacheSavings([
      { cacheReadTokens: 2_000_000, price: { prompt: 3, cacheRead: 0.3 } },
      { cacheReadTokens: 500, price: null },
    ])).toBeCloseTo(5.4);
  });

  it('flags an hour where an app used several times its usual tokens', () => {
    const hours = [1, 2, 3, 4, 5, 6, 7].map(hour => record(hour * 60));
    const spike = record(30 * 60, { tokens: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 1500 } });
    const found = anomalies([...hours, spike]);
    expect(found[0]).toMatchObject({ client: 'Claude Code CLI', multiple: 10 });
    expect(anomalies(hours)).toEqual([]);
  });

  it('searches by app, model, account label, status and error text', () => {
    const failed = record(1, { failed: true, failure_status: 429, failure_body: 'rate limit exceeded' });
    expect(matchesSearch(failed, 'failed sonnet')).toBe(true);
    expect(matchesSearch(failed, 'rate limit')).toBe(true);
    expect(matchesSearch(record(1), 'failed')).toBe(false);
    expect(matchesSearch(record(1), 'personal', () => 'Personal')).toBe(true);
  });

  it('counts requests by weekday and hour from local hour keys', () => {
    const grid = usageHeatmap([{ hour: '2026-10-26-09', requests: 4 }, { hour: '2026-10-25-23', requests: 2 }, { hour: 'bad', requests: 9 }]);
    expect(grid[0][9]).toBe(4); // Monday 9:00
    expect(grid[6][23]).toBe(2); // Sunday 23:00
    expect(grid.flat().reduce((a, b) => a + b, 0)).toBe(6);
  });

  it("says where the serving account sits in its provider's order", () => {
    const file = (name: string, priority: number) => ({ name: `${name}.json`, auth_index: name, provider: 'claude', disabled: false, priority, email: `${name}@example.com` });
    const plans = routingPlans([file('tim', 20), file('gmail', 10)], {}, now, emptyRoutingState());
    expect(whyThisAccount('tim@example.com', plans)).toEqual({ kind: 'first', position: 1, total: 2 });
    expect(whyThisAccount('GMAIL@example.com', plans)).toMatchObject({ kind: 'below', position: 2 });
    expect(whyThisAccount('nobody@example.com', plans)).toEqual({ kind: 'unknown' });
  });
});
