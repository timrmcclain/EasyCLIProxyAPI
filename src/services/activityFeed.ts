import type { UsageRecord } from '../pages/UsageEventsView';
import { ruleUses, type AppRule } from './appRouting';
import type { ProviderPlan } from './routingOrder';

/**
 * Activity as a story rather than a table: requests grouped into conversations, failures that the hub recovered from,
 * where the money went, what the cache saved, and anything unusual.
 */
export type Conversation = {
  id: string; client: string; source: string; model: string; provider: string;
  start: number; end: number; requests: number; failures: number; canceled: number;
  tokens: number; cacheRead: number; cost: number; unpriced: number; items: UsageRecord[];
};

/** Requests further apart than this start a new conversation. */
export const CONVERSATION_GAP_MS = 10 * 60_000;
const RETRY_WINDOW_MS = 2 * 60_000;

export const clientOf = (record: Pick<UsageRecord, 'user_agent' | 'source_display'>) => {
  const agent = (record.user_agent ?? '').toLowerCase();
  if (agent.includes('claude-desktop')) return 'Claude Desktop';
  if (agent.includes('claude-cli')) return 'Claude Code CLI';
  if (agent.includes('codex')) return 'Codex';
  return 'other';
};
const at = (record: UsageRecord) => Date.parse(record.timestamp);

/** Consecutive requests from the same app, account and model, newest conversation first. */
export function groupConversations(records: UsageRecord[], gapMs = CONVERSATION_GAP_MS): Conversation[] {
  const sorted = [...records].filter(record => Number.isFinite(at(record))).sort((a, b) => at(a) - at(b));
  const open = new Map<string, Conversation>();
  const done: Conversation[] = [];
  for (const record of sorted) {
    const client = clientOf(record);
    const key = `${client}|${record.source}|${record.model}`;
    const time = at(record);
    let conversation = open.get(key);
    if (conversation && time - conversation.end > gapMs) { done.push(conversation); conversation = undefined; }
    if (!conversation) {
      conversation = {
        id: record.id, client, source: record.source, model: record.model, provider: record.provider,
        start: time, end: time, requests: 0, failures: 0, canceled: 0, tokens: 0, cacheRead: 0, cost: 0, unpriced: 0, items: [],
      };
      open.set(key, conversation);
    }
    conversation.end = time;
    conversation.requests += 1;
    if (record.failed) conversation.failures += 1;
    if (record.canceled) conversation.canceled += 1;
    conversation.tokens += record.tokens?.total_tokens ?? 0;
    conversation.cacheRead += record.tokens?.cache_read_tokens ?? 0;
    if (record.cost) conversation.cost += record.cost.total; else if (!record.failed && !record.canceled) conversation.unpriced += 1;
    conversation.items.push(record);
  }
  return [...done, ...open.values()].sort((a, b) => b.end - a.end);
}

export type Recovery = { failed: UsageRecord; retried: UsageRecord; otherAccount: boolean };

/** Failed requests that the same app got through soon after, and on which account. */
export function recoveries(records: UsageRecord[]): Recovery[] {
  const sorted = [...records].filter(record => Number.isFinite(at(record))).sort((a, b) => at(a) - at(b));
  const found: Recovery[] = [];
  sorted.forEach((record, index) => {
    if (!record.failed) return;
    const client = clientOf(record);
    const retried = sorted.slice(index + 1).find(next => at(next) - at(record) <= RETRY_WINDOW_MS && !next.failed && !next.canceled
      && clientOf(next) === client && next.provider === record.provider);
    if (retried) found.push({ failed: record, retried, otherAccount: retried.source !== record.source });
  });
  return found;
}

export type CostDimension = 'app' | 'account' | 'model';
export type CostBucket = 'day' | 'week';
export type CostColumn = { at: number; total: number; parts: Record<string, number> };

const DAY = 86_400_000;
function bucketStart(time: number, bucket: CostBucket) {
  const date = new Date(time); date.setHours(0, 0, 0, 0);
  if (bucket === 'week') date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return date.getTime();
}

/** Estimated cost per day or week, split by app, account or model, oldest first. */
export function costColumns(records: UsageRecord[], dimension: CostDimension, bucket: CostBucket, labelOf: (source: string) => string = source => source): CostColumn[] {
  const columns = new Map<number, CostColumn>();
  for (const record of records) {
    const time = at(record);
    if (!record.cost || !Number.isFinite(time)) continue;
    const start = bucketStart(time, bucket);
    const column = columns.get(start) ?? { at: start, total: 0, parts: {} };
    const part = dimension === 'app' ? clientOf(record) : dimension === 'account' ? labelOf(record.source) || '—' : record.model;
    column.parts[part] = (column.parts[part] ?? 0) + record.cost.total;
    column.total += record.cost.total;
    columns.set(start, column);
  }
  return [...columns.values()].sort((a, b) => a.at - b.at);
}

export type PriceRow = { cacheReadTokens: number; price: { prompt: number; cacheRead: number } | null };

/** Money the cache saved: cached input billed at the cache rate instead of the normal input rate (prices per million tokens). */
export function cacheSavings(rows: PriceRow[]): number {
  return rows.reduce((sum, row) => row.price && row.cacheReadTokens > 0
    ? sum + Math.max(0, row.price.prompt - row.price.cacheRead) * row.cacheReadTokens / 1_000_000 : sum, 0);
}

export type Anomaly = { client: string; at: number; tokens: number; multiple: number };

/** Hours where an app used several times its usual tokens. Needs a few busy hours to know what "usual" is. */
export function anomalies(records: UsageRecord[], factor = 4, minHours = 6): Anomaly[] {
  const byClient = new Map<string, Map<number, number>>();
  for (const record of records) {
    const time = at(record);
    if (!Number.isFinite(time)) continue;
    const hour = Math.floor(time / 3_600_000) * 3_600_000;
    const client = clientOf(record);
    const hours = byClient.get(client) ?? new Map<number, number>();
    hours.set(hour, (hours.get(hour) ?? 0) + (record.tokens?.total_tokens ?? 0));
    byClient.set(client, hours);
  }
  const found: Anomaly[] = [];
  for (const [client, hours] of byClient) {
    const values = [...hours.values()].filter(value => value > 0).sort((a, b) => a - b);
    if (values.length < minHours) continue;
    const median = values[Math.floor(values.length / 2)];
    for (const [hour, tokens] of hours) {
      if (median > 0 && tokens >= median * factor) found.push({ client, at: hour, tokens, multiple: Math.round(tokens / median) });
    }
  }
  return found.sort((a, b) => b.multiple - a.multiple);
}

/** Free-text search over what a person would remember about a request. */
export function matchesSearch(record: UsageRecord, text: string, labelOf: (source: string) => string = source => source): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const status = record.failed ? `failed error ${record.failure_status || ''}` : record.canceled ? 'canceled cancelled' : 'ok success';
  const haystack = [clientOf(record), record.model, record.response_model ?? '', record.provider, record.source, labelOf(record.source),
    record.alias, status, record.failure_body ?? ''].join(' ').toLowerCase();
  return words.every(word => haystack.includes(word));
}

/** Requests by weekday (Monday first) and hour, from Activity's local "YYYY-MM-DD-HH" timeline. */
export function usageHeatmap(timeline: { hour: string; requests: number }[]): number[][] {
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const point of timeline) {
    const match = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})$/.exec(point.hour);
    if (!match || !point.requests) continue;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]));
    grid[(date.getDay() + 6) % 7][date.getHours()] += point.requests;
  }
  return grid;
}

export type WhyAccount =
  | { kind: 'first'; position: number; total: number }
  | { kind: 'below'; position: number; total: number; reserve: boolean }
  /** The app's own accounts (Who pays for this app) include it. */
  | { kind: 'rule' }
  | { kind: 'unknown' };

/** Where the account that served a request sits in its provider's order today, or that it's one the app was given; the
 *  proxy doesn't record why per request. */
export function whyThisAccount(source: string, plans: ProviderPlan[], appRule?: AppRule): WhyAccount {
  for (const plan of plans) {
    const index = plan.entries.findIndex(entry => String(entry.file.email ?? '').toLowerCase() === source.toLowerCase());
    if (index < 0) continue;
    const entry = plan.entries[index];
    if (ruleUses(appRule, entry.name)) return { kind: 'rule' };
    if (index === 0 || entry === plan.next) return { kind: 'first', position: index + 1, total: plan.entries.length };
    return { kind: 'below', position: index + 1, total: plan.entries.length, reserve: entry.role === 'reserve' || entry.role === 'held' };
  }
  return { kind: 'unknown' };
}

export const dayMs = DAY;
