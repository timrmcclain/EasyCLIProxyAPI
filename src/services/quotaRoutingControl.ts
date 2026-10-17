import { dedupeAuthFiles, parseAuthFilePriority } from './authFiles';
import { focusHoldsProvider, providerOf, readAccountFocus } from './accountFocus';
import { readDashboardPreference, saveDashboardPreference } from './dashboardPreferences';
import { managementApi, responseList } from './managementApi';
import { getQuotaCacheSnapshot } from './quotaCache';
import { priorityChanges, routingPlan } from './quotaRouting';
import { fileName, providerForFile, quotaKey, type AuthFile } from './quotaService';

/** Your own priorities, saved when the switch goes on so switching it off can put them back. */
const BACKUP_KEY = 'personal.manualPriorities';

export const readQuotaRoutingPreference = () => readDashboardPreference('quotaRouting', ['true', 'false'], 'false') === 'true';

const loadFiles = async () => dedupeAuthFiles(responseList(await managementApi.get('/credentials'), 'files'));
const setPriority = (file: AuthFile, priority: number) => managementApi.patch('/credentials/fields', { name: fileName(file), priority });
const currentPriority = (file: AuthFile) => parseAuthFilePriority(file.priority) ?? 0;

function readBackup(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(BACKUP_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, number> : {};
  } catch { return {}; }
}

// Priority writes run one batch at a time: otherwise a background pass still writing could overwrite the
// priorities that switching routing off has just put back.
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/** Writes the soonest-reset-first order as account priorities, only where it changed. Returns how many changed. */
export function applyQuotaRouting(files?: AuthFile[]): Promise<number> {
  return oneAtATime(async () => {
    if (!readQuotaRoutingPreference()) return 0;
    const now = Date.now();
    const focus = readAccountFocus();
    // An account in use for the hour keeps its raised priority: leave its provider alone until the hour ends.
    const changes = priorityChanges(routingPlan(files ?? await loadFiles(), getQuotaCacheSnapshot(), now))
      .filter(change => !focusHoldsProvider(focus, providerOf(change.file), now));
    let written = 0;
    for (const change of changes) {
      // Switched off mid-pass: stop, and leave the priorities to the restore.
      if (!readQuotaRoutingPreference()) break;
      await setPriority(change.file, change.priority);
      written += 1;
    }
    return written;
  });
}

export async function enableQuotaRouting(): Promise<number> {
  const files = await loadFiles();
  // Keep the first backup if the switch is flipped on twice, so the original priorities are never lost.
  if (!localStorage.getItem(BACKUP_KEY)) {
    const backup = Object.fromEntries(files.filter(file => providerForFile(file)).map(file => [quotaKey(file), currentPriority(file)]));
    localStorage.setItem(BACKUP_KEY, JSON.stringify(backup));
  }
  saveDashboardPreference('quotaRouting', 'true');
  return applyQuotaRouting(files);
}

/** Turns the switch off and restores the priorities saved when it went on. Returns how many were restored. */
export function disableQuotaRouting(): Promise<number> {
  // Saved before waiting, so a pass already running stops at its next write.
  saveDashboardPreference('quotaRouting', 'false');
  return oneAtATime(async () => {
    const backup = readBackup();
    let restored = 0;
    for (const file of await loadFiles()) {
      const saved = backup[quotaKey(file)];
      if (typeof saved !== 'number' || saved === currentPriority(file)) continue;
      await setPriority(file, saved);
      restored += 1;
    }
    localStorage.removeItem(BACKUP_KEY);
    return restored;
  });
}
