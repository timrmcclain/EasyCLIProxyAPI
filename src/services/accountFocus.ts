import { dedupeAuthFiles, parseAuthFilePriority } from './authFiles';
import { managementApi, responseList } from './managementApi';
import { fileName, providerForFile, type AuthFile } from './quotaService';

/**
 * "Use this account for an hour": one account at a time is raised above the rest of its provider, then put back.
 * The proxy picks from the highest-ranked group that still has a ready account, so a boosted account that runs
 * out or cools down falls back to the others rather than failing requests.
 */
export type AccountFocus = {
  name: string;
  provider: string;
  originalPriority: number;
  boostedPriority: number;
  until: number;
};

const KEY = 'personal.accountFocus';
export const FOCUS_MS = 60 * 60 * 1000;

const priorityOf = (file: AuthFile) => parseAuthFilePriority(file.priority) ?? 0;
export const providerOf = (file: AuthFile) => String(file.provider ?? file.type ?? providerForFile(file) ?? '');

export function readAccountFocus(): AccountFocus | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? 'null') as AccountFocus | null;
    if (!parsed || typeof parsed.name !== 'string' || typeof parsed.until !== 'number') return null;
    return parsed;
  } catch { return null; }
}

function writeAccountFocus(focus: AccountFocus | null) {
  if (focus) localStorage.setItem(KEY, JSON.stringify(focus));
  else localStorage.removeItem(KEY);
  window.dispatchEvent(new Event('app:account-focus'));
}

/** The priority that puts this account strictly above every other enabled account of its provider. */
export function boostedPriority(files: AuthFile[], target: AuthFile): number {
  const provider = providerOf(target);
  const others = files.filter(file => fileName(file) !== fileName(target) && providerOf(file) === provider && file.disabled !== true);
  const highest = others.reduce((max, file) => Math.max(max, priorityOf(file)), Number.NEGATIVE_INFINITY);
  return Number.isFinite(highest) ? Math.max(priorityOf(target), highest + 1) : priorityOf(target);
}

/** What ending a focus should write: the original priority, unless someone changed the boosted value since. */
export function restorePriority(focus: AccountFocus, current: number | undefined): number | null {
  if (current === undefined || current !== focus.boostedPriority) return null;
  return focus.originalPriority;
}

/** True while a focus on this provider should keep automatic routing from rewriting its priorities. */
export function focusHoldsProvider(focus: AccountFocus | null, provider: string, now: number): boolean {
  return Boolean(focus && focus.provider === provider && now < focus.until);
}

const loadFiles = async () => dedupeAuthFiles(responseList(await managementApi.get('/credentials'), 'files'));
const setPriority = (name: string, priority: number) => managementApi.patch('/credentials/fields', { name, priority });

export async function startAccountFocus(target: AuthFile, now = Date.now()): Promise<AccountFocus> {
  // Only one account at a time: end any earlier focus first so its account gets its own priority back.
  if (readAccountFocus()) await endAccountFocus();
  const files = await loadFiles();
  const current = files.find(file => fileName(file) === fileName(target)) ?? target;
  const focus: AccountFocus = {
    name: fileName(current),
    provider: providerOf(current),
    originalPriority: priorityOf(current),
    boostedPriority: boostedPriority(files, current),
    until: now + FOCUS_MS,
  };
  // Saved before the write, so a crash between the two still leaves enough to put the priority back.
  writeAccountFocus(focus);
  if (focus.boostedPriority !== focus.originalPriority) await setPriority(focus.name, focus.boostedPriority);
  return focus;
}

/** Ends the focus. With automatic quota routing on, routing takes the priorities back instead. */
export async function endAccountFocus(routingOwnsPriorities = false): Promise<void> {
  const focus = readAccountFocus();
  if (!focus) return;
  if (!routingOwnsPriorities) {
    const files = await loadFiles();
    const file = files.find(item => fileName(item) === focus.name);
    const target = restorePriority(focus, file ? priorityOf(file) : undefined);
    if (target !== null) await setPriority(focus.name, target);
  }
  writeAccountFocus(null);
}
