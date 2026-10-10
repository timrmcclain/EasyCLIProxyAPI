import { describe, expect, it } from 'bun:test';
import { interventionCounts, jevStatusRows, type JevOverview } from '../src/services/jev';

const now = Date.parse('2026-10-10T08:00:00');
const base: JevOverview = {
  installed: true,
  hooks: [{ event: 'Stop', script: 'stop_verifier.py' }, { event: 'PreToolUse', script: 'rule_enforcer.py' }, { event: 'PostToolUse', script: 'rule_enforcer.py' }],
  selftest: { ts: '2026-10-10T06:01:12', passed: 73, total: 73 },
  replay: { ts: '2026-10-10T06:00:41', problems: 0 },
  report: { generated: '2026-10-10T07:22:00' },
  reportPath: null,
  interventions: [],
};
const levels = (overview: JevOverview) => Object.fromEntries(jevStatusRows(overview, now).map(row => [row.id, row.level]));

describe('Jev status rows', () => {
  it('is all ok when hooks are registered and the nightly results and report are fresh', () => {
    expect(levels(base)).toEqual({ hooks: 'ok', selftest: 'ok', replay: 'ok', report: 'ok' });
    expect(jevStatusRows(base, now).find(row => row.id === 'hooks')?.values.count).toBe(2);
  });

  it('fails when no hooks are registered or the self-test is failing, and lists those first', () => {
    const rows = jevStatusRows({ ...base, hooks: [], selftest: { ts: '2026-10-10T06:00:00', passed: 70, total: 73 } }, now);
    expect(rows.slice(0, 2).map(row => [row.id, row.level])).toEqual([['hooks', 'fail'], ['selftest', 'fail']]);
  });

  it('warns when the replay found problems or the nightly results stopped arriving', () => {
    expect(levels({ ...base, replay: { ts: '2026-10-10T06:00:00', problems: 1 } }).replay).toBe('warn');
    expect(levels({ ...base, selftest: { ts: '2026-10-07T06:00:00', passed: 73, total: 73 } }).selftest).toBe('warn');
    expect(levels({ ...base, selftest: null, replay: null }).selftest).toBe('warn');
  });

  it('warns when the payoff report is missing or older than two days', () => {
    expect(levels({ ...base, report: null }).report).toBe('warn');
    expect(levels({ ...base, report: { generated: '2026-10-07T14:42:33' } }).report).toBe('warn');
  });
});

describe('intervention counts', () => {
  it('counts each kind', () => {
    const item = (kind: 'sentBack' | 'guarded') => ({ ts: '', kind, detail: '', project: null });
    expect(interventionCounts([item('sentBack'), item('guarded'), item('sentBack')])).toEqual({ sentBack: 2, guarded: 1 });
  });
});
