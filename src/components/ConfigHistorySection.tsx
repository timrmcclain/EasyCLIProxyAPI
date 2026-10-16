import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { History, RotateCcw } from 'lucide-react';
import { useI18n } from '../i18n';
import { useConfirmation } from './ConfirmationDialog';
import { readableError } from '../services/readableError';
import './ConfigHistorySection.css';

type ConfigVersion = {
  name: string; savedAt: string; size: number; current: boolean;
  /** Setting names only; the backend never sends values, since the config holds keys. */
  changes: string[]; moreChanges: number; restoreChanges: string[]; moreRestoreChanges: number;
};

/** Settings → Diagnostics: earlier versions of the proxy's config.yaml, each restorable. */
export function ConfigHistorySection({ hidden }: { hidden: boolean }) {
  const { t, locale } = useI18n();
  const { askConfirmation, confirmationDialog } = useConfirmation();
  const [versions, setVersions] = useState<ConfigVersion[] | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setVersions(await invoke<ConfigVersion[]>('list_core_config_history').catch(() => []));
  }, []);
  useEffect(() => { if (!hidden) void load(); }, [hidden, load]);

  const when = (iso: string) => new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'medium' });

  const listOf = (names: string[], more: number) => more > 0 ? t('configHistory.more', { list: names.join(', '), count: more }) : names.join(', ');

  const restore = async (version: ConfigVersion) => {
    const restoring = version.restoreChanges.length > 0 ? ` ${t('configHistory.confirm.changes', { list: listOf(version.restoreChanges, version.moreRestoreChanges) })}` : '';
    const confirmed = await askConfirmation({
      title: t('configHistory.confirm.title'),
      message: t('configHistory.confirm.message', { time: when(version.savedAt) }) + restoring,
      warning: t('configHistory.confirm.warning'),
      confirmText: t('configHistory.restore'),
    });
    if (!confirmed) return;
    setBusy(version.name);
    setMessage(null);
    try {
      await invoke('restore_core_config_history', { name: version.name });
      setMessage({ tone: 'ok', text: t('configHistory.restored', { time: when(version.savedAt) }) });
    } catch (error) {
      setMessage({ tone: 'error', text: readableError(error) });
    } finally {
      setBusy(null);
      await load();
    }
  };

  return (
    <section id="config-native-history" tabIndex={-1} hidden={hidden} className="panel config-history-panel" aria-labelledby="config-history-title">
      <div className="config-panel-heading">
        <div className="config-heading-title">
          <History size={18} aria-hidden="true" />
          <h2 id="config-history-title">{t('configHistory.title')}</h2>
        </div>
      </div>
      <p className="config-history-intro">{t('configHistory.intro')}</p>
      {versions && versions.length === 0 && <p className="config-history-empty">{t('configHistory.none')}</p>}
      {versions && versions.length > 0 && (
        <ul className="config-history-list">
          {versions.map(version => (
            <li key={version.name}>
              <span className="config-history-time">{when(version.savedAt)}</span>
              <span className="config-history-size">{t('configHistory.size', { size: (version.size / 1024).toFixed(1) })}</span>
              <span className="config-history-changes">
                {version.changes.length > 0 ? t('configHistory.changed', { list: listOf(version.changes, version.moreChanges) }) : versions.indexOf(version) < versions.length - 1 ? t('configHistory.noChanges') : ''}
              </span>
              {version.current
                ? <span className="config-history-current">{t('configHistory.current')}</span>
                : (
                  <button type="button" className="secondary-button compact-button" disabled={busy !== null} onClick={() => void restore(version)}>
                    <RotateCcw size={14} aria-hidden="true" />
                    {busy === version.name ? t('configHistory.restoring') : t('configHistory.restore')}
                  </button>
                )}
            </li>
          ))}
        </ul>
      )}
      {message && <p className={`config-history-message config-history-message-${message.tone}`} role="status">{message.text}</p>}
      {confirmationDialog}
    </section>
  );
}
