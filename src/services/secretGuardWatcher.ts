import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { getCurrentLocale, translate } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { readDesktopAlertsPreference } from './dashboardPreferences';
import { freshFindings, readPolicy, secretGuardApp, secretGuardService, SECRET_GUARD_PROVIDERS, type SecretGuardPolicy } from './secretGuard';
import { pluginsApi } from './plugins';

const CHECK_EVERY_MS = 30_000;
const SEEN_KEY = 'personal.secretGuard.notified';
const MAX_SEEN = 500;

function readSeen(): Set<string> | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : null;
  } catch { return null; }
}

function writeSeen(seen: Set<string>) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-MAX_SEEN))); } catch { /* storage full or blocked */ }
}

const KINDS = new Set(['github_token', 'anthropic_key', 'openai_key', 'google_api_key', 'aws_access_key', 'slack_token', 'stripe_key',
  'azure_storage_key', 'azure_client_secret', 'private_key', 'jwt', 'connection_string_password', 'password_assignment']);

/**
 * Raises a Windows notification the first time Secret Guard finds each secret, even with the window hidden
 * in the tray. Reads the plugin's findings file every 30 seconds; nothing runs until there's something new.
 */
export function startSecretGuardWatcher(): () => void {
  let stopped = false;
  let seen = readSeen();
  const check = async () => {
    try {
      const findings = await secretGuardService.findings();
      if (stopped) return;
      // The allowlist lives in the proxy's config; without the proxy, treat nothing as allowed.
      let policy: SecretGuardPolicy = { defaultMode: 'report', modes: {}, allow: [] };
      try { policy = readPolicy(await pluginsApi.getConfig('secret-guard')); } catch { /* proxy down */ }
      const result = freshFindings(seen, findings, policy);
      seen = result.seen;
      writeSeen(seen);
      if (!result.fresh.length || !readDesktopAlertsPreference()) return;
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === 'granted';
      if (!granted || stopped) return;
      const locale = getCurrentLocale();
      // More than three at once reads as noise; the Secret Guard page has the full list.
      for (const item of result.fresh.slice(0, 3)) {
        const provider = item.providers[0] ?? 'other';
        const providerKey = (SECRET_GUARD_PROVIDERS as readonly string[]).includes(provider) ? provider : 'other';
        const values = {
          app: secretGuardApp(item.clients[0] ?? '') || 'An app',
          kind: translate(locale, `sg.kind.${KINDS.has(item.kind) ? item.kind : 'other'}` as MessageKey),
          provider: translate(locale, `sg.provider.${providerKey}` as MessageKey),
        };
        sendNotification({
          title: translate(locale, 'sg.notify.title'),
          body: translate(locale, item.actions.includes('blocked') ? 'sg.notify.bodyBlocked' : 'sg.notify.body', values),
        });
      }
    } catch {
      // The findings file isn't there until Secret Guard has run; try again next time.
    }
  };
  void check();
  const timer = window.setInterval(() => { void check(); }, CHECK_EVERY_MS);
  return () => { stopped = true; window.clearInterval(timer); };
}
