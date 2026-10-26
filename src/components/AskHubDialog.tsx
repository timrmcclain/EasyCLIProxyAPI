import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { LoaderCircle, MessageCircleQuestion, X } from 'lucide-react';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { buildHubPrompt, MAX_QUESTION } from '../services/askHub';
import { summarizeHomeUsage } from '../services/homeOverview';
import { LAST_QUOTA_LINE_KEY } from '../services/morningDigest';
import { pickFinderModel } from '../services/pluginFinder';
import type { ModelOption } from '../services/modelService';
import { readableError } from '../services/readableError';
import { settingsSummary, type SummaryInput } from '../services/settingsSummary';
import { useDialogFocusTrap } from './useDialogFocusTrap';
import './AskHubDialog.css';

/**
 * Ask the hub a question in plain words. It runs only when you press Ask, through your own proxy and one of
 * your own accounts, with a short list of facts about the hub: counts and states, never keys, emails or prompts.
 */
export function AskHubDialog({ page, proxyRunning, onClose }: { page: string; proxyRunning: boolean; onClose: () => void }) {
  const { t, locale } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useDialogFocusTrap<HTMLDialogElement>({ active: true, onEscape: onClose, initialFocusRef: inputRef });
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ text: string; model: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { dialogRef.current?.showModal(); }, [dialogRef]);

  const ask = async () => {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true); setError(''); setAnswer(null);
    try {
      const now = Date.now();
      const [usage, core] = await Promise.all([
        invoke<unknown>('get_usage_overview', { query: { start: new Date(now - 86_400_000).toISOString(), end: new Date(now).toISOString() } })
          .then(summarizeHomeUsage).catch(() => null),
        invoke<NonNullable<SummaryInput['core']> & { apiKeys: unknown[] }>('get_core_config_settings').catch(() => null),
      ]);
      const settings = core ? (['general', 'routing'] as const).flatMap(category =>
        settingsSummary(category, { core: { ...core, apiKeys: core.apiKeys.length } }).slice(1).map(line => t(line.key as MessageKey, line.vars))) : [];
      let quotaLine: string | null = null;
      try { quotaLine = localStorage.getItem(LAST_QUOTA_LINE_KEY); } catch { /* not checked yet */ }
      const model = pickFinderModel(await invoke<ModelOption[]>('get_agent_models', { client: 'pi' }));
      if (!model) throw new Error(t('v7.ask.noModel'));
      const system = buildHubPrompt({ proxyRunning, quotaLine, usage24h: usage, settings, page }, locale);
      const reply = await invoke<string>('ask_plugin_finder', { model, system, question: text });
      setAnswer({ text: reply.trim(), model });
    } catch (cause) { setError(readableError(cause)); }
    finally { setBusy(false); }
  };

  return <dialog ref={dialogRef} className="ask-hub-dialog" aria-labelledby="ask-hub-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header>
      <h2 id="ask-hub-title"><MessageCircleQuestion size={18} aria-hidden="true" />{t('v7.ask.title')}</h2>
      <button type="button" className="icon-button quiet" aria-label={t('common.close')} onClick={onClose}><X size={16} aria-hidden="true" /></button>
    </header>
    <p className="ask-hub-hint">{t('v7.ask.hint')}</p>
    <textarea ref={inputRef} rows={3} maxLength={MAX_QUESTION} aria-label={t('v7.ask.label')} placeholder={t('v7.ask.placeholder')} value={question}
      onChange={(event) => setQuestion(event.currentTarget.value)}
      onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void ask(); } }} />
    <div className="ask-hub-actions">
      <button type="button" className="primary-button compact-button" disabled={busy || !question.trim() || !proxyRunning} onClick={() => void ask()}>
        {busy ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : null}{t(busy ? 'v7.ask.asking' : 'v7.ask.ask')}
      </button>
      {!proxyRunning ? <small>{t('v7.ask.needsProxy')}</small> : null}
    </div>
    {error ? <p className="ask-hub-error" role="alert">{error}</p> : null}
    {answer ? <section className="ask-hub-answer" aria-live="polite">
      <p>{answer.text}</p>
      <small>{t('v7.ask.answeredBy', { model: answer.model })}</small>
    </section> : null}
  </dialog>;
}
