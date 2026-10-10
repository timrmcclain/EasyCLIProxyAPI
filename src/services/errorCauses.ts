/** Groups failed requests by why they failed, so a wall of 429s and 500s reads as a few causes with a fix each. */

export type ErrorCause = 'rateLimit' | 'plan' | 'billing' | 'signIn' | 'model' | 'provider' | 'connection' | 'other';
/** Page a cause's fix lives on; causes without one (provider outages, dropped connections) just need a retry. */
export type ErrorCauseTarget = 'oauth' | undefined;

export type FailedRequest = {
  timestamp: string;
  provider: string;
  source_display?: string;
  source: string;
  failure_status: number;
  failure_body: string;
};

export type ErrorCauseGroup = {
  cause: ErrorCause;
  count: number;
  lastSeen: string;
  /** Providers involved, most failures first. */
  providers: { name: string; count: number }[];
  /** Status codes seen for this cause, most common first. */
  statuses: number[];
  /** The newest failure's message, trimmed, so the group can show what the provider actually said. */
  example: string;
  target: ErrorCauseTarget;
};

const has = (text: string, ...needles: string[]) => needles.some(needle => text.includes(needle));

export function classifyFailure(status: number, body: string): ErrorCause {
  const text = body.toLowerCase();
  if (status === 402 || has(text, 'billing', 'payment method')) return 'billing';
  if (has(text, 'subscription does not have access', 'upgrade your plan', 'not included in your plan', "plan doesn't include")) return 'plan';
  if (status === 429 || has(text, 'rate_limit', 'rate limit', 'resource_exhausted', 'resource has been exhausted', 'quota', 'usage_limit', 'usage limit')) return 'rateLimit';
  if (status === 401 || has(text, 'authentication_error', 'token has been revoked', 'invalid_grant', 'token expired', 'unauthorized')) return 'signIn';
  if (status === 404 || has(text, 'not_found_error', 'model not found', 'not available on this endpoint', 'does not exist')) return 'model';
  if (status === 403) return 'plan';
  if (status === 408 || status === 0 || has(text, 'stream disconnected', 'stream closed', 'timeout', 'timed out', 'connection reset', 'eof')) return 'connection';
  if (status >= 500 || has(text, 'overloaded', 'internal error', 'bad gateway', 'upstream error')) return 'provider';
  return 'other';
}

const targets: Record<ErrorCause, ErrorCauseTarget> = {
  rateLimit: 'oauth', plan: 'oauth', billing: 'oauth', signIn: 'oauth', model: 'oauth',
  provider: undefined, connection: undefined, other: undefined,
};

/** Pulls the human sentence out of a provider's JSON error, falling back to the raw text. */
export function failureMessage(body: string): string {
  const raw = body.trim();
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof parsed.error === 'object' && parsed.error ? parsed.error.message : parsed.message ?? parsed.error;
    if (typeof message === 'string' && message.trim()) return trim(message);
  } catch { /* not JSON */ }
  if (/^<html/i.test(raw)) return trim(raw.replace(/<[^>]+>/g, ' '));
  return trim(raw);
}

const trim = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 180 ? `${flat.slice(0, 177)}…` : flat;
};

const rank = (counts: Map<string | number, number>) => [...counts].sort((a, b) => b[1] - a[1]);

/** Worst first: most failures, then most recent. Expects requests newest first, as the proxy returns them. */
export function groupFailures(requests: FailedRequest[]): ErrorCauseGroup[] {
  const groups = new Map<ErrorCause, { requests: FailedRequest[]; providers: Map<string, number>; statuses: Map<number, number> }>();
  for (const request of requests) {
    const cause = classifyFailure(request.failure_status, request.failure_body ?? '');
    const group = groups.get(cause) ?? { requests: [] as FailedRequest[], providers: new Map<string, number>(), statuses: new Map<number, number>() };
    group.requests.push(request);
    const provider = request.provider || request.source_display || request.source || '—';
    group.providers.set(provider, (group.providers.get(provider) ?? 0) + 1);
    if (request.failure_status) group.statuses.set(request.failure_status, (group.statuses.get(request.failure_status) ?? 0) + 1);
    groups.set(cause, group);
  }
  return [...groups].map(([cause, group]): ErrorCauseGroup => {
    const newest = group.requests.reduce((a, b) => (Date.parse(b.timestamp) > Date.parse(a.timestamp) ? b : a));
    return {
      cause,
      count: group.requests.length,
      lastSeen: newest.timestamp,
      providers: rank(group.providers).map(([name, count]) => ({ name: String(name), count })),
      statuses: rank(group.statuses).map(([status]) => Number(status)),
      example: failureMessage(newest.failure_body ?? ''),
      target: targets[cause],
    };
  }).sort((a, b) => b.count - a.count || Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
}
