/** Response times per model from a sample of successful requests: what to expect, and which models run slow. */

export type TimedRequest = { model: string; response_model?: string | null; latency_ms: number; ttft_ms: number | null };
export type ModelTiming = { model: string; count: number; medianMs: number; p95Ms: number; ttftMedianMs: number | null };

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: number[], fraction: number) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

export function modelTimings(requests: TimedRequest[], limit = 8, minCount = 3): ModelTiming[] {
  const byModel = new Map<string, { latency: number[]; ttft: number[] }>();
  for (const request of requests) {
    if (!Number.isFinite(request.latency_ms) || request.latency_ms <= 0) continue;
    const model = request.model || request.response_model || 'unknown';
    const entry = byModel.get(model) ?? { latency: [], ttft: [] };
    entry.latency.push(request.latency_ms);
    if (request.ttft_ms !== null && Number.isFinite(request.ttft_ms) && request.ttft_ms > 0) entry.ttft.push(request.ttft_ms);
    byModel.set(model, entry);
  }
  return [...byModel]
    .filter(([, entry]) => entry.latency.length >= minCount)
    .map(([model, entry]): ModelTiming => {
      const latency = entry.latency.sort((a, b) => a - b);
      const ttft = entry.ttft.sort((a, b) => a - b);
      return { model, count: latency.length, medianMs: percentile(latency, 0.5), p95Ms: percentile(latency, 0.95), ttftMedianMs: ttft.length ? percentile(ttft, 0.5) : null };
    })
    .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model))
    .slice(0, limit);
}

export function formatDuration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
