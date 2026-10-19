import { focusHoldsProvider, readAccountFocus } from './accountFocus';
import { dedupeAuthFiles, parseAuthFilePriority } from './authFiles';
import { managementApi, normalizeAuthIndex, responseList } from './managementApi';
import type { PlanBlock } from './planBlock';
import { fileName, providerForFile, type AuthFile } from './quotaService';

/**
 * Keeps requests away from an account the provider refuses outright (terms to accept, a plan that doesn't cover it).
 * The proxy treats those refusals as faults in the request, so it never cools the account down and keeps picking it.
 * The hub moves the account's priority below the rest of its provider instead: the proxy uses the highest-ranked
 * account that's ready, so requests go to the others, and the blocked one is still a last resort. The old priority
 * comes back once the block clears, or when you say you've dealt with it.
 */
export type Demotion = { provider: string; originalPriority: number; demotedPriority: number; kind: PlanBlock['kind']; since: number };
type State = { demoted: Record<string, Demotion>; released: Record<string, number> };
export type RoutingChange = { name: string; priority: number };

const KEY = 'personal.blockedRouting';

const priorityOf = (file: AuthFile) => parseAuthFilePriority(file.priority) ?? 0;
const providerOf = (file: AuthFile) => String(file.provider ?? file.type ?? providerForFile(file) ?? '');

export function readBlockedRouting(): State {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<State>;
    return { demoted: parsed.demoted ?? {}, released: parsed.released ?? {} };
  } catch { return { demoted: {}, released: {} }; }
}
function writeBlockedRouting(state: State) {
  localStorage.setItem(KEY, JSON.stringify(state));
  window.dispatchEvent(new Event('app:blocked-routing'));
}

/** Names of accounts the hub has moved down; quota routing leaves these alone. */
export const demotedNames = () => new Set(Object.keys(readBlockedRouting().demoted));

/** Just below every other enabled account of the same provider, or null when there is nothing else to use. */
export function priorityBelowOthers(files: AuthFile[], target: AuthFile): number | null {
  const provider = providerOf(target);
  const others = files.filter(file => fileName(file) !== fileName(target) && providerOf(file) === provider && file.disabled !== true);
  if (!others.length) return null;
  return Math.min(...others.map(priorityOf)) - 1;
}

/**
 * What to write so blocked accounts sit at the bottom and cleared ones get their priority back. Pure: takes the
 * accounts, the blocks found in the request log (by auth index, with the failure's time) and the saved state.
 */
export function planBlockedRouting(files: AuthFile[], blocks: Record<string, PlanBlock & { at?: number }>, state: State, now: number,
  /** Accounts whose priority something else is holding right now ("use first for an hour"). */
  held: (file: AuthFile) => boolean = () => false): { changes: RoutingChange[]; state: State } {
  const next: State = { demoted: { ...state.demoted }, released: { ...state.released } };
  const changes: RoutingChange[] = [];
  const byName = new Map(files.map(file => [fileName(file), file]));
  const blockFor = (file: AuthFile) => {
    const index = normalizeAuthIndex(file.auth_index ?? file.authIndex);
    const block = index ? blocks[index] : undefined;
    // A failure from before you said you'd fixed it is old news.
    const released = next.released[fileName(file)];
    return block && !(released && (block.at ?? 0) <= released) ? block : undefined;
  };

  for (const [name, demotion] of Object.entries(state.demoted)) {
    const file = byName.get(name);
    if (!file) { delete next.demoted[name]; continue; }
    const current = priorityOf(file);
    // Someone else set this account's priority (you, or "use first for an hour"): their choice wins, and the
    // refusals so far no longer count against it.
    if (current !== demotion.demotedPriority) { delete next.demoted[name]; next.released[name] = now; continue; }
    if (!blockFor(file)) {
      changes.push({ name, priority: demotion.originalPriority });
      delete next.demoted[name];
      continue;
    }
    // Another account moved lower since: stay below it.
    const below = priorityBelowOthers(files, file);
    if (below !== null && below < current) {
      changes.push({ name, priority: below });
      next.demoted[name] = { ...demotion, demotedPriority: below };
    }
  }

  for (const file of files) {
    const name = fileName(file);
    if (next.demoted[name] || file.disabled === true || held(file)) continue;
    const block = blockFor(file);
    if (!block) continue;
    const below = priorityBelowOthers(files, file);
    if (below === null || below >= priorityOf(file)) continue;
    changes.push({ name, priority: below });
    next.demoted[name] = { provider: providerOf(file), originalPriority: priorityOf(file), demotedPriority: below, kind: block.kind, since: now };
  }
  return { changes, state: next };
}

/** Applies the plan through the proxy. Returns how many accounts changed. */
export async function syncBlockedRouting(files: AuthFile[], blocks: Record<string, PlanBlock & { at?: number }>, now = Date.now()): Promise<number> {
  const focus = readAccountFocus();
  const { changes, state } = planBlockedRouting(files, blocks, readBlockedRouting(), now, file => focusHoldsProvider(focus, providerOf(file), now));
  for (const change of changes) await managementApi.patch('/credentials/fields', { name: change.name, priority: change.priority });
  if (changes.length || JSON.stringify(state) !== JSON.stringify(readBlockedRouting())) writeBlockedRouting(state);
  return changes.length;
}

/** "I've accepted the terms": the account gets its priority back now, and older failures no longer count against it. */
export async function releaseBlockedAccount(name: string, now = Date.now()): Promise<void> {
  const state = readBlockedRouting();
  const demotion = state.demoted[name];
  // The live priority, not a page's copy that may predate the move.
  const file = demotion && dedupeAuthFiles(responseList(await managementApi.get('/credentials'), 'files')).find(item => fileName(item) === name);
  if (demotion && file && priorityOf(file) === demotion.demotedPriority) {
    await managementApi.patch('/credentials/fields', { name, priority: demotion.originalPriority });
  }
  delete state.demoted[name];
  state.released[name] = now;
  writeBlockedRouting(state);
}
