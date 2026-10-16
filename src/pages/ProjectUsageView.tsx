import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FolderGit2, LoaderCircle } from 'lucide-react';
import { useI18n } from '../i18n';
import { readableError } from '../services/readableError';
import './ProjectUsageView.css';

export type ProjectUsage = {
  path: string;
  sessions: number;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  lastActive: number;
};
type Report = { projects: ProjectUsage[]; days: number; filesRead: number; found: boolean };

const compact = (value: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
/** The folder name, which is how people recognise a project; the full path is on hover. */
export const projectName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path || '—';
/** Fresh tokens (input, output, cache writes) decide the share; cache reads are cheap and would drown everything else. */
export const projectWeight = (project: ProjectUsage) => project.inputTokens + project.outputTokens + project.cacheWriteTokens;

/** Activity → By project: Claude Code token use per project folder, from Claude Code's own session logs. */
export function ProjectUsageView() {
  const { t } = useI18n();
  const [days, setDays] = useState<7 | 30>(7);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (window: 7 | 30) => {
    setLoading(true);
    setError('');
    try { setReport(await invoke<Report>('claude_project_usage', { days: window })); }
    catch (reason) { setError(readableError(reason)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(days); }, [days, load]);

  const total = report?.projects.reduce((sum, project) => sum + projectWeight(project), 0) ?? 0;
  return (
    <section className="project-usage" aria-labelledby="project-usage-title">
      <header className="project-usage-head">
        <div>
          <h3 id="project-usage-title">{t('projects.title')}</h3>
          <p>{t('projects.source')}</p>
        </div>
        <div className="routing-segmented project-usage-range" role="group" aria-label={t('projects.range')}>
          {([7, 30] as const).map(option => (
            <button key={option} type="button" className={days === option ? 'active' : ''} aria-pressed={days === option}
              disabled={loading} onClick={() => setDays(option)}>{t('projects.days', { count: option })}</button>
          ))}
        </div>
      </header>
      {loading && !report && <p className="project-usage-note"><LoaderCircle size={14} className="spin" aria-hidden="true" /> {t('projects.firstRead')}</p>}
      {error && <p className="project-usage-error">{error}</p>}
      {report && !report.found && <p className="project-usage-note">{t('projects.noLogs')}</p>}
      {report && report.found && report.projects.length === 0 && <p className="project-usage-note">{t('projects.empty')}</p>}
      {report && report.projects.length > 0 && (
        <table className="project-usage-table">
          <thead>
            <tr>
              <th>{t('projects.project')}</th>
              <th>{t('projects.share')}</th>
              <th className="num">{t('projects.sessions')}</th>
              <th className="num">{t('projects.messages')}</th>
              <th className="num">{t('projects.output')}</th>
              <th className="num">{t('projects.input')}</th>
              <th className="num">{t('projects.cacheWrite')}</th>
              <th className="num">{t('projects.cacheRead')}</th>
              <th>{t('projects.lastActive')}</th>
            </tr>
          </thead>
          <tbody>
            {report.projects.map(project => {
              const share = total ? projectWeight(project) / total : 0;
              return (
                <tr key={project.path}>
                  <td title={project.path}><FolderGit2 size={14} aria-hidden="true" /> <strong>{projectName(project.path)}</strong></td>
                  <td><span className="project-usage-bar" aria-label={`${Math.round(share * 100)}%`}><span style={{ width: `${Math.max(share * 100, share > 0 ? 1 : 0)}%` }} /></span><small>{Math.round(share * 100)}%</small></td>
                  <td className="num">{project.sessions}</td>
                  <td className="num">{compact(project.messages)}</td>
                  <td className="num">{compact(project.outputTokens)}</td>
                  <td className="num">{compact(project.inputTokens)}</td>
                  <td className="num">{compact(project.cacheWriteTokens)}</td>
                  <td className="num">{compact(project.cacheReadTokens)}</td>
                  <td>{new Date(project.lastActive * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
