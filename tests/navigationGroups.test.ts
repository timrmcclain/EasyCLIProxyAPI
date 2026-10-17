import { describe, expect, it } from 'bun:test';
import { allNavGroups, groupForPage, mainNavGroups, pageForGroup } from '../src/navigationGroups';

// Every page the app registers today (Quota Lookup is a view of Accounts and has no entry of its own).
const pages = ['home', 'api', 'oauth', 'agents', 'proxy', 'usage-records', 'secret-guard', 'plugins', 'connectors',
  'compression', 'health', 'jev', 'claude-extensions', 'config', 'versions'];

describe('prototype navigation groups', () => {
  it('lists every page exactly once, so nothing becomes unreachable', () => {
    const listed = allNavGroups.flatMap((group) => group.pages);
    expect([...listed].sort()).toEqual([...pages].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('has the six main entries from the review, in order', () => {
    expect(mainNavGroups.map((group) => group.id)).toEqual(['overview', 'accounts', 'activity', 'ai-apps', 'tools', 'safety']);
  });

  it('keeps Secret Guard and Jev together under Safety, and API Access under Accounts', () => {
    expect(groupForPage('jev')?.id).toBe('safety');
    expect(groupForPage('secret-guard')?.id).toBe('safety');
    expect(groupForPage('api')?.id).toBe('accounts');
  });

  it('reopens a group on the page last used in it, falling back to its first page', () => {
    const settings = groupForPage('versions')!;
    expect(pageForGroup(settings, { settings: 'versions' })).toBe('versions');
    expect(pageForGroup(settings, {})).toBe('config');
    expect(pageForGroup(settings, { settings: 'home' })).toBe('config');
  });
});
