/**
 * Notices the proxy stopping and coming back. One failed check can be a restart in progress, so the
 * proxy only counts as down after `threshold` failed checks in a row; it counts as back on the first
 * good check after that. A proxy that's starting up is neither.
 */
export type ProxyWatchState = { failures: number; down: boolean };
export type ProxyWatchAlert = 'down' | 'back' | null;

export const initialProxyWatch: ProxyWatchState = { failures: 0, down: false };

export function nextProxyWatch(state: ProxyWatchState, status: { ready: boolean; starting: boolean } | null, threshold = 2): { state: ProxyWatchState; alert: ProxyWatchAlert } {
  if (status?.starting) return { state, alert: null };
  if (status?.ready) return { state: { failures: 0, down: false }, alert: state.down ? 'back' : null };
  const failures = state.failures + 1;
  const down = state.down || failures >= threshold;
  return { state: { failures, down }, alert: down && !state.down ? 'down' : null };
}
