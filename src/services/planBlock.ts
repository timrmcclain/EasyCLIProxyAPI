import { normalizeAuthIndex } from './managementApi';

// Some providers keep a credential "active" while refusing every request because the plan
// doesn't cover the product (Kimi answers 403 "subscription does not have access"). The proxy
// never cools these down, so the only evidence is the refusal itself in the request log.
const PLAN_STATUSES = new Set([402, 403]);
const PLAN_WORDS = /subscription|upgrade your plan|current plan|your plan|billing|payment required|no active plan|not included in your plan/i;

// Claude answers 400 "We've updated our Consumer Terms and Privacy Policy. You'll need to accept them…": the sign-in and
// quota are fine, but nothing works until the terms are accepted on the provider's website.
const TERMS_STATUSES = new Set([400, 403]);
const TERMS_WORDS = /(terms|privacy policy)/i;
const TERMS_ACTION = /(accept|agree|updated)/i;

type Failure = { failure_status?: number; failure_body?: string };
type Counted = { success?: unknown; failed?: unknown; recent_requests?: unknown; recentRequests?: unknown };
/** What blocks an account that looks fine otherwise: a plan that doesn't cover the service, or terms to accept. */
export type PlanBlock = { kind: 'plan' | 'terms'; message: string };

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

/** The provider's own words when a failure says terms must be accepted first; otherwise null. */
export function termsBlockFromFailure(failure: Failure): string | null {
  if (!failure.failure_status || !TERMS_STATUSES.has(failure.failure_status) || !failure.failure_body) return null;
  const message = providerMessage(failure.failure_body);
  return TERMS_WORDS.test(message) && TERMS_ACTION.test(message) ? message.slice(0, 280) : null;
}

/** Either kind of block in a failure; terms come first, since a plan message can mention terms in passing. */
export function blockFromFailure(failure: Failure): PlanBlock | null {
  const terms = termsBlockFromFailure(failure);
  if (terms) return { kind: 'terms', message: terms };
  const plan = planBlockFromFailure(failure);
  return plan ? { kind: 'plan', message: plan } : null;
}

/**
 * Worth explaining: accounts that have failed but never succeeded since the proxy started, and accounts whose
 * latest requests all failed (a terms change can stop an account that worked yesterday).
 */
export function needsPlanCheck(file: Counted): boolean {
  if (file.success === 0 && typeof file.failed === 'number' && file.failed > 0) return true;
  const recent = file.recent_requests ?? file.recentRequests;
  if (!Array.isArray(recent)) return false;
  const latest = [...recent].reverse().find((bucket) => bucket && (Number(bucket.success) > 0 || Number(bucket.failed) > 0));
  return Boolean(latest) && Number(latest.failed) > 0 && !(Number(latest.success) > 0);
}

/** Copy plan-block messages (keyed by auth index) onto the matching account records. */
export function withPlanBlocks<T extends Record<string, unknown>>(files: T[], blocks: Record<string, string | PlanBlock>): T[] {
  if (!Object.keys(blocks).length) return files;
  return files.map((file) => {
    const index = normalizeAuthIndex(file.auth_index ?? file.authIndex);
    const block = index ? blocks[index] : undefined;
    if (!block) return file;
    const { kind, message } = typeof block === 'string' ? { kind: 'plan' as const, message: block } : block;
    return { ...file, plan_block_message: message, plan_block_kind: kind };
  });
}

/** Look up the latest failure for each never-successful account; returns plan-block messages by auth index. */
export async function loadPlanBlocks(files: Record<string, unknown>[]): Promise<Record<string, PlanBlock>> {
  const { invoke } = await import('@tauri-apps/api/core');
  const blocks: Record<string, PlanBlock> = {};
  const suspects = files.filter(needsPlanCheck);
  const providers = [...new Set(suspects.map((file) => String(file.provider ?? file.type ?? '').trim()).filter(Boolean))];
  await Promise.all(providers.map(async (provider) => {
    const page = await invoke<{ items: (Failure & { auth_index?: string })[] }>('get_usage_events',
      { query: { provider, failed: true, canceled: false, page: 1, page_size: 50 } });
    for (const file of suspects.filter((candidate) => String(candidate.provider ?? candidate.type ?? '').trim() === provider)) {
      const index = normalizeAuthIndex(file.auth_index ?? file.authIndex);
      const latest = page.items.find((item) => normalizeAuthIndex(item.auth_index) === index);
      const block = latest ? blockFromFailure(latest) : null;
      if (index && block) blocks[index] = block;
    }
  }));
  return blocks;
}
