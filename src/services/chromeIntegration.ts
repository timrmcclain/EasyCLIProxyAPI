import { invoke } from '@tauri-apps/api/core';

/** One Chromium browser as the hub sees it (src-tauri/src/chrome_integration.rs). */
export type ChromeBrowserState = {
  id: 'chrome' | 'edge';
  name: string;
  installed: boolean;
  extensionVersion: string | null;
  extensionTooOld: boolean;
  /** Claude Code's native messaging host is registered for this browser. */
  linked: boolean;
};

export type ChromeIntegration = {
  browsers: ChromeBrowserState[];
  /** Claude Code uses a token or API key, which keeps its Chrome integration off. */
  tokenAuth: boolean;
  /** ...and that token sends it through a proxy on this computer (usually this hub). */
  routedThroughLocalProxy: boolean;
  /** A Chrome session (its own config folder, no token) has been signed in with /login. */
  sessionSignedIn: boolean;
  sessionDir: string;
  storeUrl: string;
};

export type ChromeStep = 'extension' | 'signIn' | 'link';

/** Where setup stands: each step done or not, and whether everything is ready. */
export function chromeProgress(state: ChromeIntegration) {
  const present = state.browsers.filter(browser => browser.installed);
  const extension = present.some(browser => browser.extensionVersion && !browser.extensionTooOld);
  const signIn = !state.tokenAuth || state.sessionSignedIn;
  const link = present.some(browser => browser.extensionVersion && browser.linked);
  return { extension, signIn, link, ready: extension && signIn && link, noBrowser: present.length === 0 };
}

export const chromeApi = {
  status: () => invoke<ChromeIntegration>('get_chrome_integration'),
  openClaudeCode: () => invoke('launch_agent', { client: 'claude-code', chrome: true }),
};
