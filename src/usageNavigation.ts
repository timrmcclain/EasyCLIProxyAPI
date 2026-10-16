// Lets another page open Activity already filtered (e.g. Overview's "7 failed" link).
// Kept until Activity mounts and reads it, since navigation and mounting happen in that order.
export type UsageJump = { result?: 'failed'; range: '24h' | '7d'; source?: string };

let pending: UsageJump | null = null;

export function requestFailedRequests() {
  pending = { result: 'failed', range: '24h' };
  window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'usage-records' }));
}

/** Opens Activity's request list showing one account's last week. */
export function requestAccountRequests(source: string) {
  pending = { range: '7d', source };
  window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'usage-records' }));
}

export function takePendingUsageJump(): UsageJump | null {
  const jump = pending;
  pending = null;
  return jump;
}
