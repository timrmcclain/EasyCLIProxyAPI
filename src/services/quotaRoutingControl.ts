import { dedupeAuthFiles } from './authFiles';
import { focusHoldsProvider, providerOf, readAccountFocus } from './accountFocus';
import { demotedNames } from './blockedRouting';
import { managementApi, responseList } from './managementApi';
import { getQuotaCacheSnapshot } from './quotaCache';
import type { AuthFile } from './quotaService';
import {
  priorityWrites, readRoutingState, recordSmartChange, routingPlans, withProviderChange, writeRoutingState,
  type ProviderPlan, type RoutingSnapshot, type RoutingState,
} from './routingOrder';

/**
 * Keeps the proxy's account priorities in step with the routing order in Settings → Routing: in "Your order" it
 * writes the order you saved, in Smart it rewrites it as quota and reset times change.
 */

const loadFiles = async () => dedupeAuthFiles(responseList(await managementApi.get('/credentials'), 'files'));
const setPriority = (name: string, priority: number) => managementApi.patch('/credentials/fields', { name, priority });

// Priority writes run one batch at a time, so a background pass can't interleave with a change you just saved.
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function writePlans(plans: ProviderPlan[], state: RoutingState, now: number, logSmart: boolean): Promise<number> {
  const focus = readAccountFocus();
  const demoted = demotedNames();
  let written = 0;
  let next = state;
  for (const plan of plans) {
    // An account in use for the hour keeps its raised priority: leave its provider alone until the hour ends.
    if (plan.entries.some(entry => focusHoldsProvider(focus, providerOf(entry.file), now))) continue;
    // An account the provider refuses stays at the bottom until that clears.
    const writes = priorityWrites(plan).filter(write => !demoted.has(write.name));
    for (const write of writes) {
      await setPriority(write.name, write.priority);
      written += 1;
    }
    if (writes.length && logSmart && plan.mode === 'smart') next = recordSmartChange(next, plan.provider, plan.entries.map(entry => entry.key), now);
  }
  if (next !== state) writeRoutingState(next);
  return written;
}

/** Writes the current order for every provider, only where the proxy's order differs. Returns how many changed. */
export function applyQuotaRouting(files?: AuthFile[]): Promise<number> {
  return oneAtATime(async () => {
    const now = Date.now();
    const state = readRoutingState();
    return writePlans(routingPlans(files ?? await loadFiles(), getQuotaCacheSnapshot(), now, state), state, now, true);
  });
}

/** Saves your choices for one provider and applies them now. */
export function saveProviderRouting(provider: string, next: RoutingSnapshot, order: string[]): Promise<number> {
  return oneAtATime(async () => {
    const now = Date.now();
    const state = withProviderChange(readRoutingState(), provider, next, 'you', order, now);
    writeRoutingState(state);
    const plans = routingPlans(await loadFiles(), getQuotaCacheSnapshot(), now, state).filter(plan => plan.provider === provider);
    return writePlans(plans, state, now, false);
  });
}

/** Puts one provider back the way it was before your last change to it. */
export async function undoProviderRouting(provider: string): Promise<boolean> {
  const last = [...readRoutingState().history].reverse().find(entry => entry.provider === provider && entry.by === 'you' && entry.before);
  if (!last?.before) return false;
  await saveProviderRouting(provider, last.before, last.before.provider.order);
  return true;
}
