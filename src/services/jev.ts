import { invoke } from '@tauri-apps/api/core';

export type JevHook = { event: string; script: string };
export type JevInterventionKind = 'sentBack' | 'blocked' | 'asked' | 'guarded' | 'loopStopped';
export type JevIntervention = { ts: string; kind: JevInterventionKind; detail: string; project: string | null };
export type JevSelftest = { ts: string; passed: number; total: number; failures?: unknown[] };
export type JevReplay = { ts: string; problems: number; commands?: number };
export type JevVerdict = { label: string; tone: 'good' | 'bad' | 'neutral' | string; short: string; note?: string };
export type JevAnswer = { tone: string; question: string; answer: string; evidence?: string };
export type JevReport = {
  generated?: string; days?: number; verdicts?: JevVerdict[]; answers?: JevAnswer[];
  cost?: string; spend_usd?: number; ms_per_check?: number; alerts?: string[];
};
export type JevOverview = {
  installed: boolean; hooks: JevHook[]; selftest: JevSelftest | null; replay: JevReplay | null;
  report: JevReport | null; reportPath: string | null; interventions: JevIntervention[];
};

export const jevService = {
  overview: () => invoke<JevOverview>('jev_overview'),
  refreshReport: () => invoke<void>('refresh_jev_report'),
  openReport: () => invoke<void>('open_jev_report'),
};

export type JevStatusLevel = 'ok' | 'warn' | 'fail';
export type JevStatusRow = { id: 'hooks' | 'selftest' | 'replay' | 'report'; level: JevStatusLevel; values: Record<string, string | number> };

const DAY_MS = 86_400_000;
/** Jev's self-test and replay run nightly; older than this means the nightly job stopped. */
const NIGHTLY_STALE_MS = 2 * DAY_MS;
const REPORT_STALE_MS = 2 * DAY_MS;

/** Local timestamps from Jev ("2026-10-10T06:01:12") as epoch ms; NaN when unreadable. */
export const jevTime = (ts: string | undefined) => (ts ? Date.parse(ts) : Number.NaN);

/** The status rows at the top of the page, worst first. */
export function jevStatusRows(overview: JevOverview, now: number): JevStatusRow[] {
  const rows: JevStatusRow[] = [];
  const scripts = new Set(overview.hooks.map(hook => hook.script));
  rows.push({ id: 'hooks', level: scripts.size ? 'ok' : 'fail', values: { count: scripts.size } });

  const selftest = overview.selftest;
  const selftestAt = jevTime(selftest?.ts);
  rows.push({
    id: 'selftest',
    level: !selftest || Number.isNaN(selftestAt) ? 'warn'
      : selftest.passed !== selftest.total ? 'fail'
      : now - selftestAt > NIGHTLY_STALE_MS ? 'warn' : 'ok',
    values: { passed: selftest?.passed ?? 0, total: selftest?.total ?? 0, at: selftestAt },
  });

  const replay = overview.replay;
  const replayAt = jevTime(replay?.ts);
  rows.push({
    id: 'replay',
    level: !replay || Number.isNaN(replayAt) ? 'warn' : replay.problems > 0 ? 'warn' : now - replayAt > NIGHTLY_STALE_MS ? 'warn' : 'ok',
    values: { problems: replay?.problems ?? 0, at: replayAt },
  });

  const generatedAt = jevTime(overview.report?.generated);
  rows.push({
    id: 'report',
    level: !overview.report || Number.isNaN(generatedAt) ? 'warn' : now - generatedAt > REPORT_STALE_MS ? 'warn' : 'ok',
    values: { at: generatedAt },
  });

  const rank: Record<JevStatusLevel, number> = { fail: 0, warn: 1, ok: 2 };
  return rows.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** Interventions grouped by kind, for the counts above the list. */
export function interventionCounts(items: JevIntervention[]): Partial<Record<JevInterventionKind, number>> {
  const counts: Partial<Record<JevInterventionKind, number>> = {};
  for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  return counts;
}
