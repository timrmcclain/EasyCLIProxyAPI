import { getCurrentLocale, translate } from '../i18n';
import type { MessageKey } from '../i18n/resources';

/**
 * What to show when something fails. Backend errors arrive as text that can be raw JSON, prefixed with "Error:",
 * or a transport failure like "os error 10061"; this turns the common ones into a plain cause, in the user's
 * language, and keeps the original after it so nothing useful is lost.
 */
export function readableError(error: unknown): string {
  const raw = errorText(error);
  const cause = knownCause(raw);
  if (!cause) return raw;
  const text = translate(getCurrentLocale(), cause);
  return raw && raw !== text ? `${text} (${raw})` : text;
}

/** The error's own text, without "Error:" prefixes, and the message out of a JSON error body. */
export function errorText(error: unknown): string {
  let text: string;
  if (error instanceof Error) text = error.message;
  else if (typeof error === 'string') text = error;
  else if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    text = typeof value.message === 'string' ? value.message : typeof value.error === 'string' ? value.error : safeJson(error);
  } else text = String(error ?? '');
  text = text.replace(/^(?:Uncaught\s+)?(?:Error:\s*)+/i, '').trim();
  const json = /\{[\s\S]*\}\s*$/.exec(text);
  if (json) {
    const message = jsonMessage(json[0]);
    if (message) text = `${text.slice(0, json.index).replace(/[:\s]+$/, '')}${text.slice(0, json.index).trim() ? ': ' : ''}${message}`;
  }
  return text;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function jsonMessage(body: string): string {
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    const nested = value.error && typeof value.error === 'object' ? value.error as Record<string, unknown> : null;
    const message = nested?.message ?? value.message ?? (typeof value.error === 'string' ? value.error : undefined);
    return typeof message === 'string' ? message.trim() : '';
  } catch {
    return '';
  }
}

function knownCause(text: string): MessageKey | null {
  if (/os error 10061|connection refused|ECONNREFUSED|error sending request|Management API request failed/i.test(text)) return 'error.readable.unreachable';
  if (/timed? ?out|deadline exceeded|os error 10060/i.test(text)) return 'error.readable.timeout';
  if (/Management API error \((401|403)\)/.test(text)) return 'error.readable.managementKey';
  if (/Management API error \(5\d\d\)/.test(text)) return 'error.readable.proxyFailed';
  if (/os error 5\b|Access is denied|permission denied/i.test(text)) return 'error.readable.permission';
  if (/os error 32\b|being used by another process/i.test(text)) return 'error.readable.fileInUse';
  if (/No space left|os error 112\b/i.test(text)) return 'error.readable.diskFull';
  return null;
}
