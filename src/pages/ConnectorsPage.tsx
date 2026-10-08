import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Building2, Check, ExternalLink, Flame, GitBranch, Globe, Mail, Monitor, Plug, RefreshCw, Sparkles, Undo2, type LucideIcon } from 'lucide-react';
import { useConfirmation } from '../components/ConfirmationDialog';
import { useI18n } from '../i18n';
import { connectorDynamicText, connectorText, type ConnectorTextKey } from '../i18n/connectors';
import {
  aiTestableConnectors,
  connectorsApi,
  connectorTargets,
  draftChanged,
  draftFromItem,
  localDate,
  invalidSecretFromError,
  missingSecretFromError,
  plainSecretNames,
  secretsWanted,
  missingSecrets,
  type ConnectorDraft,
  type ConnectorId,
  type ConnectorOverview,
  type ConnectorOverviewItem,
  type ConnectorTarget,
  type ConnectorTestResult,
} from '../services/connectors';
import './ConnectorsPage.css';

type TestState = { running: boolean; result?: ConnectorTestResult; error?: string };

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const guideLinks = {
  googleClients: 'https://console.cloud.google.com/auth/clients',
  googleAudience: 'https://console.cloud.google.com/auth/audience',
  googleBranding: 'https://console.cloud.google.com/auth/branding',
  entra: 'https://entra.microsoft.com/',
  entraAppRegistrations: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade/quickStartType~/null/sourceType/Microsoft_AAD_IAM',
} as const;

/**
 * Per-connector icons. src/assets/icons has no GitHub, Google, Microsoft, Firecrawl or
 * Playwright logos, so these are generic glyphs; unknown ids fall back to the plug.
 */
const connectorIcons: Partial<Record<ConnectorId, LucideIcon>> = {
  google: Mail,
  microsoft365: Building2,
  github: GitBranch,
  playwright: Globe,
  windows: Monitor,
  firecrawl: Flame,
};

/** Notes longer than this collapse behind a disclosure so cards stay scannable. */
const LONG_NOTE = 100;

function openLink(url: string) {
  void invoke('open_external_url', { url }).catch(() => undefined);
}

export function ConnectorsPage() {
  const { locale } = useI18n();
  const ct = (key: ConnectorTextKey) => connectorText(key, locale);
  const [overview, setOverview] = useState<ConnectorOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  // Bumped on every successful reload so cards drop stale edits and test results.
  const [reloadCount, setReloadCount] = useState(0);
  const unsavedCards = useRef(new Set<string>());
  const { askConfirmation, confirmationDialog } = useConfirmation();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOverview(await connectorsApi.overview());
      setCheckedAt(new Date());
      setReloadCount(count => count + 1);
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const refresh = async () => {
    if (unsavedCards.current.size > 0) {
      const confirmed = await askConfirmation({
        title: ct('discardTitle'),
        message: ct('discardMessage'),
        confirmText: ct('discardConfirm'),
        variant: 'danger',
      });
      if (!confirmed) return;
    }
    setNotice(null);
    await load();
  };

  const setCardUnsaved = useCallback((id: string, unsaved: boolean) => {
    if (unsaved) unsavedCards.current.add(id);
    else unsavedCards.current.delete(id);
  }, []);

  const undo = async () => {
    setUndoing(true);
    setNotice(null);
    try {
      setOverview(await connectorsApi.undo());
      setNotice(ct('undone'));
    } catch (undoError) {
      setError(errorText(undoError));
    } finally {
      setUndoing(false);
    }
  };

  return (
    <div className="connectors-page">
      <header className="connectors-heading">
        <div>
          <h1>{ct('title')}</h1>
          <p>{ct('description')}</p>
          <details className="connector-hint-details">
            <summary>{ct('howChangesApply')}</summary>
            <p>{ct('descriptionDetail')}</p>
          </details>
        </div>
        <div className="connectors-heading-actions">
          {overview?.canUndo ? (
            <button type="button" className="secondary-button" disabled={undoing || loading} onClick={() => void undo()}>
              <Undo2 size={16} aria-hidden="true" />{ct('undo')}
              {overview.lastChange ? ` (${connectorDynamicText(`${overview.lastChange}_name`, locale)})` : ''}
            </button>
          ) : null}
          {checkedAt ? (
            <span className="connectors-checked" aria-live="polite">
              {ct('checkedAt')} {checkedAt.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
            </span>
          ) : null}
          <button type="button" className="secondary-button" disabled={loading} aria-busy={loading} onClick={() => void refresh()}>
            <RefreshCw size={16} aria-hidden="true" className={loading ? 'spin' : undefined} />{loading ? ct('refreshing') : ct('refresh')}
          </button>
        </div>
      </header>
      {overview ? (
        <p className="connectors-profile">
          {overview.desktopProfile ? <>{ct('profile')} <strong>{overview.desktopProfile}</strong></> : ct('noProfile')}
        </p>
      ) : null}
      {notice ? <p className="connectors-notice" role="status">{notice}</p> : null}
      {error ? <p className="connectors-error" role="alert">{ct('loadFailed')}: {error}</p> : null}
      {loading && !overview ? (
        <p className="connectors-loading" role="status" aria-live="polite">
          <RefreshCw size={14} aria-hidden="true" className="spin" />
          {ct('loadingConnectors')}
        </p>
      ) : null}
      <div className="connectors-grid">
        {overview?.connectors.map(item => (
          <ConnectorCard
            key={item.id}
            item={item}
            reloadCount={reloadCount}
            onUnsavedChange={setCardUnsaved}
            onSaved={(next) => { setOverview(next); setError(null); setNotice(ct('saved')); }}
          />
        ))}
      </div>
      {confirmationDialog}
    </div>
  );
}

type ConnectorCardProps = {
  item: ConnectorOverviewItem;
  reloadCount: number;
  onUnsavedChange: (id: string, unsaved: boolean) => void;
  onSaved: (overview: ConnectorOverview) => void;
};

function ConnectorCard({ item, reloadCount, onUnsavedChange, onSaved }: ConnectorCardProps) {
  const { locale } = useI18n();
  const ct = (key: ConnectorTextKey) => connectorText(key, locale);
  const dt = (key: string) => connectorDynamicText(key, locale);
  const [draft, setDraft] = useState<ConnectorDraft>(() => draftFromItem(item));
  const [editingSecrets, setEditingSecrets] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [tests, setTests] = useState<Partial<Record<ConnectorTarget, TestState>>>({});
  const [aiTest, setAiTest] = useState<TestState | null>(null);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const previousItem = useRef(item);
  const seenReload = useRef(reloadCount);
  const justSaved = useRef(false);

  // A reload (Refresh) resets the card. Another card's save also delivers a new
  // item; keep this card's unsaved edits then instead of silently dropping them.
  useEffect(() => {
    const reloaded = seenReload.current !== reloadCount;
    seenReload.current = reloadCount;
    const hadUnsaved = draftChanged(previousItem.current, draftRef.current);
    previousItem.current = item;
    if (reloaded) {
      setTests({});
      setAiTest(null);
      setSaveError(null);
    }
    if (reloaded || justSaved.current || !hadUnsaved) {
      setDraft(draftFromItem(item));
      setEditingSecrets(false);
    }
    justSaved.current = false;
  }, [item, reloadCount]);

  const changed = draftChanged(item, draft);

  useEffect(() => {
    onUnsavedChange(item.id, changed);
  }, [item.id, changed, onUnsavedChange]);

  useEffect(() => () => onUnsavedChange(item.id, false), [item.id, onUnsavedChange]);
  const missing = missingSecrets(item, draft);
  const unavailable = item.unavailableReason ? dt(`unavailable_${item.unavailableReason}`) : null;
  const note = dt(`${item.id}_note`);
  const Icon = connectorIcons[item.id] ?? Plug;
  const showSecrets = item.secretNames.length > 0 && (editingSecrets || (!item.secretsConfigured && secretsWanted(item, draft)));

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const next = await connectorsApi.apply(item.id, draft);
      justSaved.current = true;
      onSaved(next);
      setTests({});
      setAiTest(null);
    } catch (error) {
      const secret = missingSecretFromError(error);
      const invalid = invalidSecretFromError(error);
      setSaveError(
        secret ? `${ct('missingSecret')} ${dt(secret)}`
          : invalid ? `${ct('invalidSecret')} ${dt(invalid)}`
            : errorText(error),
      );
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (target: ConnectorTarget) => {
    setTests(current => ({ ...current, [target]: { running: true } }));
    try {
      const result = await connectorsApi.test(item.id, target);
      setTests(current => ({ ...current, [target]: { running: false, result } }));
    } catch (error) {
      setTests(current => ({ ...current, [target]: { running: false, error: errorText(error) } }));
    }
  };

  const runAiTest = async () => {
    setAiTest({ running: true });
    try {
      const result = await connectorsApi.aiTest(item.id as ConnectorId, localDate());
      setAiTest({ running: false, result });
    } catch (error) {
      setAiTest({ running: false, error: errorText(error) });
    }
  };
  const aiTestable = aiTestableConnectors.includes(item.id as ConnectorId) && (item.claudeCode.enabled || item.claudeDesktop.enabled);
  // Only on in Claude Desktop: the test hands Claude Code a one-off copy.
  const aiTestDesktopOnly = !item.claudeCode.enabled;

  const accessLabel = (level: string) => {
    if (level === 'readonly') return ct('accessReadonly');
    if (level === 'drafts') return ct('accessDrafts');
    return item.id === 'github' ? ct('accessFullGithub') : ct('accessFull');
  };

  return (
    <section className="connector-card" aria-labelledby={`connector-${item.id}-title`}>
      <header className="connector-card-header">
        <span className="connector-icon" aria-hidden="true"><Icon size={18} /></span>
        <div>
          <h2 id={`connector-${item.id}-title`}>{dt(`${item.id}_name`)}</h2>
          <p>{dt(`${item.id}_body`)}</p>
        </div>
      </header>
      {note && note.length > LONG_NOTE ? (
        <details className="connector-note connector-note-details">
          <summary>{ct('noteTitle')}</summary>
          <p>{note}</p>
        </details>
      ) : note ? <p className="connector-note">{note}</p> : null}
      {unavailable ? <p className="connector-unavailable">{unavailable}</p> : null}

      <div className="connector-targets">
        {connectorTargets.map(target => {
          const state = item[target];
          const test = tests[target];
          const status = state.enabled
            ? state.builtIn
              ? ct('builtInShort')
              : state.signedIn === true
                ? `${ct('on')} · ${ct('signedIn')}`
                : state.signedIn === false
                  ? `${ct('on')} · ${ct('notSignedIn')}`
                  : ct('on')
            : ct('off');
          return (
            <div key={target} className={`connector-target${draft[target] ? ' checked' : ''}`}>
              <label className="connector-switch">
                <input
                  type="checkbox"
                  role="switch"
                  checked={draft[target]}
                  disabled={saving || (Boolean(unavailable) && !state.enabled)}
                  onChange={event => setDraft(current => ({ ...current, [target]: event.target.checked }))}
                />
                <span>{ct(target)}</span>
              </label>
              <span className={`connector-status ${state.enabled ? 'on' : 'off'}`} title={state.enabled && state.builtIn ? ct('builtIn') : undefined}>
                {status}
              </span>
              {state.enabled && !state.builtIn ? (
                <button type="button" className="secondary-button compact-button" disabled={test?.running || saving} onClick={() => void runTest(target)}>
                  {test?.running ? ct('testing') : ct('test')}
                </button>
              ) : null}
              {test && !test.running ? <TestLine test={test} /> : null}
            </div>
          );
        })}
      </div>

      {aiTestable ? (
        <div className="connector-ai-test">
          <button type="button" className="secondary-button compact-button" disabled={aiTest?.running || saving} aria-busy={aiTest?.running} onClick={() => void runAiTest()}>
            <Sparkles size={14} aria-hidden="true" />{aiTest?.running ? ct('aiTesting') : ct('aiTest')}
          </button>
          {aiTest && !aiTest.running ? (
            <AiTestLine test={aiTest} connectorId={item.id} />
          ) : (
            <details className="connector-hint connector-hint-details">
              <summary>{ct('aiTestHowTitle')}</summary>
              <p>{ct('aiTestHint')}{aiTestDesktopOnly ? <> {ct('aiTestDesktopCopy')}</> : null}</p>
            </details>
          )}
        </div>
      ) : null}

      {item.id === 'google' ? (
        <details className="connector-guide">
          <summary>{ct('googleGuideTitle')}</summary>
          <ol>
            <li>{ct('googleGuideClient')} <GuideLink url={guideLinks.googleClients} label={ct('openClients')} /></li>
            <li>{ct('googleGuideTestUser')} <GuideLink url={guideLinks.googleAudience} label={ct('openAudience')} /></li>
            <li>{ct('googleGuidePublish')} <GuideLink url={guideLinks.googleBranding} label={ct('openBranding')} /></li>
          </ol>
        </details>
      ) : null}
      {item.id === 'microsoft365' ? (
        <section className="connector-steps" aria-labelledby={`connector-${item.id}-steps`}>
          <h3 id={`connector-${item.id}-steps`}>{ct('microsoftDesktopGuideTitle')}</h3>
          <ol>
            <li className={item.secretsConfigured ? 'done' : undefined}>
              <span className="connector-step-number" aria-hidden="true">{item.secretsConfigured ? <Check size={12} /> : 1}</span>
              <div>
                <strong>{ct('microsoftStepCreate')}</strong>
                <details className="connector-hint-details">
                  <summary>{ct('microsoftStepCreateHow')}</summary>
                  <ul>
                    <li>{ct('microsoftDesktopGuideRegister')} <GuideLink url={guideLinks.entraAppRegistrations} label={ct('openAppRegistrations')} /></li>
                    <li>{ct('microsoftDesktopGuideRedirect')}</li>
                    <li>{ct('microsoftDesktopGuidePermissions')}</li>
                  </ul>
                </details>
              </div>
            </li>
            <li className={item.secretsConfigured ? 'done' : undefined}>
              <span className="connector-step-number" aria-hidden="true">{item.secretsConfigured ? <Check size={12} /> : 2}</span>
              <div>
                <strong>{ct('microsoftStepPaste')}</strong>
                <small>{ct('microsoftStepPasteBody')}</small>
              </div>
            </li>
            <li>
              <span className="connector-step-number" aria-hidden="true">3</span>
              <div>
                <strong>{ct('microsoftStepRestart')}</strong>
                <small>{ct('microsoftStepRestartBody')}</small>
              </div>
            </li>
          </ol>
        </section>
      ) : null}

      {item.id === 'microsoft365' ? (
        <details className="connector-guide">
          <summary>{ct('microsoftGuideTitle')}</summary>
          <p>{ct('microsoftGuideBody')} <GuideLink url={guideLinks.entra} label={ct('openEntra')} /></p>
        </details>
      ) : null}
      {item.accessLevels.length > 0 ? (
        <label className="connector-field">
          <span>{ct('access')}</span>
          <select
            value={draft.access ?? item.accessLevels[0]}
            disabled={saving}
            onChange={event => setDraft(current => ({ ...current, access: event.target.value }))}
          >
            {item.accessLevels.map(level => <option key={level} value={level}>{accessLabel(level)}</option>)}
          </select>
        </label>
      ) : null}

      {item.secretNames.length > 0 ? (
        <div className="connector-secrets">
          <div className="connector-secrets-status">
            <span>{item.secretsDesktopOnly ? ct('desktopLoginSettings') : ct('loginSettings')}: <strong>{item.secretsConfigured ? ct('configured') : ct('notConfigured')}</strong></span>
            {item.secretsConfigured && !editingSecrets ? (
              <button type="button" className="secondary-button compact-button" onClick={() => setEditingSecrets(true)}>{ct('change')}</button>
            ) : null}
          </div>
          {showSecrets ? (
            <>
              {item.secretNames.map(name => (
                <label key={name} className="connector-field">
                  <span>{dt(name)}</span>
                  <input
                    type={plainSecretNames.includes(name) ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    value={draft.secrets[name] ?? ''}
                    disabled={saving}
                    onChange={event => setDraft(current => ({ ...current, secrets: { ...current.secrets, [name]: event.target.value } }))}
                  />
                </label>
              ))}
              <p className="connector-hint">{ct('secretHint')}</p>
            </>
          ) : null}
        </div>
      ) : null}

      {saveError ? <p className="connectors-error" role="alert">{saveError}</p> : null}
      {changed ? (
        <div className="connector-actions">
          <button
            type="button"
            className="primary-button compact-button"
            disabled={saving || missing.length > 0}
            title={missing.length > 0 ? `${ct('missingSecret')} ${missing.map(dt).join(', ')}` : undefined}
            onClick={() => void save()}
          >
            {saving ? ct('saving') : ct('save')}
          </button>
          <button type="button" className="secondary-button compact-button" disabled={saving} onClick={() => { setDraft(draftFromItem(item)); setEditingSecrets(false); setSaveError(null); }}>
            {ct('reset')}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function TestLine({ test }: { test: TestState }) {
  const { locale } = useI18n();
  const ct = (key: ConnectorTextKey) => connectorText(key, locale);
  if (test.error) return <p className="connector-test failed">{ct('testFailed')} {test.error}</p>;
  const result = test.result;
  if (!result) return null;
  if (result.status === 'ok') return <p className="connector-test ok">{ct('testOk')} {result.toolCount ?? 0}</p>;
  if (result.status === 'needsSignIn') return <p className="connector-test warn">{ct('testNeedsSignIn')}</p>;
  if (result.status === 'builtIn') return <p className="connector-test">{ct('testBuiltIn')}</p>;
  return <p className="connector-test failed">{ct('testFailed')} {result.message}</p>;
}

function GuideLink({ url, label }: { url: string; label: string }) {
  return (
    <button type="button" className="connector-guide-link" onClick={() => openLink(url)}>
      {label}<ExternalLink size={12} aria-hidden="true" />
    </button>
  );
}

function AiTestLine({ test, connectorId }: { test: TestState; connectorId: string }) {
  const { locale } = useI18n();
  const ct = (key: ConnectorTextKey) => connectorText(key, locale);
  if (test.error) return <p className="connector-test failed">{ct('aiTestFailed')} {test.error}</p>;
  const result = test.result;
  if (!result) return null;
  if (result.status === 'ok') return <p className="connector-test ok">{ct('aiTestOk')} {result.message}</p>;
  if (result.status === 'needsSignIn') return <p className="connector-test warn">{ct(result.message === 'desktopOnly' ? 'aiTestMicrosoftDesktopOnly' : 'aiTestNeedsSignIn')}</p>;
  // Google's "Access blocked" (403 access_denied) means the account is not a test user yet.
  const blocked = connectorId === 'google' && /access_denied|access blocked|403/i.test(result.message ?? '');
  return (
    <p className="connector-test failed">
      {ct('aiTestFailed')} {result.message}
      {blocked ? <> {ct('googleGuideTestUser')} <GuideLink url={guideLinks.googleAudience} label={ct('openAudience')} /></> : null}
    </p>
  );
}
