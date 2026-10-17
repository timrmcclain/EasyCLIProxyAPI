import { invoke } from '@tauri-apps/api/core';
import { readTemplatePath } from './templateConfig';

/** The one setting that lets Antigravity spend paid credits after its included quota runs out. */
export const ANTIGRAVITY_PAID_FALLBACK_PATH = 'oauth.providers.antigravity.antigravity-credits';

/** Whether the proxy will spend Antigravity credits once included quota is used: the setting, its older name, or the proxy's default (on). */
export function antigravityPaidFallback(config: unknown): boolean {
  for (const path of [ANTIGRAVITY_PAID_FALLBACK_PATH.split('.'), ['quota-exceeded', 'antigravity-credits']]) {
    const { exists, value } = readTemplatePath(config, path);
    if (exists && typeof value === 'boolean') return value;
  }
  return true;
}

/** Null when the config can't be read: then Overview says nothing rather than guessing. */
export async function loadAntigravityPaidFallback(): Promise<boolean | null> {
  try { return antigravityPaidFallback(await invoke<Record<string, unknown>>('get_extended_core_config')); }
  catch { return null; }
}
