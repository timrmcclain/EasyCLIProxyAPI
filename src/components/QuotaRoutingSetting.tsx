import { useEffect, useMemo, useRef, useState } from 'react';
import './QuotaRoutingSetting.css';
import { ListOrdered } from 'lucide-react';
import { FeedbackNotice, useAppNotice } from '../appNotice';
import { useI18n } from '../i18n';
import { dedupeAuthFiles } from '../services/authFiles';
import { managementApi, responseList } from '../services/managementApi';
import { useQuotaCache } from '../services/quotaCache';
import { routingPlan } from '../services/quotaRouting';
import { disableQuotaRouting, enableQuotaRouting, readQuotaRoutingPreference } from '../services/quotaRoutingControl';
import type { AuthFile } from '../services/quotaService';
import { labelFor } from '../services/quotaWatcher';
import { SettingsHelp } from './SettingsHelp';

const providerNames: Record<string, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', xai: 'Grok', kimi: 'Kimi', devin: 'Devin', gemini: 'Gemini' };

/** Settings → Routing: soonest-reset-first account priorities, with the order it would set right now. */
export function QuotaRoutingSetting({ strategy, disabled }: { strategy?: string; disabled?: boolean }) {
  const { t } = useI18n();
  const notice = useAppNotice();
  const quotas = useQuotaCache();
  const [enabled, setEnabled] = useState(readQuotaRoutingPreference);
  const [busy, setBusy] = useState(false);
  // Also read by Undo, whose click handler was made before the current change started.
  const busyRef = useRef(false);
  const [files, setFiles] = useState<AuthFile[]>([]);

  useEffect(() => {
    let active = true;
    managementApi.get('/credentials')
      .then(payload => { if (active) setFiles(dedupeAuthFiles(responseList(payload, 'files'))); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [enabled]);

  const plans = useMemo(() => routingPlan(files, quotas, Date.now()), [files, quotas]);

  const change = async (next: boolean, offerUndo = true) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (next) await enableQuotaRouting(); else await disableQuotaRouting();
      setEnabled(next);
      notice.showNotice({ key: next ? 'common.saved' : 'qrouting.restored' }, 'success', offerUndo ? {
        action: { label: { key: 'common.undo' }, onAction: () => void change(!next, false) },
      } : undefined);
    } catch (error) {
      notice.showNotice(t('qrouting.error', { error: String(error) }), 'error');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="config-network-field qrouting">
      <div className="qrouting-head">
        <span className="config-field-label">
          <ListOrdered size={16} aria-hidden="true" />
          <span>{t('qrouting.setting')}</span>
          <SettingsHelp label={t('qrouting.setting')}>{t('qrouting.settingHint')}</SettingsHelp>
        </span>
        <label className="switch-control" title={t('qrouting.setting')}>
          <input type="checkbox" role="switch" aria-label={t('qrouting.setting')} checked={enabled}
            disabled={disabled || busy} onChange={event => void change(event.currentTarget.checked)} />
          <span className="switch-track" />
        </label>
      </div>
      <FeedbackNotice feedback={notice} />
      <details className="qrouting-preview">
        <summary className="qrouting-preview-title">{t('qrouting.preview')}</summary>
        {strategy && strategy !== 'fill-first' && <p className="qrouting-note">{t('qrouting.notFillFirst')}</p>}
        {plans.length === 0 ? <p className="qrouting-note">{t('qrouting.previewEmpty')}</p> : (
          <ul>
            {plans.map(plan => (
              <li key={plan.provider}>
                <strong>{providerNames[plan.provider] ?? plan.provider}</strong>
                <ol>
                  {plan.order.map(entry => (
                    <li key={entry.key} className={`qrouting-tier-${entry.tier}`}>
                      {labelFor(entry.file)}
                      {entry.tier !== 'ready' && <span className="qrouting-tier">{t(`qrouting.tier.${entry.tier}`)}</span>}
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}
