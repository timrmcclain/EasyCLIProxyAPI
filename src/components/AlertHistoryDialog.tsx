import { ArrowRight, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { ALERT_HISTORY_EVENT, clearAlertHistory, markAlertsRead, readAlertHistory, type AlertEntry } from '../services/notifications';
import { useDialogFocusTrap } from './useDialogFocusTrap';

/** The alert history, kept current while anything adds to it. */
export function useAlertHistory(): AlertEntry[] {
  const [entries, setEntries] = useState(readAlertHistory);
  useEffect(() => {
    const sync = () => setEntries(readAlertHistory());
    window.addEventListener(ALERT_HISTORY_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(ALERT_HISTORY_EVENT, sync); window.removeEventListener('storage', sync); };
  }, []);
  return entries;
}

/**
 * Every alert the hub raised, newest first, including ones a switch or quiet hours kept from popping up.
 * Windows doesn't tell the hub when one of its notifications is clicked, so this is where an alert opens its page.
 */
export function AlertHistoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const entries = useAlertHistory();
  const dialogRef = useDialogFocusTrap<HTMLDivElement>({ active: open, onEscape: onClose });
  // Opening the list counts as reading it.
  useEffect(() => { if (open) markAlertsRead(); }, [open, entries.length]);
  if (!open) return null;
  const openPage = (page: string) => {
    window.dispatchEvent(new CustomEvent('app:navigate', { detail: page }));
    onClose();
  };
  return (
    <div className="command-palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="glossary-dialog alert-history-dialog" role="dialog" aria-modal="true" aria-labelledby="alert-history-title">
        <header>
          <h2 id="alert-history-title">{t('alerts.title')}</h2>
          {entries.length > 0 && <button type="button" className="secondary-button compact-button" onClick={clearAlertHistory}>{t('alerts.clear')}</button>}
          <button type="button" className="icon-button quiet" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        {entries.length === 0 ? <p className="alert-history-empty">{t('alerts.empty')}</p> : (
          <ol className="alert-history-list">
            {entries.map(entry => (
              <li key={entry.id} className={`alert-history-item alert-kind-${entry.kind}`}>
                <div>
                  <strong>{entry.title}</strong>
                  {entry.body && <span>{entry.body}</span>}
                  <small>
                    <time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
                    {' · '}{t(`alerts.kind.${entry.kind}` as MessageKey)}
                    {entry.silenced && <> · <em>{t(`alerts.silenced.${entry.silenced}` as MessageKey)}</em></>}
                  </small>
                </div>
                {entry.page && <button type="button" className="secondary-button compact-button" onClick={() => openPage(entry.page!)}>
                  {t('alerts.openPage')}<ArrowRight size={14} aria-hidden="true" />
                </button>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
