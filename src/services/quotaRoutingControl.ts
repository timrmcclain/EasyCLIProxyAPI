import { dedupeAuthFiles, parseAuthFilePriority } from './authFiles';
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

/** Writes the soonest-reset-first order as account priorities, only where it changed. Returns how many changed. */
export async function applyQuotaRouting(files?: AuthFile[]): Promise<number> {
  if (!readQuotaRoutingPreference()) return 0;
  const changes = priorityChanges(routingPlan(files ?? await loadFiles(), getQuotaCacheSnapshot(), Date.now()));
  for (const change of changes) await setPriority(change.file, change.priority);
  return changes.length;
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
export async function disableQuotaRouting(): Promise<number> {
  saveDashboardPreference('quotaRouting', 'false');
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
}
