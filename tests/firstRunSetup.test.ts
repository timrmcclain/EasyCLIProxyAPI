import { describe, expect, it } from 'bun:test';
import { connectedAppNames, setupProgress, setupView } from '../src/services/firstRunSetup';

describe('first-run setup', () => {
  it('counts only apps that point at the hub now', () => {
    expect(connectedAppNames([
      { id: 'claude-code', name: 'Claude Code', installed: true, configValid: true, connectionState: 'configured', error: null },
      { id: 'codex', name: 'Codex', installed: true, configValid: true, connectionState: 'not-configured', error: null },
      { id: 'pi', name: 'Pi', installed: false, connectionState: 'configured' },
      { id: 'opencode', name: 'OpenCode', installed: true, configValid: false, connectionState: 'configured' },
      { id: 'hermes', installed: true, connectionState: 'configured', error: 'config unreadable' },
      { id: 'zcode', installed: true, connectionState: 'configured' },
    ])).toEqual(['Claude Code', 'zcode']);
  });

  it('reads each step from the hub, and the next step is the first one not done', () => {
    const fresh = setupProgress({ coreRunning: true, accounts: 0, apps: [], requestSeen: false });
    expect(fresh.doneCount).toBe(1);
    expect(fresh.current).toBe('account');
    expect(fresh.complete).toBe(false);
    // Steps can be done out of order: an app was connected before any account was added.
    const outOfOrder = setupProgress({ coreRunning: true, accounts: 0, apps: ['Codex'], requestSeen: false });
    expect(outOfOrder.steps.map(step => step.done)).toEqual([true, false, true, false]);
    expect(outOfOrder.current).toBe('account');
    const done = setupProgress({ coreRunning: true, accounts: 2, apps: ['Codex'], requestSeen: true });
    expect(done.complete).toBe(true);
    expect(done.current).toBeNull();
  });

  it('celebrates only for someone who watched it get set up', () => {
    expect(setupView({ stored: '', complete: false, everIncomplete: true, forced: false })).toBe('steps');
    expect(setupView({ stored: '', complete: true, everIncomplete: true, forced: false })).toBe('celebrate');
    // Already set up when it opened: no steps, no moment.
    expect(setupView({ stored: '', complete: true, everIncomplete: false, forced: false })).toBe('hidden');
    expect(setupView({ stored: 'dismissed', complete: false, everIncomplete: true, forced: false })).toBe('hidden');
    expect(setupView({ stored: 'done', complete: true, everIncomplete: false, forced: false })).toBe('hidden');
    // Asked for from the palette: the steps, or the finished card with what to do next.
    expect(setupView({ stored: '', complete: false, everIncomplete: false, forced: true })).toBe('steps');
    expect(setupView({ stored: '', complete: true, everIncomplete: false, forced: true })).toBe('celebrate');
  });
});
