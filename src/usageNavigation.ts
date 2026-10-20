// Lets another page open Activity already filtered (e.g. Overview's "7 failed" link).
// Kept until Activity mounts and reads it, since navigation and mounting happen in that order.
export type UsageJump = { result?: 'failed'; range: '24h' | '7d'; source?: string };

let pending: UsageJump | null = null;

/** Fired after a jump is queued, so an Activity page that is already open applies it too. */
export const USAGE_JUMP_EVENT = 'app:usage-jump';

function openActivity() {
  window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'usage-records' }));
  window.dispatchEvent(new Event(USAGE_JUMP_EVENT));
}

export function requestFailedRequests() {
  pending = { result: 'failed', range: '24h' };
  openActivity();
}

/** Opens Activity's request list showing one account's last week. */
export function requestAccountRequests(source: string) {
  pending = { range: '7d', source };
  openActivity();
}

// One request to open in Activity's request details, e.g. from a Secret Guard finding.
let pendingRequest: string | null = null;

export function requestRequestDetail(requestId: string) {
  pending = { range: '7d' };
  pendingRequest = requestId;
  openActivity();
}

/** The request waiting to be opened. It stays pending until clearPendingRequestDetail, so a remount (React's
 *  development double-run, or a reload of the list) still finds it. */
export function peekPendingRequestDetail(): string | null {
  return pendingRequest;
}

export function clearPendingRequestDetail(id: string) {
  if (pendingRequest === id) pendingRequest = null;
}

export function takePendingUsageJump(): UsageJump | null {
  const jump = pending;
  pending = null;
  return jump;
}
