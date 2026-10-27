/**
 * First-run setup: the four things that have to be true before the hub does anything for you, read from the
 * hub's real state rather than from which buttons were pressed. Done means the request went through.
 */
export type SetupStepId = 'proxy' | 'account' | 'app' | 'request';
export type SetupView = 'hidden' | 'steps' | 'celebrate';
export type SetupAppStatus = {
  id: string; name?: string; installed: boolean; configValid?: boolean; connectionState?: string; error?: string | null;
};

export const SETUP_STATE_KEY = 'personal.setupChecklist';
export const SETUP_TEST_KEY = 'personal.setupTestPassed';
export const SHOW_SETUP_EVENT = 'app:show-setup';
const STEP_ORDER: SetupStepId[] = ['proxy', 'account', 'app', 'request'];

/** Apps that point at the hub now. Installed is not connected, and a broken config is not connected either. */
export function connectedAppNames(statuses: SetupAppStatus[]): string[] {
  return statuses.filter(status => status.installed && status.connectionState === 'configured' && !status.error && status.configValid !== false)
    .map(status => status.name || status.id);
}

export function setupProgress(input: { coreRunning: boolean; accounts: number; apps: string[]; requestSeen: boolean }) {
  const done: Record<SetupStepId, boolean> = {
    proxy: input.coreRunning, account: input.accounts > 0, app: input.apps.length > 0, request: input.requestSeen,
  };
  const steps = STEP_ORDER.map(id => ({ id, done: done[id] }));
  const doneCount = steps.filter(step => step.done).length;
  return { steps, doneCount, total: steps.length, current: steps.find(step => !step.done)?.id ?? null, complete: doneCount === steps.length };
}

/**
 * Shown until set up, then a "you're set up" moment, but only to someone who watched it get there: a hub that
 * was already set up when it opened closes the steps quietly. Hidden or finished stays that way until asked for.
 */
export function setupView(input: { stored: string; complete: boolean; everIncomplete: boolean; forced: boolean }): SetupView {
  if (input.forced) return input.complete ? 'celebrate' : 'steps';
  if (input.stored) return 'hidden';
  if (!input.complete) return 'steps';
  return input.everIncomplete ? 'celebrate' : 'hidden';
}

// Like a pending Settings category: from another page the event fires before Overview has mounted to hear it.
let pendingShow = false;
/** Brings the setup steps back on Overview, from the command palette. */
export function requestSetupSteps() {
  pendingShow = true;
  try { localStorage.removeItem(SETUP_STATE_KEY); } catch { /* Shown for this session only. */ }
  window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'home' }));
  window.dispatchEvent(new CustomEvent(SHOW_SETUP_EVENT));
}

export function takePendingSetupSteps(): boolean {
  const pending = pendingShow;
  pendingShow = false;
  return pending;
}
