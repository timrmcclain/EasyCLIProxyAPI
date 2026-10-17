import { invoke } from '@tauri-apps/api/core';
import { useEffect, useSyncExternalStore } from 'react';
import { readDashboardPreference, saveDashboardPreference } from './dashboardPreferences';

/** One provider's public status page, as the backend read it. */
export type ProviderStatus = { provider: string; indicator: string; description: string; pageUrl: string };

const CHECK_EVERY_MS = 5 * 60_000;
export const OUTAGE_BADGES_EVENT = 'app:outage-badges';

/** Off unless turned on in Settings → App preferences: it's the only setting that makes the hub contact outside sites on its own. */
export function readOutageBadgesPreference(): boolean {
  return readDashboardPreference('outageBadges', ['true', 'false'], 'false') === 'true';
}

export function saveOutageBadgesPreference(enabled: boolean): void {
  saveDashboardPreference('outageBadges', String(enabled));
  if (!enabled) setStatuses([]);
  window.dispatchEvent(new CustomEvent(OUTAGE_BADGES_EVENT, { detail: enabled }));
}

const problems = ['minor', 'major', 'critical', 'maintenance'] as const;
export type Outage = ProviderStatus & { indicator: (typeof problems)[number] };

/** Only real problems get a badge; "all clear" and unreadable feeds show nothing. */
export function outageFor(statuses: ProviderStatus[], provider: string | undefined): Outage | undefined {
  const status = statuses.find((item) => item.provider === provider);
  return status && (problems as readonly string[]).includes(status.indicator) ? status as Outage : undefined;
}

let statuses: ProviderStatus[] = [];
const listeners = new Set<() => void>();
const none: ProviderStatus[] = [];
function setStatuses(next: ProviderStatus[]) { statuses = next; listeners.forEach((listener) => listener()); }

async function check() {
  if (!readOutageBadgesPreference()) return;
  try { setStatuses(await invoke<ProviderStatus[]>('get_provider_status')); } catch { /* keep the last result */ }
}

let users = 0;
let timer: number | undefined;
/** Checks while at least one view shows badges and the setting is on; stops otherwise. */
export function useProviderStatus(): ProviderStatus[] {
  useEffect(() => {
    users += 1;
    const start = () => {
      if (timer !== undefined || !readOutageBadgesPreference()) return;
      void check();
      timer = window.setInterval(() => void check(), CHECK_EVERY_MS);
    };
    const stop = () => { if (timer !== undefined) window.clearInterval(timer); timer = undefined; };
    const changed = (event: Event) => ((event as CustomEvent<boolean>).detail ? start() : stop());
    start();
    window.addEventListener(OUTAGE_BADGES_EVENT, changed);
    return () => {
      window.removeEventListener(OUTAGE_BADGES_EVENT, changed);
      users -= 1;
      if (users === 0) stop();
    };
  }, []);
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => statuses, () => none);
}
