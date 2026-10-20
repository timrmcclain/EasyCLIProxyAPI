import { X } from 'lucide-react';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { useDialogFocusTrap } from './useDialogFocusTrap';

// Every keyboard shortcut the app has; opened with "?" and from Ctrl+K.
const SHORTCUTS: { keys: string[][]; label: MessageKey }[] = [
  { keys: [['Ctrl', 'K']], label: 'shortcuts.palette' },
  { keys: [['Ctrl', '1–7']], label: 'shortcuts.pages' },
  { keys: [['/']], label: 'shortcuts.search' },
  { keys: [['R']], label: 'shortcuts.refresh' },
  { keys: [['Alt', '←'], ['Alt', '→']], label: 'shortcuts.history' },
  { keys: [['?']], label: 'shortcuts.help' },
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const dialogRef = useDialogFocusTrap<HTMLDivElement>({ active: open, onEscape: onClose });
  if (!open) return null;
  return (
    <div className="command-palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="glossary-dialog shortcuts-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        <header>
          <h2 id="shortcuts-title">{t('shortcuts.title')}</h2>
          <button type="button" className="icon-button quiet" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <dl>
          {SHORTCUTS.map(({ keys, label }) => (
            <div key={label}>
              <dt>{keys.map((combo, index) => (
                <span key={combo.join('+')}>
                  {index ? <span className="shortcuts-or"> / </span> : null}
                  {combo.map((key, keyIndex) => <span key={key}>{keyIndex ? '+' : null}<kbd>{key}</kbd></span>)}
                </span>
              ))}</dt>
              <dd>{t(label)}</dd>
            </div>
          ))}
        </dl>
        <p className="shortcuts-note">{t('shortcuts.note')}</p>
      </div>
    </div>
  );
}
