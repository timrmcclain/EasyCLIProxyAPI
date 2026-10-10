import { invoke } from '@tauri-apps/api/core';

export type SkillInfo = {
  folder: string; name: string; description: string; files: number; bytes: number;
  scripts: string[]; linked: boolean; notASkill: boolean;
};
export type InstalledPlugin = { id: string; version: string; scope: string; enabled: boolean; projectPath: string | null };
export type AvailablePlugin = {
  id: string; name: string; description: string; marketplace: string;
  sourceUrl: string | null; installCount: number | null;
};
export type ExtensionsOverview = {
  claudeFound: boolean; skillsDir: string; skills: SkillInfo[];
  plugins: InstalledPlugin[]; available: AvailablePlugin[]; pluginError: string | null;
};
export type InstallOutcome =
  | { status: 'installed'; details: string }
  | { status: 'needsCommandApproval'; command: string; sha256: string };
export type SkillCandidate = { path: string; skill: SkillInfo; exists: boolean };
export type SkillPreview = { previewId: string; repo: string; skills: SkillCandidate[] };

export const claudeExtensionsService = {
  overview: () => invoke<ExtensionsOverview>('claude_extensions_overview'),
  pluginDetails: (id: string) => invoke<string>('claude_plugin_details', { id }),
  installPlugin: (id: string, acceptCommand?: string) => invoke<InstallOutcome>('claude_plugin_install', { id, acceptCommand: acceptCommand ?? null }),
  setPluginEnabled: (id: string, scope: string, enabled: boolean) => invoke<void>('claude_plugin_set_enabled', { id, scope, enabled }),
  uninstallPlugin: (id: string, scope: string) => invoke<void>('claude_plugin_uninstall', { id, scope }),
  previewSkill: (source: string) => invoke<SkillPreview>('claude_skill_preview', { source }),
  installSkill: (previewId: string, path: string, folder: string) => invoke<void>('claude_skill_install', { previewId, path, folder }),
  discardPreview: (previewId: string) => invoke<void>('claude_skill_preview_discard', { previewId }),
  removeSkill: (folder: string) => invoke<void>('claude_skill_remove', { folder }),
  openUrl: (url: string) => invoke<void>('open_external_url', { url }),
};

/** Plugins Claude Code loaded for one session only (`--plugin-dir`); the hub can't change those. */
export const isSessionPlugin = (plugin: InstalledPlugin) => !['user', 'project', 'local'].includes(plugin.scope);

const matches = (query: string, ...fields: string[]) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = fields.join(' ').toLowerCase();
  return words.every(word => text.includes(word));
};

/** Marketplace plugins not installed yet, matching the search; most installed first (the backend's order). */
export function searchAvailable(available: AvailablePlugin[], installed: InstalledPlugin[], query: string, limit: number) {
  const taken = new Set(installed.map(plugin => plugin.id));
  const found = available.filter(plugin => !taken.has(plugin.id) && matches(query, plugin.name, plugin.description, plugin.marketplace));
  return { shown: found.slice(0, limit), total: found.length };
}

export function searchSkills(skills: SkillInfo[], query: string) {
  return skills.filter(skill => matches(query, skill.name, skill.folder, skill.description));
}

/** Plugin ids are `name@marketplace`. */
export const pluginName = (id: string) => id.split('@')[0] ?? id;
export const pluginMarketplace = (id: string) => id.split('@')[1] ?? '';

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Only https links are opened in the browser. */
export const isWebLink = (url: string | null): url is string => Boolean(url && /^https:\/\//i.test(url));
