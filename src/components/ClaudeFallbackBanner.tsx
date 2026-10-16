import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { LoaderCircle, Shuffle } from 'lucide-react';
import { useI18n } from '../i18n';
import { dedupeAuthFiles } from '../services/authFiles';
import { claudeAllOut, fallbackModels } from '../services/claudeFallback';
import { managementApi, responseList } from '../services/managementApi';
import type { ModelOption } from '../services/modelService';
import { useQuotaCache } from '../services/quotaCache';
import type { AuthFile } from '../services/quotaService';
import { readableError } from '../services/readableError';
import './AppDriftBanner.css';

/**
 * When every Claude account is out, offers to point Claude Code at a model from another provider until one resets.
 * Nothing changes until you click Switch, and Switch back restores Claude Code's own model settings exactly.
 */
export function ClaudeFallbackBanner({ coreReady }: { coreReady: boolean }) {
  const { t } = useI18n();
  const quotas = useQuotaCache();
  const [files, setFiles] = useState<AuthFile[]>([]);
  const [switchedTo, setSwitchedTo] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [payload, state] = await Promise.all([
        managementApi.get('/credentials'),
        invoke<{ model: string | null }>('claude_fallback_state'),
      ]);
      setFiles(dedupeAuthFiles(responseList(payload, 'files')));
      setSwitchedTo(state.model ?? null);
    } catch { /* nothing to offer if either check fails */ }
  }, []);

  useEffect(() => {
    if (!coreReady) return;
    void load();
    const timer = window.setInterval(() => { void load(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [coreReady, load]);

  const allOut = claudeAllOut(files, quotas, Date.now());

  useEffect(() => {
    if (!allOut || switchedTo || models.length) return;
    invoke<ModelOption[]>('get_agent_models', { client: 'pi' })
      .then(list => { const names = fallbackModels(list); setModels(names); setChoice(current => current || names[0] || ''); })
      .catch(() => undefined);
  }, [allOut, switchedTo, models.length]);

  const run = async (command: 'switch_claude_code_model' | 'switch_claude_code_back') => {
    setBusy(true);
    setError('');
    try {
      const state = await invoke<{ model: string | null }>(command, command === 'switch_claude_code_model' ? { model: choice } : undefined);
      setSwitchedTo(state.model ?? null);
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setBusy(false);
    }
  };

  if (switchedTo) {
    return <section className="app-drift-banner" role="status">
      <Shuffle size={18} aria-hidden="true" />
      <div className="app-drift-copy">
        <strong>{t(allOut ? 'fallback.switched' : 'fallback.switchedBack', { model: switchedTo })}</strong>
        <small>{t('fallback.newSessions')}</small>
        {error && <small className="app-drift-manual">{error}</small>}
      </div>
      <div className="app-drift-actions">
        <button type="button" className="primary-button compact-button" disabled={busy} onClick={() => void run('switch_claude_code_back')}>
          {busy && <LoaderCircle size={14} className="spin" aria-hidden="true" />}{t('fallback.back')}
        </button>
      </div>
    </section>;
  }
  if (!allOut || !models.length) return null;
  return <section className="app-drift-banner" role="status">
    <Shuffle size={18} aria-hidden="true" />
    <div className="app-drift-copy">
      <strong>{t('fallback.offer')}</strong>
      <small>{t('fallback.newSessions')}</small>
      {error && <small className="app-drift-manual">{error}</small>}
    </div>
    <div className="app-drift-actions">
      <select aria-label={t('fallback.model')} value={choice} onChange={event => setChoice(event.target.value)} disabled={busy}>
        {models.map(name => <option key={name} value={name}>{name}</option>)}
      </select>
      <button type="button" className="primary-button compact-button" disabled={busy || !choice} onClick={() => void run('switch_claude_code_model')}>
        {busy && <LoaderCircle size={14} className="spin" aria-hidden="true" />}{t('fallback.switch')}
      </button>
    </div>
  </section>;
}
