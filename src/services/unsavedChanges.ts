import { useEffect } from 'react';
import { getCurrentLocale, translate } from '../i18n';

/**
 * Shared registry of pages that hold edits which would be lost if the page unmounted.
 * Pages report their dirty state; the shell asks once before switching pages.
 */
const dirtyOwners = new Set<string>();

export function setUnsavedChanges(owner: string, dirty: boolean) {
  if (dirty) dirtyOwners.add(owner);
  else dirtyOwners.delete(owner);
}

export function hasUnsavedChanges(): boolean {
  return dirtyOwners.size > 0;
}

/**
 * Call before navigating away from the current page. Returns true when it is safe to leave:
 * nothing is dirty, or the user confirmed discarding their edits (the registry is then cleared
 * so a single navigation asks only once).
 */
export function confirmLeave(): boolean {
  if (dirtyOwners.size === 0) return true;
  const confirmed = typeof window === 'undefined'
    || window.confirm(translate(getCurrentLocale(), 'notice.unsavedLeave'));
  if (confirmed) dirtyOwners.clear();
  return confirmed;
}

/** Reports `dirty` for `owner` while mounted and clears it on unmount. */
export function useUnsavedChangesGuard(owner: string, dirty: boolean) {
  useEffect(() => {
    setUnsavedChanges(owner, dirty);
  }, [owner, dirty]);
  useEffect(() => () => setUnsavedChanges(owner, false), [owner]);
}
