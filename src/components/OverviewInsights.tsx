import { navigateHelp } from '../services/uxNavigation';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { quotaAvailability } from '../services/quotaAvailability';
import { primaryQuotaRow, quotaPercentLeft } from '../services/quotaLedger';
import { fileName, quotaKey, type AuthFile, type QuotaState } from '../services/quotaService';
import { ALERT_RANK, rankAlerts, recoveredAccounts, failureIdentity, type OverviewAlert } from '../services/overviewInsights';
import { readOverviewAlertsPreference } from '../services/dashboardPreferences';
import { requestClient, privateText, type DashboardRequest } from '../services/dashboardActivity';
import { failureKind } from '../services/connectionPresentation';
import { isRecord, managementApi } from '../services/managementApi';

type Props = { files: AuthFile[]; quotas: Record<string, QuotaState>; now: number; stale: boolean; labelFor: (file: AuthFile) => string };

export function AlternativeComparison({ files, quotas, now, stale, labelFor, onClose, onUse }: Props & { onClose: () => void; onUse?: (file: AuthFile) => void }) {
  const { t } = useI18n();
  // Ranked: fully available before partly available before credit-backed, then the most quota left.
  const rank = { available: 0, limited: 1, creditBacked: 2 } as Record<string, number>;
  const left = (file: AuthFile) => quotaPercentLeft(primaryQuotaRow(quotas[quotaKey(file)]?.rows ?? [], []))?.percent ?? -1;
  const candidates = files.filter(file => ['available', 'limited', 'creditBacked'].includes(quotaAvailability(file, quotas[quotaKey(file)], now, stale).kind))
    .sort((a, b) => rank[quotaAvailability(a, quotas[quotaKey(a)], now, stale).kind] - rank[quotaAvailability(b, quotas[quotaKey(b)], now, stale).kind] || left(b) - left(a));
  const best = candidates[0];
  return <section className="ux-insight ux-alternatives" aria-label={t('ux.alternatives')}>
    <header><h3>{t('ux.alternatives')}</h3><button className="secondary-button compact-button" onClick={onClose}>{t('common.close')}</button></header>
    <p>{t('ux.alternativesHint')}</p>
    {best && <p className="ux-best">
      <strong>{left(best) >= 0 ? t('ai.best', { account: labelFor(best), percent: Math.round(left(best)) }) : t('ai.bestUnknown', { account: labelFor(best) })}</strong>
      {onUse && <button type="button" className="primary-button compact-button" onClick={() => onUse(best)}>{t('ai.useBest')}</button>}
    </p>}
    {candidates.length ? <div className="ux-comparison">{candidates.map(file => {
      const quota = quotas[quotaKey(file)]; const state = quotaAvailability(file, quota, now, stale);
      return <article key={quotaKey(file)}><h4>{labelFor(file)}</h4>
        <p>{t(state.kind === 'creditBacked' ? 'ux.creditCandidate' : state.kind === 'limited' ? 'ux.partialCandidate' : 'ux.candidate')}</p>
        {state.groups?.map(group => <small key={group.id}>{group.label}: {t(`availability.${group.kind}`)}</small>)}
        {quota?.fetchedAt && <small>{t('accountDashboard.quotaChecked', { time: new Date(quota.fetchedAt).toLocaleTimeString() })}</small>}
        <CandidateModels file={file} />
      </article>;
    })}</div> : <p>{t('availability.noMatches')}</p>}
  </section>;
}

function CandidateModels({ file }: { file: AuthFile }) {
  const { t } = useI18n();
  const [models, setModels] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true); setError(false);
    try {
      const result = await managementApi.get('/credentials/models', { name: fileName(file) });
      setModels(isRecord(result) && Array.isArray(result.models) ? result.models.filter(isRecord) : []);
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  return <div className="ux-model-catalog"><button className="secondary-button compact-button" disabled={busy} onClick={() => void load()}>{t(busy ? 'accountDashboard.loading' : 'ux.catalog')}</button>
    {error && <p role="status">{t('ux.catalogError')}</p>}
    {models && <ul>{models.map((model, i) => <li key={i}><strong>{privateText(String(model.id ?? model.name ?? '—'), true)}</strong>
      <small>{Array.isArray(model.input_modalities) && model.input_modalities.every(x => typeof x === 'string') ? t('ux.features', { types: model.input_modalities.join(', ') }) : t('ux.featuresUnknown')}</small>
      {typeof model.context_length === 'number' && model.context_length > 0 && <small>{t('ux.context', { count: model.context_length.toLocaleString() })}</small>}
    </li>)}</ul>}{models?.length === 0 && <p>{t('ux.catalogEmpty')}</p>}
  </div>;
}

export function OverviewAlerts({ files, quotas, now, stale, labelFor, items, activityStale }: Props & { items: DashboardRequest[] | undefined; activityStale: boolean }) {
  const { t } = useI18n();
  const [enabled] = useState(() => readOverviewAlertsPreference());
  const previous = useRef<Record<string, string>>({});
  const seen = useRef(new Set<string>());
  const initialized = useRef(false);
  const [alerts, setAlerts] = useState<OverviewAlert[]>([]);
  useEffect(() => {
    const next = Object.fromEntries(files.map(file => [quotaKey(file), quotaAvailability(file, quotas[quotaKey(file)], now, stale).kind]));
    const recovered = stale ? [] : recoveredAccounts(previous.current, next);
    previous.current = next;
    const observedAt = Date.now();
    const failures = !activityStale && items ? items.filter(item => item.failed && !item.canceled && Date.parse(item.timestamp) <= observedAt && observedAt - Date.parse(item.timestamp) < 5 * 60_000) : [];
    const fresh = initialized.current ? failures.filter(item => !seen.current.has(failureIdentity(item))) : [];
    if (items && !activityStale) initialized.current = true;
    failures.forEach(item => seen.current.add(failureIdentity(item)));
    if (seen.current.size > 1000) seen.current = new Set(failures.map(failureIdentity));
    if (!enabled) return;
    const messages: OverviewAlert[] = recovered.flatMap(key => {
      const file = files.find(file => quotaKey(file) === key);
      return file ? [{ key, text: t('ux.recovered', { account: labelFor(file) }), rank: ALERT_RANK.recovered, at: observedAt }] : [];
    });
    // Group a burst by client and failure category rather than flooding the user.
    const grouped = new Map(fresh.map(item => [`${requestClient(item)}-${failureKind(item)}`, item]));
    grouped.forEach((item, key) => messages.push({ key, text: `${t('ux.failed', { client: requestClient(item) ?? t('ledger.unknownClient') })} ${t(`ux.${failureKind(item)}`)}`,
      rank: ALERT_RANK[failureKind(item)], at: observedAt }));
    // Ranked rather than in arrival order, so a burst of good news can't push a rejected sign-in off the list.
    if (messages.length) setAlerts(current => rankAlerts([...current.filter(a => !messages.some(b => b.key === a.key)), ...messages]));
  }, [files, quotas, now, stale, items, activityStale, enabled, labelFor, t]);
  // The on/off switch lives in Settings → App preferences; Overview only shows alerts that need attention.
  if (!enabled || !alerts.length) return null;
  return <div className="ux-alerts">
    <div role="status" aria-live="polite"><ul>{alerts.map(a => <li key={a.key} className={a.rank === ALERT_RANK.recovered ? 'ux-alert-good' : a.rank === ALERT_RANK.auth ? 'ux-alert-urgent' : undefined}>{a.text}</li>)}</ul><button className="secondary-button compact-button" onClick={() => navigateHelp('agents')}>{t('ux.reviewConnection')}</button><button className="secondary-button compact-button" onClick={() => setAlerts([])}>{t('ux.dismissAlerts')}</button></div>
  </div>;
}
