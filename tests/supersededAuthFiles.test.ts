import { describe, expect, it } from 'bun:test';
import { supersededAuthFiles } from '../src/services/authFiles';

const names = (files: { name?: unknown }[]) => files.map((file) => file.name);

describe('older files for an account that was just signed in again', () => {
  const files = [
    { name: 'claude-new.json', type: 'claude', email: 'Someone@Example.com' },
    { name: 'claude-old.json', type: 'claude', email: 'someone@example.com ', priority: 5 },
    { name: 'claude-other.json', type: 'claude', email: 'other@example.com' },
    { name: 'codex-same-email.json', type: 'codex', email: 'someone@example.com' },
    { name: 'claude-runtime.json', type: 'claude', email: 'someone@example.com', runtime_only: true },
    { name: 'claude-no-email.json', type: 'claude' },
  ];

  it('offers only same-provider files with the same email, ignoring case and spaces', () => {
    expect(names(supersededAuthFiles(files, ['claude-new.json'], 'claude'))).toEqual(['claude-old.json']);
  });

  it('never offers the file that was just saved, another provider, or a runtime-only entry', () => {
    const offered = names(supersededAuthFiles(files, ['claude-new.json'], 'anthropic'));
    expect(offered).not.toContain('claude-new.json');
    expect(offered).not.toContain('codex-same-email.json');
    expect(offered).not.toContain('claude-runtime.json');
  });

  it('offers nothing when the saved file has no email to match on', () => {
    expect(supersededAuthFiles(files, ['claude-no-email.json'], 'claude')).toEqual([]);
  });

  it('offers nothing when signing in again overwrote the same file', () => {
    expect(supersededAuthFiles([files[1]], ['claude-old.json'], 'claude')).toEqual([]);
  });
});
