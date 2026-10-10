import { authFileHealth } from './authFileHealth';
import { quotaAvailability } from './quotaAvailability';
import { providerForFile, quotaKey, type AuthFile, type QuotaState } from './quotaService';
import type { ModelOption } from './modelService';

const blockedKinds = new Set(['exhausted', 'unavailable', 'limited', 'resetDue']);

/** True when every enabled Claude account is out right now, so Claude Code requests would fail. */
export function claudeAllOut(files: AuthFile[], quotas: Record<string, QuotaState>, now: number): boolean {
  const claude = files.filter(file => providerForFile(file) === 'claude' && !authFileHealth(file).disabled);
  return claude.length > 0 && claude.every(file => blockedKinds.has(quotaAvailability(file, quotas[quotaKey(file)], now).kind));
}

/** Models the proxy serves from other providers, which Claude Code can switch to while Claude is out. */
export function fallbackModels(models: ModelOption[]): string[] {
  const names = models.map(model => model.alias || model.name).filter(name => name && !/^claude/i.test(name));
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}
