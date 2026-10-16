import { readString, normalizeAuthIndex } from './managementApi';
import type { AuthFile } from './quotaService';

/** A display pseudonym, not encryption. Independent of list order, locale and quota refreshes. */
export function privateAccountLabel(file: AuthFile, provider: string): string {
  const identity = readString(file, 'name') || readString(file, 'id', 'account_id')
    || normalizeAuthIndex(file.auth_index ?? file.authIndex);
  let hash = 14695981039346656037n;
  for (const byte of new TextEncoder().encode(`${provider}:${identity}`)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1099511628211n);
  }
  return `${provider}-account-${hash.toString(36).padStart(13, '0')}.json`;
}

/**
 * The one name an account goes by everywhere: your name for it, else its email, else its file name. With
 * Hide emails on, the private pseudonym instead, so nothing identifying shows.
 */
export function accountDisplayName(file: AuthFile, provider: string, names: Record<string, string>, hideEmails: boolean): string {
  const privateLabel = privateAccountLabel(file, provider);
  if (hideEmails) return privateLabel;
  return names[privateLabel] || readString(file, 'email', 'account', 'label') || readString(file, 'name') || privateLabel;
}
