import { normalizeAuthIndex } from './managementApi';

// Some providers keep a credential "active" while refusing every request because the plan
// doesn't cover the product (Kimi answers 403 "subscription does not have access"). The proxy
// never cools these down, so the only evidence is the refusal itself in the request log.
const PLAN_STATUSES = new Set([402, 403]);
const PLAN_WORDS = /subscription|upgrade your plan|current plan|your plan|billing|payment required|no active plan|not included in your plan/i;

type Failure = { failure_status?: number; failure_body?: string };
type Counted = { success?: unknown; failed?: unknown };

function providerMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const error = parsed.error;
    const message = typeof error === 'object' && error ? error.message : typeof error === 'string' ? error : parsed.message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  } catch { /* plain-text body */ }
  return body.trim();
}

/** The provider's own words when a failure says the plan doesn't cover this account; otherwise null. */
export function planBlockFromFailure(failure: Failure): string | null {
  if (!failure.failure_status || !PLAN_STATUSES.has(failure.failure_status) || !failure.failure_body) return null;
  const message = providerMessage(failure.failure_body);
  return PLAN_WORDS.test(message) ? message.slice(0, 280) : null;
}

/** Accounts that have failed but never succeeded since the proxy started are worth explaining. */
export function needsPlanCheck(file: Counted): boolean {
  return file.success === 0 && typeof file.failed === 'number' && file.failed > 0;
}

/** Copy plan-block messages (keyed by auth index) onto the matching account records. */
export function withPlanBlocks<T extends Record<string, unknown>>(files: T[], blocks: Record<string, string>): T[] {
  if (!Object.keys(blocks).length) return files;
  return files.map((file) => {
    const index = normalizeAuthIndex(file.auth_index ?? file.authIndex);
    return index && blocks[index] ? { ...file, plan_block_message: blocks[index] } : file;
  });
}

/** Look up the latest failure for each never-successful account; returns plan-block messages by auth index. */
export async function loadPlanBlocks(files: Record<string, unknown>[]): Promise<Record<string, string>> {
  const { invoke } = await import('@tauri-apps/api/core');
  const blocks: Record<string, string> = {};
  const suspects = files.filter(needsPlanCheck);
  const providers = [...new Set(suspects.map((file) => String(file.provider ?? file.type ?? '').trim()).filter(Boolean))];
  await Promise.all(providers.map(async (provider) => {
    const page = await invoke<{ items: (Failure & { auth_index?: string })[] }>('get_usage_events',
      { query: { provider, failed: true, canceled: false, page: 1, page_size: 50 } });
    for (const file of suspects.filter((candidate) => String(candidate.provider ?? candidate.type ?? '').trim() === provider)) {
      const index = normalizeAuthIndex(file.auth_index ?? file.authIndex);
      const latest = page.items.find((item) => normalizeAuthIndex(item.auth_index) === index);
      const message = latest ? planBlockFromFailure(latest) : null;
      if (index && message) blocks[index] = message;
    }
  }));
  return blocks;
}
