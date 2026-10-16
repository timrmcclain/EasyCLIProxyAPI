import { useEffect, useState } from 'react';
import { dedupeAuthFiles } from './authFiles';
import { readDashboardPreference } from './dashboardPreferences';
import { managementApi, readString, responseList } from './managementApi';
import { labelFor } from './quotaWatcher';

// Request records name the account that served them by its email (the proxy's "source"). This turns that
// into the same label the rest of the hub uses: your own name for it, or a private label when emails are hidden.
const REFRESH_MS = 5 * 60_000;
let cache: { at: number; labels: Map<string, string> } | null = null;
let loading: Promise<Map<string, string>> | null = null;

function loadLabels(): Promise<Map<string, string>> {
  if (cache && Date.now() - cache.at < REFRESH_MS) return Promise.resolve(cache.labels);
  loading ??= managementApi.get('/credentials')
    .then(payload => {
      const labels = new Map<string, string>();
      for (const file of dedupeAuthFiles(responseList(payload, 'files'))) {
        const label = labelFor(file);
        for (const key of [readString(file, 'email'), readString(file, 'label'), readString(file, 'name')]) {
          if (key) labels.set(key.toLowerCase(), label);
        }
      }
      cache = { at: Date.now(), labels };
      return labels;
    })
    .catch(() => cache?.labels ?? new Map<string, string>())
    .finally(() => { loading = null; });
  return loading;
}

/** "t•••@gmail.com": enough to tell accounts apart without showing the address. */
export function maskEmail(value: string): string {
  const at = value.indexOf('@');
  return at > 0 ? `${value[0]}•••${value.slice(at)}` : value;
}

/** Returns a function mapping a request's source to the account's display label. */
export function useAccountLabelBySource(): (source: string) => string {
  const [labels, setLabels] = useState<Map<string, string>>(() => cache?.labels ?? new Map());
  useEffect(() => {
    let active = true;
    void loadLabels().then(next => { if (active) setLabels(next); });
    return () => { active = false; };
  }, []);
  const hide = readDashboardPreference('hideEmails', ['true', 'false'], 'false') === 'true';
  return (source: string) => {
    if (!source) return '';
    return labels.get(source.toLowerCase()) ?? (hide ? maskEmail(source) : source);
  };
}
