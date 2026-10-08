import { invoke } from '@tauri-apps/api/core';

export type CompressionStatus = {
  installed: boolean;
  binary: string | null;
  enabled: boolean;
  running: boolean;
  port: number;
  proxyPort: number;
  logPath: string | null;
  routeClaudeCode: boolean;
  routeClaudeDesktop: boolean;
  /** Apps currently point at the compression service (false while it falls back to the proxy). */
  routed: boolean;
  lastError: string | null;
  memory: boolean;
};

type Lifetime = {
  requests?: number;
  tokens_saved?: number;
  compression_savings_usd?: number;
  total_input_tokens?: number;
};

type ModelSavings = {
  requests?: number;
  tokens_saved?: number;
  savings_percent?: number;
  compression_savings_usd?: number;
};

type HistoryPoint = {
  timestamp?: string;
  total_tokens_saved?: number;
  compression_savings_usd?: number;
};

type AgentUsage = {
  agent?: string;
  label?: string;
  requests?: number;
  before_tokens?: number;
  after_tokens?: number;
  tokens_saved?: number;
  savings_percent?: number;
};

type RecentRequest = {
  request_id?: string;
  timestamp?: string;
  model?: string;
  input_tokens_original?: number;
  input_tokens_optimized?: number;
  tokens_saved?: number;
  savings_percent?: number;
  transforms_applied?: string[];
};

export type CompressionStats = {
  summary: {
    api_requests?: number;
    compression?: { requests_compressed?: number; avg_compression_pct?: number; total_tokens_before?: number };
  } | null;
  agentUsage: { agents?: AgentUsage[] } | null;
  persistentSavings: {
    lifetime?: Lifetime;
    by_model?: Record<string, ModelSavings>;
    recent_history?: HistoryPoint[];
  } | null;
  tokensSavedByStrategy: Record<string, number> | null;
  recentRequests: RecentRequest[] | null;
};

export type LearnProposal = { path: string; content: string };
export type LearnPreview = { summary: string | null; proposals: LearnProposal[]; output: string };

export const compressionService = {
  status: () => invoke<CompressionStatus>('headroom_status'),
  setEnabled: (enabled: boolean) => invoke<CompressionStatus>('headroom_set_enabled', { enabled }),
  setRoutes: (claudeCode: boolean, claudeDesktop: boolean) =>
    invoke<CompressionStatus>('headroom_set_routes', { claudeCode, claudeDesktop }),
  setMemory: (memory: boolean) => invoke<CompressionStatus>('headroom_set_memory', { memory }),
  stats: () => invoke<CompressionStats>('headroom_stats'),
  learnPreview: (project: string) => invoke<LearnPreview>('headroom_learn_preview', { project }),
  learnApply: (path: string, content: string) => invoke<void>('headroom_learn_apply', { path, content }),
};

export type DailySavings = { day: string; tokens: number; usd: number };

/** Saved tokens per local calendar day, oldest first, from Headroom's per-request history. */
export function dailySavings(points: HistoryPoint[] | undefined, days = 14, now = new Date()): DailySavings[] {
  const keyOf = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const buckets = new Map<string, DailySavings>();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    buckets.set(keyOf(date), { day: keyOf(date), tokens: 0, usd: 0 });
  }
  for (const point of points ?? []) {
    if (!point.timestamp) continue;
    const date = new Date(point.timestamp);
    if (Number.isNaN(date.getTime())) continue;
    const bucket = buckets.get(keyOf(date));
    if (!bucket) continue;
    bucket.tokens += point.total_tokens_saved ?? 0;
    bucket.usd += point.compression_savings_usd ?? 0;
  }
  return [...buckets.values()];
}

/** Share of input tokens removed over the service's lifetime, 0–100. */
export function lifetimeSavingsPercent(lifetime: Lifetime | undefined): number | null {
  const saved = lifetime?.tokens_saved ?? 0;
  const sent = lifetime?.total_input_tokens ?? 0;
  if (saved + sent <= 0) return null;
  return (saved / (saved + sent)) * 100;
}
