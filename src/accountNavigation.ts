// Lets another part of the app open Overview's account list already searched for one account.
// Kept until the list mounts and reads it, since navigation and mounting happen in that order.
let pending: string | null = null;
export const ACCOUNT_SEARCH_EVENT = 'app:account-search';

export function requestAccountSearch(search: string) {
  pending = search;
  window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'home' }));
  window.dispatchEvent(new CustomEvent(ACCOUNT_SEARCH_EVENT));
}

export function takePendingAccountSearch(): string | null {
  const search = pending;
  pending = null;
  return search;
}
