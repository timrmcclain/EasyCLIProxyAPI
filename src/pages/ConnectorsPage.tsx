import { useCallback, useEffect, useState } from 'react';
import { Plug, RefreshCw, Undo2 } from 'lucide-react';
import { useI18n } from '../i18n';
import { connectorDynamicText, connectorText, type ConnectorTextKey } from '../i18n/connectors';
import {
  connectorsApi,
  connectorTargets,
  draftChanged,
  draftFromItem,
  missingSecretFromError,
  missingSecrets,
  type ConnectorDraft,
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

export function ConnectorsPage() {
  const { locale } = useI18n();
  const ct = (key: ConnectorTextKey) => connectorText(key, locale);
  const [overview, setOverview] = useState<ConnectorOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOverview(await connectorsApi.overview());
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

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
        </div>
        <div className="connectors-heading-actions">
          {overview?.canUndo ? (
            <button type="button" className="secondary-button" disabled={undoing || loading} onClick={() => void undo()}>
              <Undo2 size={16} aria-hidden="true" />{ct('undo')}
              {overview.lastChange ? ` (${connectorDynamicText(`${overview.lastChange}_name`, locale)})` : ''}
            </button>
          ) : null}
          <button type="button" className="secondary-button" disabled={loading} onClick={() => void load()}>
            <RefreshCw size={16} aria-hidden="true" />{ct('refresh')}
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
      {loading && !overview ? <p className="connectors-loading">…</p> : null}
      <div className="connectors-grid">
        {overview?.connectors.map(item => (
          <ConnectorCard
            key={item.id}
            item={item}
            onSaved={(next) => { setOverview(next); setError(null); setNotice(ct('saved')); }}
          />
        ))}
      </div>
    </div>
  );
}

function ConnectorCard({ item, onSaved }: { item: ConnectorOverviewItem; onSaved: (overview: ConnectorOverview) => void }) {
  const { locale } = useI18n();
  const ct = (key: ConnectorTextKey) => connectorText(key, locale);
  const dt = (key: string) => connectorDynamicText(key, locale);
  const [draft, setDraft] = useState<ConnectorDraft>(() => draftFromItem(item));
  const [editingSecrets, setEditingSecrets] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [tests, setTests] = useState<Partial<Record<ConnectorTarget, TestState>>>({});

  useEffect(() => {
    setDraft(draftFromItem(item));
    setEditingSecrets(false);
  }, [item]);

  const changed = draftChanged(item, draft);
  const missing = missingSecrets(item, draft);
  const unavailable = item.unavailableReason ? dt(`unavailable_${item.unavailableReason}`) : null;
  const note = dt(`${item.id}_note`);
  const showSecrets = item.secretNames.length > 0 && (editingSecrets || (!item.secretsConfigured && (draft.claudeCode || draft.claudeDesktop)));

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      onSaved(await connectorsApi.apply(item.id, draft));
      setTests({});
    } catch (error) {
      const secret = missingSecretFromError(error);
      setSaveError(secret ? `${ct('missingSecret')} ${dt(secret)}` : errorText(error));
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

  const accessLabel = (level: string) => {
    if (level === 'readonly') return ct('accessReadonly');
    if (level === 'drafts') return ct('accessDrafts');
    return item.id === 'github' ? ct('accessFullGithub') : ct('accessFull');
  };

  return (
    <section className="connector-card" aria-labelledby={`connector-${item.id}-title`}>
      <header className="connector-card-header">
        <span className="connector-icon" aria-hidden="true"><Plug size={18} /></span>
        <div>
          <h2 id={`connector-${item.id}-title`}>{dt(`${item.id}_name`)}</h2>
          <p>{dt(`${item.id}_body`)}</p>
        </div>
      </header>
      {note ? <p className="connector-note">{note}</p> : null}
      {unavailable ? <p className="connector-unavailable">{unavailable}</p> : null}

      <div className="connector-targets">
        {connectorTargets.map(target => {
          const state = item[target];
          const test = tests[target];
          return (
            <div key={target} className="connector-target">
              <label className="connector-switch">
                <input
                  type="checkbox"
                  checked={draft[target]}
                  disabled={saving || (Boolean(unavailable) && !state.enabled)}
                  onChange={event => setDraft(current => ({ ...current, [target]: event.target.checked }))}
                />
                <span>{ct(target)}</span>
              </label>
              <span className={`connector-status ${state.enabled ? 'on' : 'off'}`}>
                {state.enabled
                  ? state.builtIn
                    ? ct('builtIn')
                    : state.signedIn === true
                      ? `${ct('on')} · ${ct('signedIn')}`
                      : state.signedIn === false
                        ? `${ct('on')} · ${ct('notSignedIn')}`
                        : ct('on')
                  : ct('off')}
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
            <span>{ct('loginSettings')}: <strong>{item.secretsConfigured ? ct('configured') : ct('notConfigured')}</strong></span>
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
                    type="password"
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
