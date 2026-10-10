import { describe, expect, test } from 'bun:test';
import { formatBytes, isSessionPlugin, isWebLink, pluginMarketplace, pluginName, searchAvailable, searchSkills, type AvailablePlugin, type InstalledPlugin, type SkillInfo } from '../src/services/claudeExtensions';

const plugin = (id: string, scope = 'user'): InstalledPlugin => ({ id, version: '1', scope, enabled: true, projectPath: null });
const available = (id: string, description = ''): AvailablePlugin => ({
  id, name: pluginName(id), description, marketplace: pluginMarketplace(id), sourceUrl: null, installCount: 1,
});
const skill = (folder: string, description = ''): SkillInfo => ({
  folder, name: folder, description, files: 1, bytes: 10, scripts: [], linked: false, notASkill: false,
});

describe('claude extensions', () => {
  test('searching the marketplace leaves out installed plugins and caps the list', () => {
    const list = [available('code-review@official', 'Review pull requests'), available('superpowers@official'), available('context7@official', 'Docs lookup')];
    const result = searchAvailable(list, [plugin('superpowers@official')], '', 1);
    expect(result.shown.map(item => item.id)).toEqual(['code-review@official']);
    expect(result.total).toBe(2);
    expect(searchAvailable(list, [], 'docs LOOKUP', 10).shown.map(item => item.id)).toEqual(['context7@official']);
    expect(searchAvailable(list, [], 'review official', 10).total).toBe(1);
  });

  test('skills match on name, folder or description', () => {
    const skills = [skill('pdf', 'Read PDF files'), skill('brainstorming', 'Explore intent')];
    expect(searchSkills(skills, 'intent').map(item => item.folder)).toEqual(['brainstorming']);
    expect(searchSkills(skills, '')).toHaveLength(2);
  });

  test('session-only plugins are recognised by scope', () => {
    expect(isSessionPlugin(plugin('jev-panel@inline', 'session'))).toBe(true);
    expect(isSessionPlugin(plugin('a@b', 'project'))).toBe(false);
  });

  test('formats sizes and only treats https links as openable', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(4096)).toBe('4 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(isWebLink('https://github.com/a/b')).toBe(true);
    expect(isWebLink('./plugins/x')).toBe(false);
    expect(isWebLink('file:///C:/x')).toBe(false);
  });
});
