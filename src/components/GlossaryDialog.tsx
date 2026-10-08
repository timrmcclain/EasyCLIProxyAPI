import { X } from 'lucide-react';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { useDialogFocusTrap } from './useDialogFocusTrap';

// One plain-language definition per term the app uses; opened from the sidebar and Ctrl+K.
const TERMS = ['proxy', 'account', 'quota', 'cooldown', 'priority', 'fillFirst', 'affinity', 'alias', 'oauth', 'context1m', 'harness', 'connector'] as const;

export function GlossaryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const dialogRef = useDialogFocusTrap<HTMLDivElement>({ active: open, onEscape: onClose });
  if (!open) return null;
  return (
    <div className="command-palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="glossary-dialog" role="dialog" aria-modal="true" aria-labelledby="glossary-title">
        <header>
          <h2 id="glossary-title">{t('glossary.title')}</h2>
          <button type="button" className="icon-button quiet" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <dl>
          {TERMS.map((term) => (
            <div key={term}>
              <dt>{t(`glossary.${term}.term` as MessageKey)}</dt>
              <dd>{t(`glossary.${term}.definition` as MessageKey)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
