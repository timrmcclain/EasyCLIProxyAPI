import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import './RoutingOrderSetting.css';
import {
  closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS as DndCss } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, GripVertical, ListOrdered, SlidersHorizontal } from 'lucide-react';
import { FeedbackNotice, useAppNotice } from '../appNotice';
import { useI18n } from '../i18n';
import { readAccountFocus, startAccountFocus } from '../services/accountFocus';
import { resetCountdown } from '../services/accountDashboard';
import { dedupeAuthFiles } from '../services/authFiles';
import { loadDashboardActivity, successfulRequest, type DashboardRequest } from '../services/dashboardActivity';
import { managementApi, normalizeAuthIndex, responseList } from '../services/managementApi';
import { useQuotaCache } from '../services/quotaCache';
import { saveProviderRouting, undoProviderRouting } from '../services/quotaRoutingControl';
import { quotaKey, type AuthFile } from '../services/quotaService';
import { labelFor } from '../services/quotaWatcher';
import { readableError } from '../services/readableError';
import {
  orderMismatch, providerPlan, readRoutingState, accountsByProvider,
  type AccountRule, type OrderEntry, type ProviderPlan, type RoutingMode, type RoutingState,
} from '../services/routingOrder';
import { SettingsHelp } from './SettingsHelp';

const providerNames: Record<string, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', xai: 'Grok', kimi: 'Kimi', devin: 'Devin', gemini: 'Gemini' };
const KEEP_OPTIONS = [0, 10, 20, 30, 50];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const RECENT_MS = 2 * 60 * 60 * 1000;

type Draft = { mode: RoutingMode; order: string[]; reserve: string[]; rules: Record<string, AccountRule> };

// Smart decides the order itself, so only Your order compares it.
const sameDraft = (a: Draft, b: Draft) => a.mode === b.mode
  && (a.mode === 'smart' || JSON.stringify(a.order) === JSON.stringify(b.order))
  && JSON.stringify([...a.reserve].sort()) === JSON.stringify([...b.reserve].sort())
  && JSON.stringify(a.rules) === JSON.stringify(b.rules);
const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

/** What a provider's saved choices look like as an editable draft, in the order shown now. */
function draftFor(plan: ProviderPlan, state: RoutingState): Draft {
  const keys = plan.entries.map(entry => entry.key);
  return {
    mode: plan.mode,
    order: keys,
    reserve: state.reserve.filter(key => keys.includes(key)),
    rules: Object.fromEntries(keys.filter(key => state.rules[key]).map(key => [key, state.rules[key]])),
  };
}

/** The state as it would be with this draft saved, for previewing the order before saving. */
function stateWith(state: RoutingState, provider: string, draft: Draft, keys: string[]): RoutingState {
  const rules = { ...state.rules };
  for (const key of keys) { if (draft.rules[key]) rules[key] = draft.rules[key]; else delete rules[key]; }
  return {
    ...state,
    providers: { ...state.providers, [provider]: { mode: draft.mode, order: draft.order } },
    reserve: [...state.reserve.filter(key => !keys.includes(key)), ...draft.reserve],
    rules,
  };
}

/** Settings → Routing: one order per provider that decides which account pays for each request. */
export function RoutingOrderSetting({ strategy, sessionAffinity, disabled, onUseFillFirst }: {
  strategy?: string; sessionAffinity?: boolean; disabled?: boolean; onUseFillFirst?: () => void;
}) {
  const { t } = useI18n();
  const notice = useAppNotice();
  const quotas = useQuotaCache();
  const [files, setFiles] = useState<AuthFile[]>([]);
  const [state, setState] = useState(readRoutingState);
  const [recent, setRecent] = useState<DashboardRequest[]>([]);
  const [focus, setFocus] = useState(readAccountFocus);
  const [now, setNow] = useState(Date.now);

  const reload = useCallback(() => {
    managementApi.get('/credentials')
      .then(payload => setFiles(dedupeAuthFiles(responseList(payload, 'files'))))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    reload();
    loadDashboardActivity().then(activity => setRecent(activity.items)).catch(() => undefined);
    const sync = () => { setState(readRoutingState()); setFocus(readAccountFocus()); setNow(Date.now()); };
    window.addEventListener('app:routing-order', sync);
    window.addEventListener('app:account-focus', sync);
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      window.removeEventListener('app:routing-order', sync);
      window.removeEventListener('app:account-focus', sync);
      window.clearInterval(timer);
    };
  }, [reload]);

  const groups = useMemo(() => [...accountsByProvider(files)], [files]);
  const recentByKey = useMemo(() => {
    const byIndex = new Map(files.map(file => [normalizeAuthIndex(file.auth_index ?? file.authIndex), quotaKey(file)]));
    const counts: Record<string, number> = {};
    for (const item of recent) {
      if (!successfulRequest(item) || now - Date.parse(item.timestamp) > RECENT_MS) continue;
      const key = byIndex.get(normalizeAuthIndex(item.auth_index));
      if (key) counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [files, recent, now]);

  return (
    <div className="config-network-field routing-order">
      <div className="routing-order-head">
        <span className="config-field-label">
          <ListOrdered size={16} aria-hidden="true" />
          <span>{t('ro.title')}</span>
          <SettingsHelp label={t('ro.title')}>{t('ro.intro')}</SettingsHelp>
        </span>
      </div>
      {strategy && strategy !== 'fill-first' && <div className="routing-order-warning" role="note">
        <span>{t('ro.notFillFirst', { strategy })}</span>
        {onUseFillFirst && <button type="button" className="secondary-button compact-button" disabled={disabled} onClick={onUseFillFirst}>{t('ro.useFillFirst')}</button>}
      </div>}
      {sessionAffinity !== undefined && <p className="routing-order-note">{t(sessionAffinity ? 'ro.affinityOn' : 'ro.affinityOff')}</p>}
      <FeedbackNotice feedback={notice} />
      {groups.length === 0
        ? <p className="routing-order-note">{t('ro.empty')}</p>
        : <div className="routing-order-cards">{groups.map(([provider, accounts]) => (
          <ProviderOrderCard key={provider} provider={provider} accounts={accounts} quotas={quotas} state={state} now={now}
            recentByKey={recentByKey} focus={focus} disabled={disabled}
            onSaved={(undo) => {
              setState(readRoutingState());
              reload();
              notice.showNotice({ key: 'ro.saved' }, 'success', undo ? {
                action: { label: { key: 'common.undo' }, onAction: () => void undoProviderRouting(provider).then(() => {
                  setState(readRoutingState()); reload(); notice.showNotice({ key: 'ro.undone' }, 'success');
                }) },
              } : undefined);
            }}
            onError={(error) => notice.showNotice(t('ro.error', { error: readableError(error) }), 'error')}
            onFocus={() => { setFocus(readAccountFocus()); reload(); }}
          />
        ))}</div>}
    </div>
  );
}

function ProviderOrderCard({ provider, accounts, quotas, state, now, recentByKey, focus, disabled, onSaved, onError, onFocus }: {
  provider: string; accounts: AuthFile[]; quotas: ReturnType<typeof useQuotaCache>; state: RoutingState; now: number;
  recentByKey: Record<string, number>; focus: ReturnType<typeof readAccountFocus>; disabled?: boolean;
  onSaved: (undo: boolean) => void; onError: (error: unknown) => void; onFocus: () => void;
}) {
  const { t, locale } = useI18n();
  const saved = useMemo(() => providerPlan(provider, accounts, quotas, now, state), [provider, accounts, quotas, now, state]);
  const savedDraft = useMemo(() => draftFor(saved, state), [saved, state]);
  const [draft, setDraft] = useState<Draft>(savedDraft);
  const [busy, setBusy] = useState(false);
  const [rulesOpen, setRulesOpen] = useState<string | null>(null);
  const dirty = !sameDraft(draft, savedDraft);
  // A saved change, an undo or Smart reordering arrives as a new saved draft: take it unless you were mid-edit, that
  // is unless your draft had already moved away from the previous saved one.
  const previousSaved = useRef(savedDraft);
  useEffect(() => {
    setDraft(current => sameDraft(current, previousSaved.current) ? savedDraft : current);
    previousSaved.current = savedDraft;
  }, [savedDraft]);

  const keys = useMemo(() => accounts.map(quotaKey), [accounts]);
  const plan = useMemo(() => dirty ? providerPlan(provider, accounts, quotas, now, stateWith(state, provider, draft, keys)) : saved,
    [dirty, provider, accounts, quotas, now, state, draft, keys, saved]);
  const labels = useMemo(() => new Map(accounts.map(file => [quotaKey(file), labelFor(file)])), [accounts]);
  const name = providerNames[provider] ?? provider;
  const manual = draft.mode === 'manual';

  const setOrder = (order: string[]) => setDraft(current => ({ ...current, order }));
  const shown = plan.entries.map(entry => entry.key);
  const move = (key: string, step: -1 | 1) => {
    const index = shown.indexOf(key);
    const target = index + step;
    if (target < 0 || target >= shown.length) return;
    setOrder(arrayMove(shown, index, target));
  };
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setOrder(arrayMove(shown, shown.indexOf(String(active.id)), shown.indexOf(String(over.id))));
  };
  const toggleReserve = (key: string) => setDraft(current => ({
    ...current,
    order: shown,
    reserve: current.reserve.includes(key) ? current.reserve.filter(item => item !== key) : [...current.reserve, key],
  }));
  const setRule = (key: string, rule: AccountRule) => setDraft(current => {
    const rules = { ...current.rules };
    if (!rule.keepPercent && !rule.hours) delete rules[key]; else rules[key] = rule;
    return { ...current, order: shown, rules };
  });

  const save = async () => {
    setBusy(true);
    try {
      const order = shown;
      await saveProviderRouting(provider, {
        provider: { mode: draft.mode, order },
        reserve: [...state.reserve.filter(key => !keys.includes(key)), ...draft.reserve],
        rules: stateWith(state, provider, draft, keys).rules,
      }, shown);
      onSaved(true);
    } catch (error) { onError(error); }
    finally { setBusy(false); }
  };
  const useFirst = async (file: AuthFile) => {
    setBusy(true);
    try { await startAccountFocus(file); onFocus(); } catch (error) { onError(error); } finally { setBusy(false); }
  };

  const next = plan.next;
  const nextText = !next ? t('ro.next.none', { provider: name })
    : t(next.role === 'reserve' ? 'ro.next.reserve' : next.role === 'held' ? 'ro.next.held' : plan.mode === 'smart' ? 'ro.next.smart' : 'ro.next.order', { account: labels.get(next.key) ?? next.name });
  const mismatch = dirty ? null : orderMismatch(plan, recentByKey);
  const mismatchEntry = mismatch && plan.entries.find(entry => entry.key === mismatch.key);
  const history = state.history.filter(entry => entry.provider === provider).slice(-4).reverse();
  const firstReserve = plan.entries.findIndex(entry => entry.role === 'reserve');

  return (
    <section className="routing-order-card" aria-labelledby={`routing-order-${provider}`}>
      <header className="routing-order-card-head">
        <h4 id={`routing-order-${provider}`}>{name}</h4>
        <div className="routing-order-mode" role="group" aria-label={t('ro.mode.label', { provider: name })}>
          {(['manual', 'smart'] as const).map(mode => (
            <button key={mode} type="button" aria-pressed={draft.mode === mode} className={draft.mode === mode ? 'active' : ''} disabled={disabled || busy}
              title={t(mode === 'manual' ? 'ro.mode.manualHint' : 'ro.mode.smartHint')}
              onClick={() => setDraft(current => ({ ...current, mode, order: shown }))}>
              {t(mode === 'manual' ? 'ro.mode.manual' : 'ro.mode.smart')}
            </button>
          ))}
        </div>
      </header>
      <p className={`routing-order-next${next ? '' : ' none'}`} role="status">{nextText}</p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={shown} strategy={verticalListSortingStrategy}>
          <ol className="routing-order-list">
            {plan.entries.map((entry, index) => (
              <OrderRow key={entry.key} entry={entry} index={index} count={plan.entries.length}
                label={labels.get(entry.key) ?? entry.name} manual={manual} disabled={disabled || busy}
                divider={index === firstReserve && index > 0} now={now} locale={locale}
                reserved={draft.reserve.includes(entry.key)} rule={draft.rules[entry.key] ?? {}}
                rulesOpen={rulesOpen === entry.key} onRules={() => setRulesOpen(open => open === entry.key ? null : entry.key)}
                onMove={step => move(entry.key, step)} onReserve={() => toggleReserve(entry.key)} onRule={rule => setRule(entry.key, rule)}
                focusUntil={focus && focus.name === entry.name && focus.until > now ? focus.until : null}
                onUseFirst={() => void useFirst(entry.file)} />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      {!manual && <p className="routing-order-note">{t('ro.smartLocked')}</p>}
      {mismatch && mismatchEntry && <p className="routing-order-warning" role="note">{t('ro.mismatch', {
        account: labels.get(mismatch.key) ?? mismatchEntry.name, role: t(`ro.role.${mismatchEntry.role}`).toLowerCase(),
        served: mismatch.served, total: mismatch.total, provider: name,
      })}</p>}
      {dirty && <div className="routing-order-save" role="region" aria-label={t('ro.save')}>
        <span>{next ? t('ro.unsaved', { account: labels.get(next.key) ?? next.name }) : t('ro.unsavedNone')}</span>
        <button type="button" className="secondary-button compact-button" disabled={busy} onClick={() => setDraft(savedDraft)}>{t('ro.discard')}</button>
        <button type="button" className="primary-button compact-button" disabled={busy || disabled} onClick={() => void save()}>{t('ro.save')}</button>
      </div>}
      {history.length > 0 && <details className="routing-order-history">
        <summary>{t('ro.history')}</summary>
        <ul>{history.map(entry => <li key={`${entry.at}-${entry.by}`}>
          <time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
          <strong>{t(entry.by === 'you' ? 'ro.history.you' : 'ro.history.smart')}</strong>
          <span>{entry.order.map(key => labels.get(key) ?? key.split('::')[0]).join(' → ')}</span>
        </li>)}</ul>
      </details>}
    </section>
  );
}

function OrderRow({ entry, index, count, label, manual, disabled, divider, now, locale, reserved, rule, rulesOpen, onRules, onMove, onReserve, onRule, focusUntil, onUseFirst }: {
  entry: OrderEntry; index: number; count: number; label: string; manual: boolean; disabled?: boolean; divider: boolean;
  now: number; locale: string; reserved: boolean; rule: AccountRule; rulesOpen: boolean; onRules: () => void;
  onMove: (step: -1 | 1) => void; onReserve: () => void; onRule: (rule: AccountRule) => void;
  focusUntil: number | null; onUseFirst: () => void;
}) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: entry.key, disabled: !manual || disabled });
  const style: CSSProperties = { transform: DndCss.Transform.toString(transform), transition, zIndex: isDragging ? 2 : undefined };
  const reason = entry.reason === 'low' || entry.reason === 'out' || entry.reason === 'unchecked' ? t(`ro.reason.${entry.reason}`)
    : entry.reason === 'floor' ? t('ro.reason.floor', { percent: rule.keepPercent ?? 0 })
      : entry.reason === 'hours' && rule.hours ? t('ro.reason.hours', { from: hourLabel(rule.hours.from), to: hourLabel(rule.hours.to) }) : '';
  const reset = entry.resetAt ? resetCountdown(entry.resetAt, now) : '';
  const rulesId = `routing-rules-${entry.key.replace(/[^a-z0-9]/gi, '-')}`;
  return (
    <>
      {divider && <li className="routing-order-divider" aria-hidden="true"><span>{t('ro.reserveDivider')}</span></li>}
      <li ref={setNodeRef} style={style} className={`routing-order-row role-${entry.role} tier-${entry.tier ?? 'unknown'}${isDragging ? ' dragging' : ''}`}>
        <div className="routing-order-main">
          {manual
            ? <button type="button" className="icon-button quiet routing-order-handle" disabled={disabled} aria-label={t('ro.drag', { account: label })} title={t('ro.drag', { account: label })} {...attributes} {...listeners}>
              <GripVertical size={16} aria-hidden="true" />
            </button>
            : <span className="routing-order-handle placeholder" aria-hidden="true" />}
          <span className="routing-order-position" aria-hidden="true">{index + 1}</span>
          <span className="routing-order-name">
            <strong>{label}</strong>
            <small>
              <span className={`routing-order-role role-${entry.role}`}>{t(`ro.role.${entry.role}`)}</span>
              {reason && <span className={`routing-order-reason reason-${entry.reason}`}>{reason}</span>}
              {entry.percent !== null && <span>{t('ro.left', { percent: Math.round(entry.percent) })}</span>}
              {reset && <span>{t('ro.resets', { time: reset })}</span>}
              {focusUntil && <span className="routing-order-focus">{t('ro.usingFirst', { time: new Date(focusUntil).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) })}</span>}
            </small>
          </span>
          <span className="routing-order-actions">
            {manual && <>
              <button type="button" className="icon-button quiet" disabled={disabled || index === 0} aria-label={t('ro.moveUp', { account: label })} title={t('ro.moveUp', { account: label })} onClick={() => onMove(-1)}><ArrowUp size={15} aria-hidden="true" /></button>
              <button type="button" className="icon-button quiet" disabled={disabled || index === count - 1} aria-label={t('ro.moveDown', { account: label })} title={t('ro.moveDown', { account: label })} onClick={() => onMove(1)}><ArrowDown size={15} aria-hidden="true" /></button>
            </>}
            <button type="button" className="routing-order-reserve" aria-pressed={reserved} disabled={disabled}
              title={t('ro.reserveHint', { account: label })} aria-label={t('ro.reserveHint', { account: label })} onClick={onReserve}>{t('ro.reserve')}</button>
            <button type="button" className="icon-button quiet" aria-expanded={rulesOpen} aria-controls={rulesId}
              aria-label={t('ro.rulesFor', { account: label })} title={t('ro.rulesFor', { account: label })} onClick={onRules}>
              <SlidersHorizontal size={15} aria-hidden="true" />
            </button>
          </span>
        </div>
        {rulesOpen && <div id={rulesId} className="routing-order-rules" role="group" aria-label={t('ro.rulesFor', { account: label })}>
          <label>{t('ro.rules.keep')}
            <select value={rule.keepPercent ?? 0} disabled={disabled} onChange={event => onRule({ ...rule, keepPercent: Number(event.currentTarget.value) || undefined })}>
              {KEEP_OPTIONS.map(value => <option key={value} value={value}>{value ? `${value}%` : t('ro.rules.keepNone')}</option>)}
            </select>
          </label>
          <span className="routing-order-hours">{t('ro.rules.hours')}
            <select aria-label={t('ro.rules.hours')} value={rule.hours ? rule.hours.from : -1} disabled={disabled}
              onChange={event => { const from = Number(event.currentTarget.value); onRule({ ...rule, hours: from < 0 ? undefined : { from, to: rule.hours?.to ?? (from + 8) % 24 } }); }}>
              <option value={-1}>{t('ro.rules.anyTime')}</option>
              {HOURS.map(hour => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
            </select>
            {rule.hours && <>{t('ro.rules.and')}
              <select aria-label={t('ro.rules.and')} value={rule.hours.to} disabled={disabled} onChange={event => onRule({ ...rule, hours: { from: rule.hours!.from, to: Number(event.currentTarget.value) } })}>
                {HOURS.map(hour => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
              </select></>}
          </span>
          <button type="button" className="secondary-button compact-button" disabled={disabled || Boolean(focusUntil)} onClick={onUseFirst}>{t('ro.useFirst')}</button>
        </div>}
      </li>
    </>
  );
}

