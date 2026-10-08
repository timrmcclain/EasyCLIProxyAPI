import type { CoreHealthModel, CoreModelHealthResult } from './coreHealthCheck';

export type StoredHealthResult = CoreModelHealthResult & { checkedAt: number };
export type AutoCheckState = { enabled: boolean; lastRunAt: number };

export const CORE_HEALTH_AUTO_INTERVAL_MS = 4 * 60 * 60_000;
export const CORE_HEALTH_AUTO_START_DELAY_MS = 60_000;
export const CORE_HEALTH_AUTO_TICK_MS = 10 * 60_000;

const RESULTS_KEY = 'personal.coreHealth.results';
const AUTO_KEY = 'personal.coreHealth.auto';
// Image/video generators and routing aliases are poor liveness probes: they
// either cost far more than a short chat reply or hide which model answered.
const NON_CHAT = /image|video|imagine|custom|alias|review|agent|embed|tts|audio|transcribe/i;
// Earlier patterns win; models matching none rank after all that do.
const INEXPENSIVE = [/haiku/i, /lite/i, /mini/i, /flash/i, /fast/i, /luna/i];

const providerKey = (model: CoreHealthModel) =>
  model.provider?.trim().toLowerCase() || model.name.split(/[-/]/, 1)[0].toLowerCase();

const costRank = (name: string) => {
  const index = INEXPENSIVE.findIndex((pattern) => pattern.test(name));
  return index === -1 ? INEXPENSIVE.length : index;
};

/** One inexpensive chat model per provider, in first-seen provider order. */
// The proxy cools a model down after the provider answers "model not found", so probing a
// retired model again would bench it on every account. Bulk runs skip such models; the row
// button still checks one on request.
export function isModelNotFound(result: Pick<CoreModelHealthResult, 'success' | 'error'> | undefined): boolean {
  return Boolean(result && !result.success && /HTTP 404|not_found_error|model[^.]{0,40}(?:not found|does not exist)/i.test(result.error ?? ''));
}

export function bulkCheckTargets(models: CoreHealthModel[], results: Record<string, StoredHealthResult>): CoreHealthModel[] {
  return models.filter((model) => !isModelNotFound(results[model.name]));
}

export function pickAutoCheckModels(models: CoreHealthModel[], results: Record<string, StoredHealthResult> = {}): CoreHealthModel[] {
  const picks = new Map<string, CoreHealthModel>();
  for (const model of bulkCheckTargets(models, results)) {
    if (!model.name.trim() || NON_CHAT.test(model.name)) continue;
    const key = providerKey(model);
    const current = picks.get(key);
    if (!current || costRank(model.name) < costRank(current.name)) picks.set(key, model);
  }
  return [...picks.values()];
}

const storage = (): Pick<Storage, 'getItem' | 'setItem'> | null => {
  try { return globalThis.localStorage ?? null; } catch { return null; }
};

const isStoredResult = (value: unknown): value is StoredHealthResult => {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return typeof result.model === 'string' && typeof result.success === 'boolean'
    && (result.status === 'healthy' || result.status === 'failed')
    && typeof result.checkedAt === 'number' && Number.isFinite(result.checkedAt);
};

export function readStoredHealthResults(): Record<string, StoredHealthResult> {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(RESULTS_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const results: Record<string, StoredHealthResult> = {};
    for (const [model, result] of Object.entries(parsed)) {
      if (isStoredResult(result) && result.model === model) results[model] = result;
    }
    return results;
  } catch {
    return {};
  }
}

export function saveStoredHealthResults(results: Record<string, StoredHealthResult>): void {
  try { storage()?.setItem(RESULTS_KEY, JSON.stringify(results)); } catch { /* Results stay in memory. */ }
}

/** Drops results for models the core no longer publishes. An empty list means not loaded yet. */
export function pruneHealthResults(
  results: Record<string, StoredHealthResult>,
  models: CoreHealthModel[],
): Record<string, StoredHealthResult> {
  if (models.length === 0) return results;
  const names = new Set(models.map((model) => model.name));
  return Object.fromEntries(Object.entries(results).filter(([model]) => names.has(model)));
}

export function readAutoCheckState(): AutoCheckState {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(AUTO_KEY) || '{}');
    const value = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    return {
      enabled: value.enabled !== false,
      lastRunAt: typeof value.lastRunAt === 'number' && Number.isFinite(value.lastRunAt) ? value.lastRunAt : 0,
    };
  } catch {
    return { enabled: true, lastRunAt: 0 };
  }
}

export function saveAutoCheckState(state: AutoCheckState): void {
  try { storage()?.setItem(AUTO_KEY, JSON.stringify(state)); } catch { /* Schedule restarts with the app. */ }
}

export function isAutoCheckDue(state: AutoCheckState, nowMs: number): boolean {
  return state.enabled && (nowMs - state.lastRunAt >= CORE_HEALTH_AUTO_INTERVAL_MS || state.lastRunAt > nowMs);
}
