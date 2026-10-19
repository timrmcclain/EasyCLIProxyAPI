import { useState } from 'react';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { ALERT_KINDS, readAlertKinds, readQuietHours, saveAlertKind, saveQuietHours, type AlertKind, type QuietHours } from '../services/notifications';

/** Which kinds of alert pop up, and quiet hours. Shown under the desktop alerts switch while it's on. */
export function AlertKindSettings() {
  const { t } = useI18n();
  const [kinds, setKinds] = useState(readAlertKinds);
  const [quiet, setQuiet] = useState(readQuietHours);
  const toggleKind = (kind: AlertKind, on: boolean) => {
    saveAlertKind(kind, on);
    setKinds(readAlertKinds());
  };
  const changeQuiet = (next: Partial<QuietHours>) => {
    const value = { ...quiet, ...next };
    saveQuietHours(value);
    setQuiet(value);
  };
  return (
    <div className="alert-kind-settings">
      <fieldset>
        <legend>{t('alerts.kindsTitle')}</legend>
        {ALERT_KINDS.map(kind => (
          <label key={kind} className="alert-kind-option">
            <input type="checkbox" checked={kinds[kind]} onChange={event => toggleKind(kind, event.currentTarget.checked)} />
            <span>{t(`alerts.kind.${kind}` as MessageKey)}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="alert-quiet-hours">
        <legend>
          <label className="alert-kind-option">
            <input type="checkbox" checked={quiet.enabled} onChange={event => changeQuiet({ enabled: event.currentTarget.checked })} />
            <span>{t('alerts.quietHours')}</span>
          </label>
        </legend>
        <span className="alert-quiet-range">
          <label>{t('alerts.quietFrom')} <input type="time" value={quiet.start} disabled={!quiet.enabled} onChange={event => changeQuiet({ start: event.currentTarget.value })} /></label>
          <label>{t('alerts.quietTo')} <input type="time" value={quiet.end} disabled={!quiet.enabled} onChange={event => changeQuiet({ end: event.currentTarget.value })} /></label>
        </span>
        <small>{t('alerts.quietHint')}</small>
      </fieldset>
    </div>
  );
}
