import { describe, expect, test } from 'bun:test';
import { projectName, projectWeight } from '../src/pages/ProjectUsageView';

describe('project usage helpers', () => {
  test('names a project by its last folder, on Windows and POSIX paths', () => {
    expect(projectName('C:\\Users\\demo\\git\\EasyCLIProxyAPI')).toBe('EasyCLIProxyAPI');
    expect(projectName('/home/demo/code/app/')).toBe('app');
    expect(projectName('')).toBe('—');
  });

  test('weights by fresh tokens and leaves cheap cache reads out', () => {
    const base = { path: 'x', sessions: 1, messages: 1, lastActive: 0 };
    expect(projectWeight({ ...base, inputTokens: 10, outputTokens: 20, cacheWriteTokens: 30, cacheReadTokens: 1_000_000 })).toBe(60);
  });
});
