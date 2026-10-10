import { describe, expect, test } from 'bun:test';
import { diagnosticReport, redact, type DiagnosticInput } from '../src/services/diagnostics';

const input: DiagnosticInput = {
  generatedAt: new Date('2026-10-10T20:00:00Z'),
  hubVersion: '0.3.12+personal-desk.67',
  platform: 'windows',
  proxy: { running: true, ready: true, version: 'v8.1.0', managed: true },
  host: '127.0.0.1',
  allowLan: false,
  keyCount: 1,
  checks: [
    { level: 'fail', text: 'Sign in again: tim@example.com' },
    { level: 'ok', text: 'Proxy is running' },
  ],
  accounts: [
    { provider: 'claude', state: 'ready', disabled: false },
    { provider: 'claude', state: 'ready', disabled: false },
    { provider: 'codex', state: 'limited', disabled: false },
    { provider: 'meta', state: 'ready', disabled: true },
  ],
  apps: [
    { name: 'Claude Code', installed: true, state: 'configured', connectionMatches: true },
    { name: 'Codex', installed: false, state: 'not-configured' },
  ],
  compression: { enabled: false, running: false },
};

describe('diagnostic report', () => {
  test('summarises proxy, checks, accounts by provider and apps', () => {
    const report = diagnosticReport(input);
    expect(report).toContain('Hub: 0.3.12+personal-desk.67');
    expect(report).toContain('State: ready (started by the hub)');
    expect(report).toContain('Compression: off, service stopped');
    expect(report).toContain('[fail] Sign in again: <email>');
    expect(report).toContain('Accounts (4)');
    expect(report).toContain('  claude: 2 ready');
    expect(report).toContain('  codex: 1 limited');
    expect(report).toContain('  meta: 1 off');
    expect(report).toContain('  Claude Code: configured, connection matches');
    expect(report).toContain('  Codex: not installed');
  });

  test('never carries an email or a long secret', () => {
    expect(redact('key sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD for a.b+c@mail.co.uk')).toBe('key <redacted> for <email>');
    expect(redact('version 0.3.12+personal-desk.67 on port 8317')).toBe('version 0.3.12+personal-desk.67 on port 8317');
  });
});
