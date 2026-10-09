import { AlternativeComparison, RecoveryTimeline, OverviewAlerts } from './OverviewInsights';
import { subscribeActivity } from '../services/activitySubscription';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Activity, ArrowDownWideNarrow, ChevronDown, MoreHorizontal, RefreshCw } from 'lucide-react';
import { useI18n } from '../i18n';
import { accountSummary, nextAccountReset, resetCountdown } from '../services/accountDashboard';
import { dedupeAuthFiles, normalizeAuthFilePriorityInput } from '../services/authFiles';
import { managementApi, responseList, readString } from '../services/managementApi';
import { useQuotaCache } from '../services/quotaCache';
import { refreshDashboardQuotas } from '../services/accountDashboardRefresh';
import { fileName, idleQuota, providerForFile, quotaKey, type AuthFile, type QuotaRow, type QuotaState } from '../services/quotaService';
import { useQuotaClock } from '../services/quotaTime';
import { ledgerWindows, orderedQuotaRows, primaryQuotaRow, quotaTone, remaining } from '../services/quotaLedger';
import { quotaAvailability, quotaPercent } from '../services/quotaAvailability';
import { QuotaAvailabilityNotice } from './QuotaAvailabilityNotice';
import { QuotaProviderSummary } from './QuotaProviderSummary';
import { readDashboardPreference, saveDashboardPreference } from '../services/dashboardPreferences';
import { readAccountNames, saveAccountNames } from '../services/accountNames';
import { privateAccountLabel } from '../services/accountPrivacy';
import { ProviderLogo, SignInAgainButton, needsSignIn } from './AuthFileProviderIcon';
import { loadPlanBlocks, withPlanBlocks } from '../services/planBlock';
import { accountRequests, loadDashboardActivity, requestClient, successfulRequest, privateText, type DashboardActivity, type DashboardRequest } from '../services/dashboardActivity';
import './AccountDashboard.css';

type Routing = { routingStrategy: string; routingSessionAffinity: boolean };
const providerNames: Record<string, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', xai: 'Grok', kimi: 'Kimi', devin: 'Devin', gemini: 'Gemini' };
const providers = ['claude', 'antigravity', 'codex', 'xai', 'kimi'];
const dashboardProvider = (file: AuthFile) => providerForFile(file) ?? (readString(file, 'provider', 'type') || 'other').toLowerCase();
// Problems sort first so the accounts that need a decision are at the top of each provider.
const attentionRank: Record<string, number> = { exhausted: 0, unavailable: 0, limited: 0, resetDue: 0, unknown: 1, creditBacked: 2, available: 3, disabled: 4 };
const problemKinds = ['exhausted', 'unavailable', 'limited', 'resetDue'];
// Above this many accounts the search, state filter and provider chips are worth their space.
const TOOLBAR_THRESHOLD = 8;

export type AccountStatusSummary = { total: number; available: number; problems: number; unconfirmed: number; latestAt?: string };

export function AccountDashboard({ ready, onSummary }: { ready: boolean; onSummary?: (summary: AccountStatusSummary) => void }) {
  const { t } = useI18n();
  const [files, setFiles] = useState<AuthFile[]>([]);
  const [names, setNames] = useState(readAccountNames);
  const [alternatives, setAlternatives] = useState(false);
  const [routing, setRouting] = useState<Routing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<number>();
  const [sort, setSort] = useState(() => readDashboardPreference('quotaSort', ['priority', 'reset', 'recovery'] as const, 'priority'));
  const [filter, setFilter] = useState(() => readDashboardPreference('quotaProvider', ['all', ...providers, 'devin', 'gemini', 'other'], 'all'));
  const [layout, setLayout] = useState(() => readDashboardPreference('quotaLayout', ['ledger', 'compact'] as const, 'compact'));
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState(() => readDashboardPreference('quotaState', ['all', 'available', 'attention'] as const, 'all'));
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const [hideEmails, setHideEmails] = useState(() => readDashboardPreference('hideEmails', ['true', 'false'], 'false') === 'true');
  const [showHealthy, setShowHealthy] = useState(() => readDashboardPreference('showHealthy', ['true', 'false'], 'false') === 'true');
  const [activity, setActivity] = useState<DashboardActivity | null>(null);
  const [activityError, setActivityError] = useState(false);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const lastAttempt = useRef<Record<string, number>>({});
  const planBlocks = useRef<Record<string, string>>({});
  const quotas = useQuotaCache();
  const now = useQuotaClock();

  const refresh = useCallback(async (force = false) => {
    if (!ready || busy.current) return;
    busy.current = true;
    setLoading(true);
    setError('');
    try {
      const [payload, settings] = await Promise.all([
        managementApi.get('/credentials'),
        invoke<Routing>('get_core_config_settings'),
      ]);
      const next = dedupeAuthFiles(responseList(payload, 'files'));
      if (!mounted.current || !readyRef.current) return;
      setFiles(withPlanBlocks(next, planBlocks.current));
      setRouting(settings);
      setUpdatedAt(Date.now());
      await Promise.all([
        refreshDashboardQuotas(next.filter((file) => providerForFile(file)), force, lastAttempt.current, () => mounted.current && readyRef.current),
        loadPlanBlocks(next).then((blocks) => {
          planBlocks.current = blocks;
          if (mounted.current && readyRef.current) setFiles(withPlanBlocks(next, blocks));
        }).catch(() => undefined),
        loadDashboardActivity().then((result) => { if (mounted.current && readyRef.current) { setActivity(result); setActivityError(false); } }).catch(() => { if (mounted.current) setActivityError(true); }),
      ]);
    } catch {
      setError(t('accountDashboard.refreshError'));
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [ready, t]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 30_000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    if (!ready) return;
    let active = true;
    const subscription = subscribeActivity(async () => {
      try { const result = await loadDashboardActivity(); if (active) { setActivity(result); setActivityError(false); } }
      catch { if (active) setActivityError(true); }
    });
    return () => { active = false; subscription.dispose(); };
  }, [ready]);

  const savePriority = async (file: AuthFile, priority: number) => {
    // Polls and writes share one lock so a late snapshot cannot undo a saved priority.
    if (busy.current) throw new Error('Account refresh in progress');
    busy.current = true;
    setSaving(true);
    try {
      await managementApi.patch('/credentials/fields', { name: fileName(file), priority });
      setFiles((current) => current.map((item) => quotaKey(item) === quotaKey(file) ? { ...item, priority } : item));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  const refreshAccount = async (file: AuthFile) => {
    if (!readyRef.current || busy.current || !providerForFile(file)) return;
    busy.current = true;
    setRefreshingKey(quotaKey(file));
    try {
      await refreshDashboardQuotas([file], true, lastAttempt.current, () => mounted.current && readyRef.current);
    } finally {
      busy.current = false;
      if (mounted.current) setRefreshingKey(null);
    }
  };

  const stale = !ready || Boolean(error);
  const kindOf = (file: AuthFile) => quotaAvailability(file, quotas[quotaKey(file)], now, stale).kind;
  const kinds = files.map(kindOf);
  const summaryCounts: AccountStatusSummary = {
    total: files.length,
    available: kinds.filter((kind) => kind === 'available' || kind === 'creditBacked').length,
    problems: kinds.filter((kind) => problemKinds.includes(kind)).length,
    unconfirmed: kinds.filter((kind) => kind === 'unknown').length,
    latestAt: activity?.latest?.timestamp,
  };
  const summaryKey = JSON.stringify(summaryCounts);
  useEffect(() => { onSummary?.(JSON.parse(summaryKey) as AccountStatusSummary); }, [summaryKey, onSummary]);

  const sorted = [...files].sort((a, b) => {
    if (sort === 'priority') {
      const delta = (attentionRank[kindOf(a)] ?? 1) - (attentionRank[kindOf(b)] ?? 1);
      if (delta) return delta;
    }
    if (sort === 'recovery') {
      const delta = (quotaAvailability(a, quotas[quotaKey(a)], now, !ready || Boolean(error)).recoveryAt ?? Infinity)
        - (quotaAvailability(b, quotas[quotaKey(b)], now, !ready || Boolean(error)).recoveryAt ?? Infinity);
      if (delta && !Number.isNaN(delta)) return delta;
    }
    if (sort === 'reset') {
      const delta = (nextAccountReset(quotas[quotaKey(a)], now) ?? Infinity)
        - (nextAccountReset(quotas[quotaKey(b)], now) ?? Infinity);
      if (delta && !Number.isNaN(delta)) return delta;
    }
    return accountSummary(b).priority - accountSummary(a).priority
      || accountSummary(a).label.localeCompare(accountSummary(b).label);
  });
  const visible = sorted.filter((file) => {
    const state = quotaAvailability(file, quotas[quotaKey(file)], now, !ready || Boolean(error));
    const query = search.trim().toLowerCase();
    return (filter === 'all' || dashboardProvider(file) === filter)
      && (!query || (hideEmails ? privateAccountLabel(file, dashboardProvider(file)) : `${names[privateAccountLabel(file, dashboardProvider(file))] ?? ''} ${fileName(file)} ${accountSummary(file).label} ${dashboardProvider(file)}`).toLowerCase().includes(query))
      && (stateFilter === 'all' || (stateFilter === 'available' ? state.kind === 'available' : state.kind !== 'available' && state.kind !== 'disabled'));
  });
  const latest = activity?.latest;
  const latestFile = latest ? files.find((file) => accountRequests(file, [latest]).length) : undefined;
  const labelFor = (file: AuthFile) => hideEmails ? privateAccountLabel(file, dashboardProvider(file)) : names[privateAccountLabel(file, dashboardProvider(file))] || fileName(file) || accountSummary(file).label;
  const saveName = (file: AuthFile, value: string) => {
    const key = privateAccountLabel(file, dashboardProvider(file));
    const next = { ...names };
    if (value.trim()) next[key] = value.trim().slice(0, 80); else delete next[key];
    if (!saveAccountNames(next)) return false;
    setNames(next); return true;
  };
  const viewAlternatives = (_file: AuthFile) => { setAlternatives(true); };
  const providerList = [...providers, ...[...new Set(files.map(dashboardProvider))].filter((provider) => !providers.includes(provider))];
  const filtered = filter !== 'all' || stateFilter !== 'all' || search.trim() !== '';
  const showToolbar = files.length > TOOLBAR_THRESHOLD || filtered;
  const collapseHealthy = !showHealthy && !filtered;
  const healthyCount = visible.filter((file) => kindOf(file) === 'available').length;
  const cardFiles = collapseHealthy ? visible.filter((file) => kindOf(file) !== 'available') : visible;
  const toggleHealthy = (value: boolean) => { setShowHealthy(value); saveDashboardPreference('showHealthy', String(value)); };
  const clearFilters = () => {
    setAlternatives(false);
    setFilter('all'); setStateFilter('all'); setSearch('');
    saveDashboardPreference('quotaProvider', 'all'); saveDashboardPreference('quotaState', 'all');
  };

  return <section className={`account-dashboard quota-ledger quota-layout-${layout}`} aria-labelledby="account-dashboard-title">
    <div className="ad-heading">
      <div><h2 id="account-dashboard-title">{t('accountDashboard.title')}</h2>
        <p className="quota-load-status"><span className={`ad-dot ${ready ? 'online' : ''}`} />{t('quotaLedger.credentials', { count: files.length })}<span aria-hidden="true">·</span><span className="quota-loaded">{loading ? t('accountDashboard.refreshing') : ready ? t('quotaLedger.loaded', { count: files.filter(file => quotas[quotaKey(file)]?.status === 'success').length }) : t('accountDashboard.offline')}</span></p></div>
      <div className="quota-heading-actions">{summaryCounts.problems > 0 && <button type="button" className="secondary-button quota-compare" onClick={() => setAlternatives(value => !value)} aria-expanded={alternatives}>{t('ux.alternatives')}</button>}<label className="ledger-privacy"><input type="checkbox" checked={hideEmails} onChange={(event) => { setHideEmails(event.target.checked); if (event.target.checked) setSearch(''); saveDashboardPreference('hideEmails', String(event.target.checked)); }} />{t('ledger.hideEmails')}</label>
      <button className="secondary-button quota-refresh" disabled={!ready || loading || saving || refreshingKey !== null} onClick={() => void refresh(true)}>
        <RefreshCw size={16} aria-hidden="true" /> {loading ? t('accountDashboard.refreshing') : t('accountDashboard.refresh')}
      </button></div>
    </div>
    {!ready ? <p className="ad-notice">{t('accountDashboard.start')}</p> : null}
    {error ? <p role="alert" className="ad-notice ad-error">{error} {t('accountDashboard.staleWarning')}</p> : null}
    {ready && !loading && !error && !files.length ? <p className="ad-notice">{t('accountDashboard.empty')}</p> : null}
    {showToolbar && <><div className="ledger-filters">
      <div className="ledger-provider-filters" role="group" aria-label={t('ledger.providers')}>
        {['all', ...providerList].map((provider) =>
          <button type="button" key={provider} aria-pressed={filter === provider} onClick={() => { setFilter(provider); saveDashboardPreference('quotaProvider', provider); }}>
            <ProviderLogo provider={provider} />{provider === 'all' ? t('ledger.all') : providerNames[provider] ?? t('ledger.other')} <span>{provider === 'all' ? files.length : files.filter((file) => dashboardProvider(file) === provider).length}</span>
          </button>)}
      </div>
      <select className="quota-layout-select" aria-label={t('quotaLedger.layout')} value={layout} onChange={event => { const value = event.target.value as 'ledger' | 'compact'; setLayout(value); saveDashboardPreference('quotaLayout', value); }}>
        <option value="ledger">{t('quotaLedger.ledger')}</option><option value="compact">{t('quotaLedger.compact')}</option>
      </select>
    </div>
    <div className="quota-workflow-tools"><input type="search" aria-label={t('availability.search')} placeholder={t('availability.search')} value={search} onChange={event => setSearch(event.target.value)} /><select aria-label={t('availability.all')} value={stateFilter} onChange={event => { const value = event.target.value as typeof stateFilter; setStateFilter(value); saveDashboardPreference('quotaState', value); }}><option value="all">{t('availability.all')}</option><option value="available">{t('availability.known')}</option><option value="attention">{t('availability.attention')}</option></select><span className="quota-result-count" role="status">{t('availability.results', { shown: visible.length, total: files.length })}</span>{filtered && <button type="button" className="secondary-button compact-button" onClick={clearFilters}>{t('availability.clearFilters')}</button>}</div></>}
    <div className="quota-provider-summary">
      {providerList.filter((provider) => files.some((file) => dashboardProvider(file) === provider)).map((provider) => {
        const accounts = files.filter((file) => dashboardProvider(file) === provider);
        return <QuotaProviderSummary key={provider} accounts={accounts} quotas={quotas} name={providerNames[provider] ?? provider} icon={<ProviderLogo provider={provider} />} now={now} stale={stale} labelFor={labelFor} />;
      })}
    </div>
    {alternatives && summaryCounts.problems > 0 && <AlternativeComparison files={files} quotas={quotas} now={now} stale={stale} labelFor={labelFor} onClose={() => setAlternatives(false)} />}
    {healthyCount > 0 && <div className="ad-healthy-toggle" role="status">
      <span>{t(collapseHealthy ? 'home.accounts.healthyHidden' : 'home.accounts.healthyShown', { count: healthyCount })}</span>
      {!filtered && <button type="button" className="secondary-button compact-button" aria-expanded={!collapseHealthy} onClick={() => toggleHealthy(collapseHealthy)}>{t(collapseHealthy ? 'home.accounts.showHealthy' : 'home.accounts.hideHealthy')}</button>}
    </div>}
    <div className="ad-accounts">
      {providerList.map((provider) => {
        const group = cardFiles.filter((file) => dashboardProvider(file) === provider);
        const columns = ledgerWindows(group, quotas).slice(0, 3);
        return group.length > 0 ? <section className="quota-account-group" key={provider} aria-label={providerNames[provider] ?? provider}>
      <h3 className="quota-group-heading"><ProviderLogo provider={provider} />{providerNames[provider] ?? provider}<span>{group.length}</span></h3>
      {group.map((file) => <AccountCard key={quotaKey(file)} file={file} quota={quotas[quotaKey(file)] ?? idleQuota()} now={now}
        label={labelFor(file)} hideEmails={hideEmails} requests={activity ? accountRequests(file, activity.items) : undefined} activityStale={activityError || stale}
        friendlyName={names[privateAccountLabel(file, dashboardProvider(file))] ?? ''} onName={saveName} onAlternatives={viewAlternatives}
        columns={columns} layout={layout}
        disabled={!ready || saving || loading || refreshingKey !== null || Boolean(error)} onSave={savePriority} onRefresh={refreshAccount} refreshing={refreshingKey === quotaKey(file)} stale={stale} />)}
      </section> : null; })}
      {!visible.length && files.length > 0 && <div className="quota-no-results" role="status"><span>{t('availability.noMatches')}</span>{filtered && <button type="button" className="secondary-button compact-button" onClick={clearFilters}>{t('availability.clearFilters')}</button>}</div>}
    </div>
    <RecoveryTimeline files={files} quotas={quotas} now={now} stale={stale} labelFor={labelFor} />
    <OverviewAlerts key={String(hideEmails)} files={files} quotas={quotas} now={now} stale={stale} labelFor={labelFor} items={activity?.items} activityStale={activityError || stale} />
    <details className="quota-ledger-notes"><summary>{t('quotaLedger.notes')}</summary><div className="ad-toolbar">
      <div className="ad-routing"><span className={`ad-dot ${ready ? 'online' : ''}`} />{ready ? t('accountDashboard.online') : t('accountDashboard.offline')}
        <span>{t('accountDashboard.routing', { strategy: routing?.routingStrategy ?? '—' })}</span>
        <span>{t('accountDashboard.affinity', { state: routing ? routing.routingSessionAffinity ? t('accountDashboard.on') : t('accountDashboard.off') : '—' })}</span></div>
      <label className="ad-sort"><ArrowDownWideNarrow size={14} aria-hidden="true" /><span>{t('accountDashboard.sort')}</span>
        <select aria-label={t('accountDashboard.sort')} value={sort} onChange={(event) => { setSort(event.target.value as typeof sort); saveDashboardPreference('quotaSort', event.target.value); }}><option value="priority">{t('accountDashboard.prioritySort')}</option><option value="reset">{t('accountDashboard.resetSort')}</option><option value="recovery">{t('availability.recovery')}</option></select>
      </label>
    </div>
    <p className="ledger-snapshot">{t('ledger.snapshot', { count: activity?.items.length ?? 0 })}{activity ? ` · ${t('accountDashboard.checked', { time: new Date(activity.checkedAt).toLocaleTimeString() })}` : ''}</p>
    <div className="ad-footnote"><span>{updatedAt ? t('accountDashboard.checked', { time: new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : t('accountDashboard.loading')} · {t('accountDashboard.cadence')}</span>
      <span>{t('accountDashboard.routingHint')}</span></div>
    <section className="ledger-evidence" aria-label={t('ledger.latest')} title={t('ledger.evidenceHint')}>
      <span className="ledger-evidence-label"><Activity size={16} aria-hidden="true" />{t('ledger.latest')}</span>
      {latest ? <><strong>{requestClient(latest) ?? t('ledger.unknownClient')} <span aria-hidden="true">→</span> {latestFile ? labelFor(latestFile) : t('ledger.unmatched')}</strong>
        <span>{privateText(latest.model, hideEmails)} · <time dateTime={latest.timestamp}>{new Date(latest.timestamp).toLocaleString()}</time></span></>
        : <strong>{activity ? t('ledger.noSuccess') : t('ledger.waiting')}</strong>}
      {(!ready || activityError || Boolean(error)) && <span role="status">{t('ledger.stale')}</span>}
    </section>
    </details>
  </section>;
}


type MenuItem = { key: string; label: string; onSelect: () => void; disabled?: boolean; movesFocus?: boolean };

/** Small accessible popover menu: arrow keys move, Escape or a click outside closes, focus returns to the trigger. */
function AccountMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);
  const close = (restoreFocus = true) => { setOpen(false); if (restoreFocus) buttonRef.current?.focus(); };
  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const enabled = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const move = (next: number) => { event.preventDefault(); enabled[(next + enabled.length) % enabled.length]?.focus(); };
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(enabled.length - 1);
    else if (event.key === 'Tab') setOpen(false);
  };
  return <div className="ad-menu">
    <button ref={buttonRef} type="button" className="ad-menu-button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      aria-label={label} title={label} onClick={() => setOpen(value => !value)}
      onKeyDown={event => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true); } }}>
      <MoreHorizontal size={16} aria-hidden="true" />
    </button>
    {open && <div ref={menuRef} id={menuId} role="menu" aria-label={label} className="ad-menu-popover" onKeyDown={onMenuKey}>
      {items.map(item => <button key={item.key} type="button" role="menuitem" tabIndex={-1} disabled={item.disabled}
        onClick={() => { close(!item.movesFocus); item.onSelect(); }}>{item.label}</button>)}
    </div>}
  </div>;
}

export function AccountCard({ file, quota, now, disabled, stale = false, onSave, onRefresh, refreshing = false, columns, label, hideEmails = false, requests, activityStale = false, friendlyName = '', onName, onAlternatives, layout = 'compact' }: {
  friendlyName?: string; onName?: (file: AuthFile, value: string) => boolean; onAlternatives?: (file: AuthFile) => void;
  columns?: string[]; refreshing?: boolean; onRefresh?: (file: AuthFile) => Promise<void>;
  label?: string; hideEmails?: boolean; requests?: DashboardRequest[]; activityStale?: boolean;
  file: AuthFile; quota: QuotaState; now: number; disabled: boolean; stale?: boolean; layout?: 'compact' | 'ledger';
  onSave: (file: AuthFile, priority: number) => Promise<void>;
}) {
  const { t } = useI18n();
  const summary = accountSummary(file);
  const provider = dashboardProvider(file);
  const displayLabel = label ?? accountSummary(file).label;
  const lastSuccess = requests?.find(successfulRequest);
  const successCount = requests?.filter(successfulRequest).length ?? 0;
  const failureCount = requests?.filter((request) => request.failed && !request.canceled).length ?? 0;
  const canceledCount = requests?.filter((request) => request.canceled).length ?? 0;
  const [draft, setDraft] = useState(String(summary.priority));
  const [nameDraft, setNameDraft] = useState(friendlyName);
  const [nameFeedback, setNameFeedback] = useState('');
  useEffect(() => { setNameDraft(friendlyName); }, [friendlyName]);
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [focusTarget, setFocusTarget] = useState<'name' | 'priority' | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const priorityInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!detailsOpen || !focusTarget) return;
    const input = focusTarget === 'name' ? nameInput.current : priorityInput.current;
    input?.focus(); input?.select();
    setFocusTarget(null);
  }, [detailsOpen, focusTarget]);
  const availability = quotaAvailability(file, quota, now, stale);
  // Compact rows show one window per account, so don't pad them with other accounts' columns.
  const orderedRows = orderedQuotaRows(quota.rows, layout === 'ledger' ? columns : undefined);
  // The face shows the window that decides availability: a blocker if any, otherwise the lowest remaining.
  const primary = primaryQuotaRow(orderedRows, availability.blockers);
  const faceRows = layout === 'ledger'
    ? [...(primary ? [primary] : []), ...orderedRows.filter(row => row !== primary)].slice(0, 3)
    : primary ? [primary] : [];
  const detailRows = orderedRows.filter(row => !faceRows.includes(row));
  const signIn = needsSignIn(file);
  const providerLabel = providerNames[provider ?? ''] ?? t('ledger.other');
  useEffect(() => { setDraft(String(summary.priority)); }, [summary.priority]);
  const save = async () => {
    const priority = normalizeAuthFilePriorityInput(draft);
    if (priority === null) { setFeedback(t('accountDashboard.invalidPriority')); return; }
    setPending(true); setFeedback('');
    try { await onSave(file, priority); setFeedback(t('accountDashboard.saved')); }
    catch { setFeedback(t('accountDashboard.saveError')); }
    finally { setPending(false); }
  };
  const openEditor = (target: 'name' | 'priority') => { setDetailsOpen(true); setFocusTarget(target); };
  const canRefresh = !disabled && Boolean(onRefresh) && Boolean(providerForFile(file)) && !summary.health.disabled;
  const menuItems: MenuItem[] = [
    { key: 'details', label: t(detailsOpen ? 'accountDashboard.hideDetails' : 'accountDashboard.showDetails'), onSelect: () => setDetailsOpen(value => !value) },
    ...(onName && !hideEmails ? [{ key: 'rename', label: t('accountDashboard.rename'), onSelect: () => openEditor('name'), movesFocus: true }] : []),
    { key: 'priority', label: t('accountDashboard.setPriority'), onSelect: () => openEditor('priority'), movesFocus: true },
    { key: 'refresh', label: t(refreshing ? 'accountDashboard.refreshing' : 'accountDashboard.refreshQuota'), disabled: !canRefresh, onSelect: () => void onRefresh?.(file) },
    ...(onAlternatives && ['exhausted', 'limited', 'unavailable'].includes(availability.kind) ? [{ key: 'alternatives', label: t('ux.alternatives'), onSelect: () => onAlternatives(file) }] : []),
  ];
  const renderQuota = (row: QuotaRow, index: number) => {
    const percent = remaining(row.remainingPercent);
    const overdue = row.resetAtMs !== undefined && row.resetAtMs <= now;
    const isBlocker = availability.blockers.includes(row);
    // A window can still show healthy remaining% while the account is blocked by a different, already-exhausted window (e.g. 5-hour looks fine while the 7-day cap is at zero). Don't paint that green.
    const blockedElsewhere = !isBlocker && ['exhausted', 'creditBacked', 'resetDue'].includes(availability.kind);
    const tone = isBlocker ? 'ad-critical' : blockedElsewhere ? 'ad-blocked' : ({ critical: 'ad-critical', low: 'ad-low', healthy: '', unknown: 'ad-unknown' } as const)[quotaTone(percent)];
    const notes = [
      blockedElsewhere ? t('authFiles.quota.blockedElsewhere') : '',
      row.justReset ? t('authFiles.quota.justReset') : '',
      row.detail ? privateText(row.detail, hideEmails) : '',
    ].filter(Boolean);
    // Healthy windows keep their footnotes in the tooltip so the row stays one line.
    const healthy = tone === '';
    return <div key={`${row.label}-${index}`} className={`ad-quota ${tone}`} title={healthy && notes.length ? notes.join('\n') : undefined}>
      <div className="ad-quota-title"><span>{row.label}</span><strong>{percent === null ? t('accountDashboard.unknown') : t('accountDashboard.remaining', { percent: quotaPercent(percent) })}</strong></div>
      {percent !== null ? <meter min={0} max={100} value={percent} aria-label={t('accountDashboard.meter', { label: row.label })} /> : <div className="quota-unknown-track" aria-hidden="true" />}
      <div className="ad-quota-reset">{row.resetAtMs && !overdue
        ? <time dateTime={new Date(row.resetAtMs).toISOString()} title={new Date(row.resetAtMs).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}>{t('accountDashboard.resetsIn', { time: resetCountdown(row.resetAtMs, now) })}</time>
        : <span>{overdue ? t('accountDashboard.resetDue') : row.reset || t('accountDashboard.noReset')}</span>}</div>
      {!healthy && row.justReset && <small className="ad-card-note credential-quota-just-reset">{t('authFiles.quota.justReset')}</small>}
      {!healthy && blockedElsewhere && <small className="ad-card-note">{t('authFiles.quota.blockedElsewhere')}</small>}
      {!healthy && row.detail && <small className="ad-card-note">{privateText(row.detail, hideEmails)}</small>}
    </div>;
  };
  const detailsLabel = detailRows.length ? t('accountDashboard.moreLimits', { count: detailRows.length }) : t('quotaLedger.details');
  return <article className={`ad-card ad-row-card quota-account-${availability.kind} ${stale || quota.status === 'error' ? 'quota-row-stale' : ''}`} aria-label={displayLabel}>
    <div className="ad-row">
      <ProviderLogo provider={provider} className="ad-row-logo" />
      <div className="ad-row-name"><h3 title={hideEmails ? displayLabel : `${displayLabel}\n${fileName(file)}`}>{displayLabel}</h3>
        <span className="ad-provider">{providerLabel}{quota.plan ? ` · ${quota.plan}` : ''}</span></div>
      <div className="ad-row-status">
        <QuotaAvailabilityNotice compact state={availability} now={now} />
        {stale && <span className="state-pill neutral">{t('accountDashboard.stale')}</span>}
      </div>
      <div className={`ad-quota-list ad-row-quota ad-row-quota-${faceRows.length || 1}`} aria-busy={quota.status === 'loading'}>
        {quota.status === 'error' ? <p className="ad-card-note ad-error">{t('accountDashboard.quotaError')}</p> : null}
        {/* The availability notice already explains an incomplete success; don't repeat it. */}
        {!quota.rows.length && quota.status !== 'error' && !(quota.status === 'success' && availability.uncertainty === 'incomplete') ? <p className="ad-card-note">{!providerForFile(file) ? t('ledger.unsupportedQuota') : summary.health.disabled ? t('accountDashboard.disabled') : quota.status === 'loading' ? t('accountDashboard.checking') : quota.status === 'success' ? t('accountDashboard.noLimits') : t('accountDashboard.notChecked')}</p> : null}
        {faceRows.map(renderQuota)}
      </div>
      <div className="ad-row-actions">
        {signIn && <SignInAgainButton account={displayLabel} />}
        {refreshing && <RefreshCw size={14} aria-hidden="true" className="quota-refreshing ad-row-busy" />}
        <AccountMenu label={t('accountDashboard.menu', { account: displayLabel })} items={menuItems} />
      </div>
    </div>
    <details className="personal-disclosure ad-account-details" open={detailsOpen} onToggle={event => setDetailsOpen(event.currentTarget.open)}>
      <summary title={detailsLabel}><span className="sr-only">{detailsLabel}</span>{detailRows.length > 0 && <span aria-hidden="true">+{detailRows.length}</span>}<ChevronDown size={14} aria-hidden="true" /></summary>
      <div className="ad-details-body">
        <QuotaAvailabilityNotice state={availability} now={now} />
        {detailRows.length > 0 && <div className="ad-quota-list ad-detail-quotas">{detailRows.map((row, index) => renderQuota(row, index + faceRows.length))}</div>}
        {summary.health.message && <p className="ad-card-note">{privateText(summary.health.message, hideEmails)}</p>}
        <p className="ad-card-note"><strong>{t('desk.credentialHealth')}: </strong>{stale ? t('accountDashboard.stale') : summary.health.tone === 'success' ? t('desk.active') : t(summary.health.label)} · {t('desk.healthHint')}</p>
        {!hideEmails && <p className="ad-card-note">{t('desk.filename')}: {fileName(file)}</p>}
        {onName && !hideEmails && <div className="ad-name-editor"><label>{t('desk.friendlyName')}<input ref={nameInput} maxLength={80} value={nameDraft} onChange={event => { setNameDraft(event.target.value); setNameFeedback(''); }} /></label><button type="button" className="secondary-button" disabled={nameDraft === friendlyName} onClick={() => setNameFeedback(onName(file, nameDraft) ? t('desk.nameSaved') : t('desk.nameFailed'))}>{t('desk.saveName')}</button><small>{t('desk.nameHint')}</small><span role="status">{nameFeedback}</span></div>}
        <div className="ad-card-activity">
          <strong>{requests === undefined ? t('ledger.waiting') : requests.length ? t('ledger.counts', { success: successCount, failure: failureCount }) : t('ledger.noRequests')}</strong>
          {canceledCount > 0 && <span>{t('ledger.canceled', { count: canceledCount })}</span>}
          {lastSuccess && <><span>{t('ledger.lastSuccess')}</span><time dateTime={lastSuccess.timestamp}>{new Date(lastSuccess.timestamp).toLocaleString()}</time><span>{requestClient(lastSuccess) ?? t('ledger.unknownClient')}</span></>}
          {activityStale && <span>{t('ledger.stale')}</span>}
        </div>
        <div className="ad-card-footer"><label>{t('accountDashboard.priority')}<input ref={priorityInput} type="number" step="1" value={draft} onChange={(event) => { setDraft(event.target.value); setFeedback(''); }} aria-label={t('accountDashboard.priorityLabel', { account: displayLabel })} disabled={disabled || pending} /></label>
          <button className="secondary-button" disabled={disabled || pending || draft === String(summary.priority)} onClick={() => void save()}>{pending ? t('accountDashboard.saving') : t('accountDashboard.save')}</button>
          <span className="ad-freshness">{quota.fetchedAt ? t('accountDashboard.quotaChecked', { time: new Date(quota.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : t('accountDashboard.noSnapshot')}</span></div>
        {feedback && <p role="status" className="ad-card-note">{feedback}</p>}
      </div>
    </details>
  </article>;
}
