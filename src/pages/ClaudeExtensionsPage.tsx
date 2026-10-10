import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink, Link2, Search } from 'lucide-react';
import { useI18n } from '../i18n';
import { useConfirmation } from '../components/ConfirmationDialog';
import {
  claudeExtensionsService as service, formatBytes, isSessionPlugin, isWebLink, pluginMarketplace, pluginName,
  searchAvailable, searchSkills, type AvailablePlugin, type ExtensionsOverview, type InstallOutcome, type InstalledPlugin, type SkillPreview,
} from '../services/claudeExtensions';
import './HealthCheckPage.css';
import './JevPage.css';
import './ClaudeExtensionsPage.css';

const AVAILABLE_LIMIT = 8;
type Review = { id: string; scope: string; details: string };

/** Claude Code's skills and plugins: list, review, install switched off, turn on, remove. */
export function ClaudeExtensionsPage() {
  const { t } = useI18n();
  const { askConfirmation, confirmationDialog } = useConfirmation();
  const [overview, setOverview] = useState<ExtensionsOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, string>>({});
  const [review, setReview] = useState<Review | null>(null);
  const [pluginQuery, setPluginQuery] = useState('');
  const [skillQuery, setSkillQuery] = useState('');
  const [skillSource, setSkillSource] = useState('');
  const [preview, setPreview] = useState<SkillPreview | null>(null);
  const [installedFromPreview, setInstalledFromPreview] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      setOverview(await service.overview());
      setLoadError(null);
    } catch (cause) {
      setLoadError(String(cause));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  /** Runs one change, shows its result and reloads the lists. */
  const run = async (key: string, work: () => Promise<unknown>, done = true) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await work();
      if (done) setNotice(t('ext.done'));
      await load();
      return true;
    } catch (cause) {
      setError(String(cause));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const toggleDetails = async (id: string) => {
    if (details[id] !== undefined) {
      setDetails(({ [id]: _, ...rest }) => rest);
      return;
    }
    try {
      const text = await service.pluginDetails(id);
      setDetails(current => ({ ...current, [id]: text }));
    } catch (cause) {
      setError(String(cause));
    }
  };

  const removePlugin = async (plugin: InstalledPlugin) => {
    const name = pluginName(plugin.id);
    if (!await askConfirmation({ title: t('ext.plugins.remove'), message: t('ext.plugins.removeConfirm', { name }), confirmText: t('ext.plugins.remove'), variant: 'danger' })) return;
    await run(`remove:${plugin.id}`, () => service.uninstallPlugin(plugin.id, plugin.scope));
    if (review?.id === plugin.id) setReview(null);
  };

  const install = async (plugin: AvailablePlugin) => {
    const values = { name: plugin.name, marketplace: plugin.marketplace };
    if (!await askConfirmation({ title: t('ext.add.install'), message: t('ext.add.installConfirm', values), confirmText: t('ext.add.install') })) return;
    const result: { outcome?: InstallOutcome } = {};
    await run(`install:${plugin.id}`, async () => { result.outcome = await service.installPlugin(plugin.id); }, false);
    // Some marketplaces install by running a command; show it and let the user decide.
    if (result.outcome?.status === 'needsCommandApproval') {
      const { command, sha256 } = result.outcome;
      const accepted = await askConfirmation({
        title: t('ext.add.commandTitle'), message: t('ext.add.commandMessage', values), items: [command],
        warning: t('ext.add.commandWarning'), confirmText: t('ext.add.commandAccept'), variant: 'danger',
      });
      if (!accepted) return;
      await run(`install:${plugin.id}`, async () => { result.outcome = await service.installPlugin(plugin.id, sha256); }, false);
    }
    if (result.outcome?.status === 'installed') setReview({ id: plugin.id, scope: 'user', details: result.outcome.details });
  };

  const previewSkill = async () => {
    if (preview) await service.discardPreview(preview.previewId).catch(() => undefined);
    setPreview(null);
    setInstalledFromPreview([]);
    setBusy('preview');
    setError(null);
    setNotice(null);
    try {
      setPreview(await service.previewSkill(skillSource));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  };

  const closePreview = () => {
    if (preview) void service.discardPreview(preview.previewId).catch(() => undefined);
    setPreview(null);
    setInstalledFromPreview([]);
  };

  const removeSkill = async (folder: string, name: string) => {
    if (!await askConfirmation({ title: t('ext.skills.remove'), message: t('ext.skills.removeConfirm', { name }), confirmText: t('ext.skills.remove'), variant: 'danger' })) return;
    await run(`skill:${folder}`, () => service.removeSkill(folder));
  };

  const fileCount = (files: number, bytes: number) => (files === 1
    ? t('ext.skills.fileOne', { size: formatBytes(bytes) })
    : t('ext.skills.files', { count: files, size: formatBytes(bytes) }));

  if (loadError) return <div className="health-page ext-page"><p role="alert" className="ad-notice ad-error">{t('ext.loadError', { error: loadError })}</p></div>;

  const plugins = overview?.plugins ?? [];
  const managed = plugins.filter(plugin => !isSessionPlugin(plugin));
  const results = overview ? searchAvailable(overview.available, plugins, pluginQuery, AVAILABLE_LIMIT) : { shown: [], total: 0 };
  const skills = overview ? searchSkills(overview.skills, skillQuery) : [];

  return <div className="health-page jev-page ext-page" aria-busy={overview === null || undefined}>
    <header className="health-heading">
      <div>
        <h1>{t('ext.title')}</h1>
        <p>{t('ext.subtitle')}</p>
      </div>
    </header>

    {overview && !overview.claudeFound && <p className="ad-notice">{t('ext.noClaude')}</p>}
    {overview?.pluginError && <p role="alert" className="ad-notice ad-error">{t('ext.pluginError', { error: overview.pluginError })}</p>}
    {error && <p role="alert" className="ad-notice ad-error">{error}</p>}
    {notice && <p role="status" className="ad-notice ext-notice">{notice}</p>}

    {review && <section className="jev-card ext-review" aria-labelledby="ext-review-title">
      <h2 id="ext-review-title" className="jev-section-title">{t('ext.review.title', { name: pluginName(review.id) })}</h2>
      <p className="jev-subtitle">{t('ext.review.intro')}</p>
      <pre className="ext-details">{review.details}</pre>
      <div className="jev-actions">
        <button type="button" className="primary-button compact-button" disabled={busy !== null}
          onClick={() => void run(`on:${review.id}`, () => service.setPluginEnabled(review.id, review.scope, true)).then(ok => ok && setReview(null))}>
          {t('ext.review.turnOn')}
        </button>
        <button type="button" className="secondary-button compact-button" disabled={busy !== null}
          onClick={() => void run(`remove:${review.id}`, () => service.uninstallPlugin(review.id, review.scope)).then(ok => ok && setReview(null))}>
          {t('ext.review.remove')}
        </button>
      </div>
    </section>}

    {overview?.claudeFound && <section className="jev-card" aria-labelledby="ext-plugins-title">
      <header className="jev-card-heading">
        <h2 id="ext-plugins-title" className="jev-section-title">{t('ext.plugins.title')}</h2>
        <p className="jev-counts">{t('ext.plugins.count', { on: managed.filter(plugin => plugin.enabled).length, total: managed.length })}</p>
      </header>
      {!plugins.length ? <p className="glance-muted">{t('ext.plugins.none')}</p>
        : <ul className="ext-list">
          {plugins.map(plugin => {
            const session = isSessionPlugin(plugin);
            const name = pluginName(plugin.id);
            return <li key={`${plugin.id}:${plugin.scope}`} className="ext-row">
              <div className="ext-main">
                <strong>{name}</strong>
                <span className="ext-meta">
                  {pluginMarketplace(plugin.id)}{plugin.version ? ` · ${plugin.version}` : ''} · {session ? t('ext.plugins.session') : t(`ext.plugins.scope.${plugin.scope}` as 'ext.plugins.scope.user')}
                </span>
                {plugin.projectPath && <span className="ext-meta ext-path" title={plugin.projectPath}>{plugin.projectPath}</span>}
                {details[plugin.id] !== undefined && <pre className="ext-details">{details[plugin.id]}</pre>}
              </div>
              {!session && <div className="ext-actions">
                <button type="button" className="secondary-button compact-button" onClick={() => void toggleDetails(plugin.id)} aria-expanded={details[plugin.id] !== undefined}>
                  {details[plugin.id] !== undefined ? t('ext.plugins.hideContents') : t('ext.plugins.contents')}
                </button>
                <label className="ext-switch" title={t('ext.plugins.toggle', { name })}>
                  <input type="checkbox" role="switch" checked={plugin.enabled} disabled={busy !== null} aria-label={t('ext.plugins.toggle', { name })}
                    onChange={event => void run(`toggle:${plugin.id}`, () => service.setPluginEnabled(plugin.id, plugin.scope, event.currentTarget.checked))} />
                  <span>{plugin.enabled ? t('ext.plugins.on') : t('ext.plugins.off')}</span>
                </label>
                <button type="button" className="secondary-button compact-button ext-danger" disabled={busy !== null} onClick={() => void removePlugin(plugin)}>
                  {t('ext.plugins.remove')}
                </button>
              </div>}
            </li>;
          })}
        </ul>}

      <h3 className="ext-subheading">{t('ext.add.title')}</h3>
      <label className="ext-search">
        <Search size={14} aria-hidden="true" />
        <input type="search" value={pluginQuery} onChange={event => setPluginQuery(event.currentTarget.value)}
          placeholder={t('ext.add.search', { count: overview.available.length })} aria-label={t('ext.add.search', { count: overview.available.length })} />
      </label>
      {!results.total ? <p className="glance-muted">{t('ext.add.noMatches')}</p>
        : <>
          <ul className="ext-list">
            {results.shown.map(plugin => <li key={plugin.id} className="ext-row">
              <div className="ext-main">
                <strong>{plugin.name}</strong>
                <span className="ext-meta">{plugin.marketplace}{plugin.installCount !== null ? ` · ${t('ext.add.installs', { count: plugin.installCount.toLocaleString() })}` : ''}</span>
                {plugin.description && <span className="ext-description">{plugin.description}</span>}
              </div>
              <div className="ext-actions">
                {isWebLink(plugin.sourceUrl) && <button type="button" className="secondary-button compact-button" title={plugin.sourceUrl}
                  onClick={() => void service.openUrl(plugin.sourceUrl as string).catch(cause => setError(String(cause)))}>
                  {t('ext.add.source')}<ExternalLink size={12} aria-hidden="true" />
                </button>}
                <button type="button" className="secondary-button compact-button" disabled={busy !== null} onClick={() => void install(plugin)}>
                  {busy === `install:${plugin.id}` ? t('ext.add.installing') : t('ext.add.install')}
                </button>
              </div>
            </li>)}
          </ul>
          {results.total > results.shown.length && <p className="jev-subtitle">{t('ext.add.showing', { shown: results.shown.length, total: results.total })}</p>}
        </>}
    </section>}

    {overview && <section className="jev-card" aria-labelledby="ext-skills-title">
      <header className="jev-card-heading">
        <h2 id="ext-skills-title" className="jev-section-title">{t('ext.skills.title')}</h2>
        <p className="jev-counts">{t('ext.skills.count', { count: overview.skills.filter(skill => !skill.notASkill).length, dir: overview.skillsDir })}</p>
      </header>

      <h3 className="ext-subheading">{t('ext.skills.add.title')}</h3>
      <form className="ext-add-skill" onSubmit={event => { event.preventDefault(); void previewSkill(); }}>
        <input type="text" value={skillSource} onChange={event => setSkillSource(event.currentTarget.value)}
          placeholder={t('ext.skills.add.placeholder')} aria-label={t('ext.skills.add.title')} />
        <button type="submit" className="secondary-button compact-button" disabled={busy !== null || !skillSource.trim()}>
          {busy === 'preview' ? t('ext.skills.add.previewing') : t('ext.skills.add.preview')}
        </button>
      </form>
      {preview && <div className="ext-preview" aria-label={preview.repo}>
        <p>{t('ext.skills.add.found', { repo: preview.repo, count: preview.skills.length })}</p>
        <p className="ext-warning"><AlertTriangle size={14} aria-hidden="true" />{t('ext.skills.add.trust')}</p>
        <ul className="ext-list">
          {preview.skills.map(candidate => {
            const done = installedFromPreview.includes(candidate.path);
            return <li key={candidate.path} className="ext-row">
              <div className="ext-main">
                <strong>{candidate.skill.name}</strong>
                <span className="ext-meta">{candidate.skill.folder} · {fileCount(candidate.skill.files, candidate.skill.bytes)}</span>
                {candidate.skill.description && <span className="ext-description">{candidate.skill.description}</span>}
                {candidate.skill.scripts.length > 0 && <span className="ext-scripts">{t('ext.skills.scripts', { list: candidate.skill.scripts.join(', ') })}</span>}
              </div>
              <div className="ext-actions">
                {candidate.exists && !done ? <span className="ext-badge">{t('ext.skills.add.exists')}</span>
                  : <button type="button" className="secondary-button compact-button" disabled={busy !== null || done}
                    onClick={() => void run(`add:${candidate.path}`, () => service.installSkill(preview.previewId, candidate.path, candidate.skill.folder))
                      .then(ok => ok && setInstalledFromPreview(current => [...current, candidate.path]))}>
                    {done ? t('ext.skills.add.installed') : t('ext.skills.add.install')}
                  </button>}
              </div>
            </li>;
          })}
        </ul>
        <div className="jev-actions"><button type="button" className="secondary-button compact-button" onClick={closePreview}>{t('ext.skills.add.discard')}</button></div>
      </div>}

      <label className="ext-search">
        <Search size={14} aria-hidden="true" />
        <input type="search" value={skillQuery} onChange={event => setSkillQuery(event.currentTarget.value)} placeholder={t('ext.skills.search')} aria-label={t('ext.skills.search')} />
      </label>
      {!skills.length ? <p className="glance-muted">{t('ext.skills.noMatches')}</p>
        : <ul className="ext-list ext-skills">
          {skills.map(skill => <li key={skill.folder} className="ext-row">
            <div className="ext-main">
              <strong>{skill.name}</strong>
              <span className="ext-meta">
                {skill.folder !== skill.name ? `${skill.folder} · ` : ''}{fileCount(skill.files, skill.bytes)}
              </span>
              {skill.description && <span className="ext-description">{skill.description}</span>}
              {skill.scripts.length > 0 && <span className="ext-scripts">{t('ext.skills.scripts', { list: skill.scripts.slice(0, 4).join(', ') + (skill.scripts.length > 4 ? ` +${skill.scripts.length - 4}` : '') })}</span>}
            </div>
            <div className="ext-actions">
              {skill.linked ? <span className="ext-badge" title={t('ext.skills.linkedHint')}><Link2 size={12} aria-hidden="true" />{t('ext.skills.linked')}</span>
                : skill.notASkill ? <span className="ext-badge" title={t('ext.skills.notASkillHint')}>{t('ext.skills.notASkill')}</span>
                  : <button type="button" className="secondary-button compact-button ext-danger" disabled={busy !== null} onClick={() => void removeSkill(skill.folder, skill.name)}>
                    {t('ext.skills.remove')}
                  </button>}
            </div>
          </li>)}
        </ul>}
    </section>}
    {confirmationDialog}
  </div>;
}
