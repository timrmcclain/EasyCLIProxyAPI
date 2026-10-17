export const oauthSubpages = [
  { id: 'login', labelKey: 'oauth.title' },
  { id: 'authFiles', labelKey: 'authFiles.title' },
] as const;

export type OAuthSubpage = (typeof oauthSubpages)[number]['id'];

// Lets another page open Accounts on a specific tab (e.g. Quota Lookup's "Sign in again").
// Kept until Accounts mounts and reads it, since navigation and mounting happen in that order.
let pendingSubpage: OAuthSubpage | null = null;
export const OAUTH_SUBPAGE_EVENT = 'app:oauth-subpage';

export function requestOAuthSubpage(subpage: OAuthSubpage) {
  pendingSubpage = subpage;
  window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'oauth' }));
  window.dispatchEvent(new CustomEvent(OAUTH_SUBPAGE_EVENT, { detail: subpage }));
}

// The provider "Sign in again" was clicked for, so the sign-in tab can bring that provider's button into view.
let pendingProvider: string | null = null;

/** Opens the sign-in tab with this provider's sign-in ready to start. */
export function requestSignIn(provider?: string) {
  pendingProvider = provider?.toLowerCase() || null;
  requestOAuthSubpage('login');
}

export function takePendingSignInProvider(): string | null {
  const provider = pendingProvider;
  pendingProvider = null;
  return provider;
}

export function takePendingOAuthSubpage(): OAuthSubpage | null {
  const subpage = pendingSubpage;
  pendingSubpage = null;
  return subpage;
}

/** True for quota errors that mean the saved sign-in no longer works, not a transient failure. */
export function isSignInExpiredError(message: string | undefined) {
  return Boolean(message) && /\b401\b|unauthori[sz]ed|invalid[_ ]grant|token (has )?expired|expired token|refresh token|re-?authenticate|sign in again|login again/i.test(message!);
}

// Accounts shows either the account list or every account's quota (what Quota Lookup used to show).
export type AccountsView = 'list' | 'quotas';
let pendingView: AccountsView | null = null;
export const ACCOUNTS_VIEW_EVENT = 'app:accounts-view';

/** Opens Accounts on the given view; Quota Lookup links land on 'quotas'. */
export function requestAccountsView(view: AccountsView) {
  pendingView = view;
  window.dispatchEvent(new CustomEvent(ACCOUNTS_VIEW_EVENT, { detail: view }));
}

export function takePendingAccountsView(): AccountsView | null {
  const view = pendingView;
  pendingView = null;
  return view;
}
