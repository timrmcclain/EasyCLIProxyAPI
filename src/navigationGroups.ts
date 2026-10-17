import { readDashboardPreference, saveDashboardPreference } from './services/dashboardPreferences';

/**
 * The prototype navigation from the UI review: pages grouped by the job they serve. Every page keeps its id,
 * so search, deep links and the remembered page work unchanged; a group only decides where a page is listed.
 */
export type NavGroup = { id: string; labelKey: string; pages: readonly string[] };

export const mainNavGroups: readonly NavGroup[] = [
  { id: 'overview', labelKey: 'app.nav.home', pages: ['home'] },
  { id: 'accounts', labelKey: 'app.nav.oauth', pages: ['oauth', 'api'] },
  { id: 'activity', labelKey: 'app.nav.usageRecords', pages: ['usage-records'] },
  { id: 'ai-apps', labelKey: 'navGroup.aiApps', pages: ['agents', 'claude-extensions'] },
  { id: 'tools', labelKey: 'navGroup.tools', pages: ['connectors'] },
  { id: 'safety', labelKey: 'navGroup.safety', pages: ['secret-guard', 'jev'] },
];

export const utilityNavGroups: readonly NavGroup[] = [
  { id: 'settings', labelKey: 'app.nav.config', pages: ['config', 'proxy', 'versions', 'plugins', 'compression'] },
  { id: 'diagnostics', labelKey: 'navGroup.diagnostics', pages: ['health'] },
];

export const allNavGroups: readonly NavGroup[] = [...mainNavGroups, ...utilityNavGroups];

/** The group a page is listed under; every page belongs to exactly one. */
export function groupForPage(pageId: string): NavGroup | undefined {
  return allNavGroups.find((group) => group.pages.includes(pageId));
}

/** Opening a group returns to the page you last used in it, so switching groups doesn't lose your place. */
export function pageForGroup(group: NavGroup, lastUsed: Readonly<Record<string, string>>): string {
  const remembered = lastUsed[group.id];
  return remembered && group.pages.includes(remembered) ? remembered : group.pages[0];
}

export function readNewNavigationPreference(): boolean {
  return readDashboardPreference('newNavigation', ['true', 'false'], 'false') === 'true';
}

export function saveNewNavigationPreference(enabled: boolean): void {
  saveDashboardPreference('newNavigation', String(enabled));
  window.dispatchEvent(new CustomEvent(NEW_NAVIGATION_EVENT, { detail: enabled }));
}

export const NEW_NAVIGATION_EVENT = 'app:new-navigation';
