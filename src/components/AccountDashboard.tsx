import { MessageNotice } from '../appNotice';
import { outageFor, useProviderStatus } from '../services/providerStatus';
import { QuotaTrendChart } from './QuotaTrendChart';
import { useQuotaTrends } from '../services/quotaTrend';
import { AccountStatusSection } from './AccountStatusSection';
import { AccountValueLine } from './AccountValueLine';
import { AlternativeComparison, OverviewAlerts } from './OverviewInsights';
import { subscribeActivity } from '../services/activitySubscription';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, useMemo } from 'react';
import { ChevronDown, MoreHorizontal, RefreshCw } from 'lucide-react';
import { useI18n } from '../i18n';
import { accountSummary, nextAccountReset, resetCountdown } from '../services/accountDashboard';
import { dedupeAuthFiles } from '../services/authFiles';
import { managementApi, responseList, readString } from '../services/managementApi';
import { useQuotaCache } from '../services/quotaCache';
import { refreshDashboardQuotas } from '../services/accountDashboardRefresh';
import { applyQuotaRouting } from '../services/quotaRoutingControl';
import { fileName, idleQuota, providerForFile, quotaKey, type AuthFile, type QuotaRow, type QuotaState } from '../services/quotaService';
import { useQuotaClock } from '../services/quotaTime';
import { ledgerWindows, orderedQuotaRows, primaryQuotaRow, quotaTone, remaining } from '../services/quotaLedger';
import { quotaAvailability, quotaPercent } from '../services/quotaAvailability';
import { QuotaAvailabilityNotice } from './QuotaAvailabilityNotice';
import { QuotaProviderSummary } from './QuotaProviderSummary';
import { HomeGlance, UnconfirmedLines } from './HomeGlance';
import { requestOAuthSubpage } from '../oauthNavigation';
import { ANTIGRAVITY_PAID_FALLBACK_PATH, loadAntigravityPaidFallback } from '../services/antigravityPaidFallback';
import { requestSettingField, requestSettingsCategory } from '../services/settingsNavigation';
import { readRoutingState, routingPlans, type Role } from '../services/routingOrder';
import { attentionItems, canRecheck, type AttentionSeverity } from '../services/homeGlance';
import type { HomeUsageSummary } from '../services/homeOverview';
import { readDashboardPreference, saveDashboardPreference } from '../services/dashboardPreferences';
import { readAccountNames, saveAccountNames } from '../services/accountNames';
import { accountDisplayName, privateAccountLabel } from '../services/accountPrivacy';
import { ACCOUNT_SEARCH_EVENT, takePendingAccountSearch } from '../accountNavigation';
import { Switchboard, SwitchboardHistory } from './Switchboard';
import { AccountAvatar, AccountHealthSparkline, AccountIdentityEditor, useAccountIdentity } from './AccountIdentity';
import { ProviderLogo, SignInAgainButton, needsSignIn, openSignIn } from './AuthFileProviderIcon';
import { requestAccountRequests } from '../usageNavigation';
import { loadPlanBlocks, withPlanBlocks, type PlanBlock } from '../services/planBlock';
import { accountRequests, loadDashboardActivity, requestClient, successfulRequest, privateText, type DashboardActivity, type DashboardRequest } from '../services/dashboardActivity';
import { endAccountFocus, readAccountFocus, startAccountFocus, type AccountFocus } from '../services/accountFocus';
import './AccountDashboard.css';
import { PulseOnChange } from './PulseOnChange';

const providerNames: Record<string, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', xai: 'Grok', kimi: 'Kimi', devin: 'Devin', gemini: 'Gemini' };
const providers = ['claude', 'antigravity', 'codex', 'xai', 'kimi'];
export const dashboardProvider = (file: AuthFile) => providerForFile(file) ?? (readString(file, 'provider', 'type') || 'other').toLowerCase();
// Problems sort first so the accounts that need a decision are at the top of each provider.
const attentionRank: Record<string, number> = { exhausted: 0, unavailable: 0, limited: 0, resetDue: 0, unknown: 1, creditBacked: 2, available: 3, disabled: 4 };
export type AccountStatusSummary = {
  total: number; available: number; problems: number; unconfirmed: number; latestAt?: string;
  /** The account list and recent activity have both loaded (or failed to): until then a count of 0 means not yet known. */
  loaded?: boolean;
  /** The account most likely to stop work: blocked first, then the lowest one running low. */
  worst?: { label: string; severity: AttentionSeverity; percent: number | null; resetAt?: number };
};

export function AccountDashboard({ ready, onSummary, usage = null, usageLoading = false }: {
  ready: boolean; onSummary?: (summary: AccountStatusSummary) => void; usage?: HomeUsageSummary | null; usageLoading?: boolean;
}) {
  const providerStatuses = useProviderStatus();
  const { t } = useI18n();
  const [files, setFiles] = useState<AuthFile[]>([]);
  const [names, setNames] = useState(readAccountNames);
  const [alternatives, setAlternatives] = useState(false);
  const [loading, setLoading] = useState(false);
  // Until the first list arrives, an empty list means "not loaded yet", never "no accounts".
  const [listLoaded, setListLoaded] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<number>();
  const [sort, setSort] = useState(() => readDashboardPreference('quotaSort', ['priority', 'reset', 'recovery'] as const, 'priority'));
  const [filter, setFilter] = useState(() => readDashboardPreference('quotaProvider', ['all', ...providers, 'devin', 'gemini', 'other'], 'all'));
  const [layout, setLayout] = useState(() => readDashboardPreference('quotaLayout', ['ledger', 'compact'] as const, 'compact'));
  const [groupBy, setGroupBy] = useState(() => readDashboardPreference('quotaGroupBy', ['provider', 'purpose'] as const, 'provider'));
  const { groups: accountGroups } = useAccountIdentity();
  const [search, setSearch] = useState(() => takePendingAccountSearch() ?? '');
  const [stateFilter, setStateFilter] = useState(() => readDashboardPreference('quotaState', ['all', 'available', 'attention'] as const, 'attention'));
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const [hideEmails, setHideEmails] = useState(() => readDashboardPreference('hideEmails', ['true', 'false'], 'false') === 'true');
  const [activity, setActivity] = useState<DashboardActivity | null>(null);
  const [activityError, setActivityError] = useState(false);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const planBlocks = useRef<Record<string, PlanBlock>>({});
  const quotas = useQuotaCache();
  const now = useQuotaClock();
  // Whether Antigravity spends paid credits after included quota: shown beside its quota, edited in one place.
  const [paidFallback, setPaidFallback] = useState<boolean | null>(null);
  const hasAntigravity = files.some((file) => dashboardProvider(file) === 'antigravity');
  useEffect(() => {
    if (!ready || !hasAntigravity) return;
    let active = true;
    void loadAntigravityPaidFallback().then((value) => { if (active) setPaidFallback(value); });
    return () => { active = false; };
  }, [ready, hasAntigravity]);

  const refresh = useCallback(async (force = false) => {
    if (!ready || busy.current) return;
    busy.current = true;
    setLoading(true);
    setError('');
    try {
      const payload = await managementApi.get('/credentials');
      const next = dedupeAuthFiles(responseList(payload, 'files'));
      if (!mounted.current || !readyRef.current) return;
      setFiles(withPlanBlocks(next, planBlocks.current));
      setListLoaded(true);
      setUpdatedAt(Date.now());
      await Promise.all([
        refreshDashboardQuotas(next.filter((file) => providerForFile(file)), force, () => mounted.current && readyRef.current),
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

  // The command palette can open this list searched for one account, with other filters cleared so it shows.
  useEffect(() => {
    const onSearch = () => {
      const next = takePendingAccountSearch();
      if (next === null) return;
      setSearch(next); setFilter('all'); setStateFilter('all');
    };
    window.addEventListener(ACCOUNT_SEARCH_EVENT, onSearch);
    return () => window.removeEventListener(ACCOUNT_SEARCH_EVENT, onSearch);
  }, []);

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

  // Where each account sits in its provider's routing order (Settings → Routing owns the priorities).
  const [routingState, setRoutingState] = useState(readRoutingState);
  useEffect(() => {
    const sync = () => setRoutingState(readRoutingState());
    window.addEventListener('app:routing-order', sync);
    return () => window.removeEventListener('app:routing-order', sync);
  }, []);
  const routingPositions = useMemo(() => {
    const positions = new Map<string, { position: number; total: number; role: Role; provider: string }>();
    for (const plan of routingPlans(files, quotas, now, routingState)) {
      plan.entries.forEach((entry, index) => positions.set(entry.key, { position: index + 1, total: plan.entries.length, role: entry.role, provider: plan.provider }));
    }
    return positions;
  }, [files, quotas, now, routingState]);

  const [focus, setFocus] = useState<AccountFocus | null>(() => readAccountFocus());
  const [focusError, setFocusError] = useState('');
  useEffect(() => {
    const sync = () => setFocus(readAccountFocus());
    window.addEventListener('app:account-focus', sync);
    return () => window.removeEventListener('app:account-focus', sync);
  }, []);
  /** Starts "use this account first for an hour", or ends it early when file is null. */
  const changeFocus = async (file: AuthFile | null) => {
    // A refresh holds the write lock briefly; wait for it rather than silently ignoring the click.
    for (let waited = 0; busy.current && waited < 10_000; waited += 50) await new Promise(resolve => window.setTimeout(resolve, 50));
    if (busy.current) { setFocusError(t('accountFocus.failed')); return; }
    busy.current = true;
    setSaving(true); setFocusError('');
    try {
      if (file) await startAccountFocus(file);
      else {
        // Put the account's own priority back, then let a saved routing order take over again.
        await endAccountFocus();
        await applyQuotaRouting();
      }
    } catch { setFocusError(t('accountFocus.failed')); }
    finally { busy.current = false; setSaving(false); }
    void refresh(true);
  };

  const [checkingUnconfirmed, setCheckingUnconfirmed] = useState(false);
  const checkUnconfirmed = async () => {
    if (!readyRef.current || busy.current) return;
    const targets = attentionItems(files, quotas, Date.now(), false).filter(item => item.severity === 'unconfirmed' && canRecheck(item.unknownReason)).map(item => item.file);
    if (!targets.length) return;
    busy.current = true;
    setCheckingUnconfirmed(true);
    try {
      await refreshDashboardQuotas(targets, true, () => mounted.current && readyRef.current);
    } finally {
      busy.current = false;
      if (mounted.current) setCheckingUnconfirmed(false);
    }
  };

  const refreshAccount = async (file: AuthFile) => {
    if (!readyRef.current || busy.current || !providerForFile(file)) return;
    busy.current = true;
    setRefreshingKey(quotaKey(file));
    try {
      await refreshDashboardQuotas([file], true, () => mounted.current && readyRef.current);
    } finally {
      busy.current = false;
      if (mounted.current) setRefreshingKey(null);
    }
  };

  const stale = !ready || Boolean(error);
  const latest = activity?.latest;
  const latestFile = latest ? files.find((file) => accountRequests(file, [latest]).length) : undefined;
  const labelFor = (file: AuthFile) => accountDisplayName(file, dashboardProvider(file), names, hideEmails);
  const kindOf = (file: AuthFile) => quotaAvailability(file, quotas[quotaKey(file)], now, stale).kind;
  const kinds = files.map(kindOf);
  const attention = attentionItems(files, quotas, now, stale);
  const urgent = attention.filter((item) => item.severity !== 'unconfirmed');
  const urgentKeys = new Set(urgent.map((item) => quotaKey(item.file)));
  const summaryCounts: AccountStatusSummary = {
    total: files.length,
    available: kinds.filter((kind) => kind === 'available' || kind === 'creditBacked').length,
    problems: urgent.length,
    unconfirmed: kinds.filter((kind) => kind === 'unknown').length,
    latestAt: activity?.latest?.timestamp,
    loaded: listLoaded && (activity !== null || activityError),
    worst: urgent[0] ? { label: labelFor(urgent[0].file), severity: urgent[0].severity, percent: urgent[0].percent, resetAt: urgent[0].resetAt } : undefined,
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
  const query = search.trim().toLowerCase();
  // The accounts in view before the state filter: the chosen provider and search.
  const scoped = sorted.filter((file) => {
    const exact = query !== '' && [readString(file, 'email'), readString(file, 'label'), fileName(file)].some(value => value.toLowerCase() === query);
    return (filter === 'all' || dashboardProvider(file) === filter)
      && (!query || exact || (hideEmails ? privateAccountLabel(file, dashboardProvider(file)) : `${names[privateAccountLabel(file, dashboardProvider(file))] ?? ''} ${fileName(file)} ${accountSummary(file).label} ${dashboardProvider(file)}`).toLowerCase().includes(query));
  });
  const visible = scoped.filter((file) => {
    const state = quotaAvailability(file, quotas[quotaKey(file)], now, !ready || Boolean(error));
    // "Need attention" is the same set the status line counts: problems that can stop work, not unconfirmed quota.
    return stateFilter === 'all' || (stateFilter === 'available' ? state.kind === 'available' : urgentKeys.has(quotaKey(file)));
  });
  // Showing only problems is the default view, so the accounts it leaves out are summed up below rather than filtered away.
  const hiddenFine = stateFilter === 'attention' ? scoped.length - visible.length : 0;
  const saveName = (file: AuthFile, value: string) => {
    const key = privateAccountLabel(file, dashboardProvider(file));
    const next = { ...names };
    if (value.trim()) next[key] = value.trim().slice(0, 80); else delete next[key];
    if (!saveAccountNames(next)) return false;
    setNames(next); return true;
  };
  const viewAlternatives = (_file: AuthFile) => { setAlternatives(true); };
  const providerList = [...providers, ...[...new Set(files.map(dashboardProvider))].filter((provider) => !providers.includes(provider))];
  const filtered = filter !== 'all' || stateFilter === 'available' || search.trim() !== '';
  const changeState = (value: typeof stateFilter) => { setStateFilter(value); saveDashboardPreference('quotaState', value); };
  const clearFilters = () => {
    setAlternatives(false);
    setFilter('all'); setStateFilter('attention'); setSearch('');
    saveDashboardPreference('quotaProvider', 'all'); saveDashboardPreference('quotaState', 'attention');
  };
  const selectProvider = (provider: string) => {
    const next = filter === provider ? 'all' : provider;
    setFilter(next); saveDashboardPreference('quotaProvider', next);
    // Picking a provider means "show me its accounts"; letting it go returns to the problems-first view.
    changeState(next === 'all' ? 'attention' : 'all');
  };

  return <section className={`account-dashboard quota-ledger quota-layout-${layout}`} aria-labelledby="account-dashboard-title">
    <div className="ad-heading">
      <h2 id="account-dashboard-title">{t('accountDashboard.title')}</h2>
      {files.length > 0 && <div className="ad-list-heading">
        <h3 className="sr-only">{t('glance.list.availability')}</h3>
        {urgent.length > 0
          ? <button type="button" className={`secondary-button compact-button ad-attention-filter worst-${urgent[0].severity}`} aria-pressed={stateFilter === 'attention'}
            onClick={() => changeState(stateFilter === 'attention' ? 'all' : 'attention')}>{t('glance.list.needAttention', { count: urgent.length })}</button>
          : !stale && <span className="ad-all-clear" role="status">{t('glance.attention.none')}</span>}
        {filtered && <button type="button" className="secondary-button compact-button" onClick={clearFilters}>{t('availability.clearFilters')}</button>}
        <button type="button" className="secondary-button compact-button ad-manage" onClick={() => requestOAuthSubpage('authFiles')}>{t('glance.list.manage')}</button>
      </div>}
      <div className="quota-heading-actions">{summaryCounts.problems > 0 && <button type="button" className="secondary-button quota-compare" onClick={() => setAlternatives(value => !value)} aria-expanded={alternatives}>{t('ux.alternatives')}</button>}
      <button data-page-refresh className="secondary-button quota-refresh" disabled={!ready || loading || saving || refreshingKey !== null} onClick={() => void refresh(true)}
        title={loading ? t('accountDashboard.refreshing') : t('accountDashboard.refresh')}>
        <RefreshCw size={16} aria-hidden="true" className={loading ? 'spin' : undefined} /> <span className="quota-refresh-label">{loading ? t('accountDashboard.refreshing') : t('accountDashboard.refresh')}</span>
      </button></div>
    </div>
    {!ready ? <p className="ad-notice">{t('accountDashboard.start')}</p> : null}
    {error ? <MessageNotice inline className="ad-notice" message={`${error} ${t('accountDashboard.staleWarning')}`} /> : null}
    {/* Before the first list arrives, an empty list means "still loading", never "no accounts". */}
    {ready && !listLoaded && !error ? <p className="ad-notice" role="status">{t('glance.attention.loadingAccounts')}</p> : null}
    {ready && listLoaded && !error && !files.length ? <p className="ad-notice">{t('accountDashboard.empty')}</p> : null}
    {listLoaded && files.length > 0 && <Switchboard ready={ready && !error} files={files} quotas={quotas} now={now} items={activity?.items} routing={routingState}
      labelFor={labelFor} providerName={(provider) => providerNames[provider] ?? provider} />}
    <div className="quota-provider-summary">
      {providerList.filter((provider) => files.some((file) => dashboardProvider(file) === provider)).map((provider) => {
        const accounts = files.filter((file) => dashboardProvider(file) === provider);
        return <QuotaProviderSummary key={provider} outage={outageFor(providerStatuses, provider)} accounts={accounts} quotas={quotas} name={providerNames[provider] ?? provider} icon={<ProviderLogo provider={provider} />} now={now} stale={stale} labelFor={labelFor}
          selected={filter === provider} onSelect={() => selectProvider(provider)} provider={provider} />;
      })}
    </div>
    {alternatives && summaryCounts.problems > 0 && <AlternativeComparison files={files} quotas={quotas} now={now} stale={stale} labelFor={labelFor} onClose={() => setAlternatives(false)}
      onUse={file => { setAlternatives(false); void changeFocus(file); }} />}
    {/* The ledger answers "can I work?": problems first, every other account one click away. */}
    {(() => {
      const focused = focus && Date.now() < focus.until ? files.find(item => fileName(item) === focus.name) : undefined;
      return focused ? <p className="ad-notice ad-focus" role="status">
        {t('accountFocus.active', { name: labelFor(focused), time: new Date(focus!.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}
        <button type="button" className="secondary-button compact-button" disabled={saving} onClick={() => void changeFocus(null)}>{t('accountFocus.stop')}</button>
      </p> : null;
    })()}
    {focusError ? <MessageNotice inline className="ad-notice" message={focusError} onDismiss={() => setFocusError('')} /> : null}
    {files.length > 0 && !stale && <UnconfirmedLines attention={attention} onCheck={() => void checkUnconfirmed()} checking={checkingUnconfirmed} />}
    {files.length > 0 && <div className="quota-workflow-tools">
      <input type="search" aria-label={t('availability.search')} placeholder={t('availability.search')} value={search} onChange={event => setSearch(event.target.value)} />
      <select aria-label={t('availability.all')} value={stateFilter} onChange={event => changeState(event.target.value as typeof stateFilter)}><option value="all">{t('availability.all')}</option><option value="available">{t('availability.known')}</option><option value="attention">{t('availability.attention')}</option></select>
      <select aria-label={t('accountDashboard.sort')} value={sort} onChange={(event) => { setSort(event.target.value as typeof sort); saveDashboardPreference('quotaSort', event.target.value); }}><option value="priority">{t('accountDashboard.prioritySort')}</option><option value="reset">{t('accountDashboard.resetSort')}</option><option value="recovery">{t('availability.recovery')}</option></select>
      {/* Rarely changed display choices stay out of the way. */}
      <details className="ad-display-options">
        <summary>{t('glance.list.display')}<ChevronDown size={14} aria-hidden="true" /></summary>
        <div>
          <select className="quota-layout-select" aria-label={t('quotaLedger.layout')} value={layout} onChange={event => { const value = event.target.value as 'ledger' | 'compact'; setLayout(value); saveDashboardPreference('quotaLayout', value); }}>
            <option value="ledger">{t('quotaLedger.ledger')}</option><option value="compact">{t('quotaLedger.compact')}</option>
          </select>
          <select className="quota-group-select" aria-label={t('ai.groupBy')} value={groupBy} onChange={event => { const value = event.target.value as 'provider' | 'purpose'; setGroupBy(value); saveDashboardPreference('quotaGroupBy', value); }}>
            <option value="provider">{t('ai.groupBy.provider')}</option><option value="purpose">{t('ai.groupBy.purpose')}</option>
          </select>
          <label className="ledger-privacy"><input type="checkbox" checked={hideEmails} onChange={(event) => { setHideEmails(event.target.checked); if (event.target.checked) setSearch(''); saveDashboardPreference('hideEmails', String(event.target.checked)); }} />{t('ledger.hideEmails')}</label>
        </div>
      </details>
      <span className="quota-result-count" role="status">{t('availability.results', { shown: visible.length, total: files.length })}</span>
    </div>}
    <div className="ad-accounts">
      {(groupBy === 'purpose'
        // Your own groups ("Work", "Personal") in name order, with ungrouped accounts last.
        ? [...new Set(visible.map(file => accountGroups[quotaKey(file)] ?? ''))].sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1) || a.localeCompare(b))
          .map(name => ({ key: `group:${name}`, provider: '', label: name || t('ai.noGroup'), files: visible.filter(file => (accountGroups[quotaKey(file)] ?? '') === name) }))
        : providerList.map(provider => ({ key: provider, provider, label: providerNames[provider] ?? provider, files: visible.filter((file) => dashboardProvider(file) === provider) }))
      ).map(({ key, provider, label, files: group }) => {
        const columns = ledgerWindows(group, quotas).slice(0, 3);
        return group.length > 0 ? <section className="quota-account-group" key={key} aria-label={label}>
      <h3 className="quota-group-heading">{provider && <ProviderLogo provider={provider} />}{label}<span>{group.length}</span>
        {provider === 'antigravity' && paidFallback !== null && <button type="button" className={`ad-paid-fallback${paidFallback ? ' is-on' : ''}`} title={t('glance.paidFallback.hint')}
          onClick={() => requestSettingField(ANTIGRAVITY_PAID_FALLBACK_PATH)}>{t(paidFallback ? 'glance.paidFallback.on' : 'glance.paidFallback.off')}</button>}</h3>
      {group.map((file) => <AccountCard key={quotaKey(file)} file={file} quota={quotas[quotaKey(file)] ?? idleQuota()} now={now}
        label={labelFor(file)} hideEmails={hideEmails} requests={activity ? accountRequests(file, activity.items) : undefined} activityStale={activityError || stale}
        friendlyName={names[privateAccountLabel(file, dashboardProvider(file))] ?? ''} onName={saveName} onAlternatives={viewAlternatives}
        columns={columns} layout={layout} needsAttention={urgentKeys.has(quotaKey(file))}
        focused={Boolean(focus && Date.now() < focus.until && focus.name === fileName(file))} onFocus={(target, on) => void changeFocus(on ? target : null)}
        disabled={!ready || saving || loading || refreshingKey !== null || Boolean(error)} routing={routingPositions.get(quotaKey(file))} onRefresh={refreshAccount} refreshing={refreshingKey === quotaKey(file)} stale={stale} />)}
      </section> : null; })}
      {hiddenFine > 0 && <div className="ad-more-fine" role="status">
        <span>{t(visible.length ? 'glance.list.moreFine' : 'glance.list.healthy', { count: hiddenFine })}</span>
        <button type="button" className="secondary-button compact-button" onClick={() => changeState('all')}>{t('glance.list.showAll', { count: scoped.length })}</button>
      </div>}
      {!visible.length && !hiddenFine && files.length > 0 && <div className="quota-no-results" role="status"><span>{t('availability.noMatches')}</span>{filtered && <button type="button" className="secondary-button compact-button" onClick={clearFilters}>{t('availability.clearFilters')}</button>}</div>}
    </div>
    {ready && !error && files.length > 0 && <SwitchboardHistory files={files} quotas={quotas} now={now} routing={routingState} labelFor={labelFor} />}
    {/* The ledger comes first so accounts are visible without scrolling; activity and provider pace follow it.
        Each row carries its own recovery time, so there's no separate recovery list. */}
    <HomeGlance usage={usage} usageLoading={usageLoading} activity={activity} now={now} providerOf={dashboardProvider} latestAccount={latestFile ? labelFor(latestFile) : undefined} files={files} quotas={quotas} stale={stale} nameFor={(provider) => providerNames[provider] ?? provider} labelFor={labelFor} />
    <OverviewAlerts key={String(hideEmails)} files={files} quotas={quotas} now={now} stale={stale} labelFor={labelFor} items={activity?.items} activityStale={activityError || stale} />
    <p className="ad-footnote">{updatedAt ? t('accountDashboard.checked', { time: new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : t(ready ? 'accountDashboard.loading' : 'accountDashboard.waitingForProxy')} · {t('accountDashboard.cadence')}</p>
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

export function AccountCard({ needsAttention = false, file, quota, now, disabled, stale = false, routing, onRefresh, refreshing = false, columns, label, hideEmails = false, requests, activityStale = false, friendlyName = '', onName, onAlternatives, layout = 'compact', focused = false, onFocus }: {
  focused?: boolean; onFocus?: (file: AuthFile, on: boolean) => void;
  friendlyName?: string; onName?: (file: AuthFile, value: string) => boolean; onAlternatives?: (file: AuthFile) => void;
  /** Counted under "N need attention", so the row is marked to match. */
  needsAttention?: boolean;
  columns?: string[]; refreshing?: boolean; onRefresh?: (file: AuthFile) => Promise<void>;
  label?: string; hideEmails?: boolean; requests?: DashboardRequest[]; activityStale?: boolean;
  file: AuthFile; quota: QuotaState; now: number; disabled: boolean; stale?: boolean; layout?: 'compact' | 'ledger';
  routing?: { position: number; total: number; role: Role; provider: string };
}) {
  const { t } = useI18n();
  const summary = accountSummary(file);
  const provider = dashboardProvider(file);
  const displayLabel = label ?? accountSummary(file).label;
  const lastSuccess = requests?.find(successfulRequest);
  const successCount = requests?.filter(successfulRequest).length ?? 0;
  const failureCount = requests?.filter((request) => request.failed && !request.canceled).length ?? 0;
  const canceledCount = requests?.filter((request) => request.canceled).length ?? 0;
  const [nameDraft, setNameDraft] = useState(friendlyName);
  const [nameFeedback, setNameFeedback] = useState('');
  useEffect(() => { setNameDraft(friendlyName); }, [friendlyName]);
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const trends = useQuotaTrends();
  const [focusTarget, setFocusTarget] = useState<'name' | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!detailsOpen || !focusTarget) return;
    const input = focusTarget === 'name' ? nameInput.current : null;
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
  const openEditor = (target: 'name') => { setDetailsOpen(true); setFocusTarget(target); };
  const canRefresh = !disabled && Boolean(onRefresh) && Boolean(providerForFile(file)) && !summary.health.disabled;
  const menuItems: MenuItem[] = [
    { key: 'details', label: t(detailsOpen ? 'accountDashboard.hideDetails' : 'accountDashboard.showDetails'), onSelect: () => setDetailsOpen(value => !value) },
    ...(onName && !hideEmails ? [{ key: 'rename', label: t('accountDashboard.rename'), onSelect: () => openEditor('name'), movesFocus: true }] : []),
    { key: 'priority', label: `${t('ro.card.change')}…`, onSelect: () => requestSettingsCategory('routing') },
    { key: 'refresh', label: t(refreshing ? 'accountDashboard.refreshing' : 'accountDashboard.refreshQuota'), disabled: !canRefresh, onSelect: () => void onRefresh?.(file) },
    ...(needsSignIn(file) ? [{ key: 'sign-in', label: t('authFiles.signInAgain'), onSelect: () => openSignIn(String(file.provider ?? file.type ?? '')) }] : []),
    // Activity's Account filter matches the email the proxy records as each request's source.
    ...(typeof file.email === 'string' && file.email ? [{ key: 'requests', label: t('accountDashboard.viewRequests'), onSelect: () => requestAccountRequests(String(file.email)) }] : []),
    ...(onFocus ? [{ key: 'focus', label: t(focused ? 'accountFocus.stop' : 'accountFocus.start'), disabled: disabled || (!focused && file.disabled === true), onSelect: () => onFocus(file, !focused) }] : []),
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
  return <article className={`ad-card ad-row-card quota-account-${availability.kind} ${needsAttention ? 'ad-needs-attention ' : ''}${stale || quota.status === 'error' ? 'quota-row-stale' : ''}`} aria-label={displayLabel} data-account-key={quotaKey(file)} tabIndex={-1}>
    <div className="ad-row">
      <AccountAvatar file={file} provider={provider} />
      <div className="ad-row-name"><h3 title={hideEmails ? displayLabel : `${displayLabel}\n${fileName(file)}`}>{displayLabel}</h3>
        <span className="ad-provider">{providerLabel}{quota.plan ? ` · ${quota.plan}` : ''}</span></div>
      <PulseOnChange as="div" className="ad-row-status" value={availability.kind}>
        <QuotaAvailabilityNotice compact state={availability} now={now} />
        {stale && <span className="state-pill neutral">{t('accountDashboard.stale')}</span>}
      </PulseOnChange>
      <div className={`ad-quota-list ad-row-quota ad-row-quota-${faceRows.length || 1}`} aria-busy={quota.status === 'loading'}>
        {quota.status === 'error' ? <p className="ad-card-note ad-error">{t('accountDashboard.quotaError')}{canRefresh && <button type="button" className="glance-open" disabled={refreshing} onClick={() => void onRefresh?.(file)}>{t(refreshing ? 'accountDashboard.refreshing' : 'common.retry')}</button>}</p> : null}
        {/* The availability notice already explains an incomplete success; don't repeat it. */}
        {!quota.rows.length && quota.status !== 'error' && !(quota.status === 'success' && availability.uncertainty === 'incomplete') ? <p className="ad-card-note">{!providerForFile(file) ? t('ledger.unsupportedQuota') : summary.health.disabled ? t('accountDashboard.disabled') : quota.status === 'loading' ? t('accountDashboard.checking') : quota.status === 'success' ? t('accountDashboard.noLimits') : t('accountDashboard.notChecked')}</p> : null}
        {faceRows.map(renderQuota)}
      </div>
      <div className="ad-row-actions">
        {signIn && <SignInAgainButton account={displayLabel} provider={String(file.provider ?? file.type ?? '')} />}
        {refreshing && <RefreshCw size={14} aria-hidden="true" className="quota-refreshing ad-row-busy" />}
        <AccountMenu label={t('accountDashboard.menu', { account: displayLabel })} items={menuItems} />
      </div>
    </div>
    <details className="personal-disclosure ad-account-details" open={detailsOpen} onToggle={event => setDetailsOpen(event.currentTarget.open)}>
      <summary title={detailsLabel}><span className="sr-only">{detailsLabel}</span>{detailRows.length > 0 && <span aria-hidden="true">+{detailRows.length}</span>}<ChevronDown size={14} aria-hidden="true" /></summary>
      <div className="ad-details-body">
        <AccountStatusSection file={file} quota={quota} now={now} stale={stale} hideEmails={hideEmails} />
        {providerForFile(file) && !summary.health.disabled && <QuotaTrendChart trend={trends[quotaKey(file)]} now={now} />}
        {detailRows.length > 0 && <div className="ad-quota-list ad-detail-quotas">{detailRows.map((row, index) => renderQuota(row, index + faceRows.length))}</div>}
        {!hideEmails && <p className="ad-card-note">{t('desk.filename')}: {fileName(file)}</p>}
        {onName && !hideEmails && <div className="ad-name-editor"><label>{t('desk.friendlyName')}<input ref={nameInput} maxLength={80} value={nameDraft} onChange={event => { setNameDraft(event.target.value); setNameFeedback(''); }} /></label><button type="button" className="secondary-button" disabled={nameDraft === friendlyName} onClick={() => setNameFeedback(onName(file, nameDraft) ? t('desk.nameSaved') : t('desk.nameFailed'))}>{t('desk.saveName')}</button><small>{t('desk.nameHint')}</small><span role="status">{nameFeedback}</span></div>}
        <div className="ad-card-activity">
          <strong>{requests === undefined ? t('ledger.waiting') : requests.length ? t('ledger.counts', { success: successCount, failure: failureCount }) : t('ledger.noRequests')}</strong>
          {canceledCount > 0 && <span>{t('ledger.canceled', { count: canceledCount })}</span>}
          {lastSuccess && <><span>{t('ledger.lastSuccess')}</span><time dateTime={lastSuccess.timestamp}>{new Date(lastSuccess.timestamp).toLocaleString()}</time><span>{requestClient(lastSuccess) ?? t('ledger.unknownClient')}</span></>}
          {activityStale && <span>{t('ledger.stale')}</span>}
        </div>
        <AccountHealthSparkline file={file} active={detailsOpen} />
        <AccountIdentityEditor file={file} label={displayLabel} />
        <AccountValueLine file={file} active={detailsOpen} />
        <div className="ad-card-footer">{routing
          ? <span className="ad-routing-position">{t('ro.card.position', { position: routing.position, total: routing.total, provider: providerNames[routing.provider] ?? routing.provider, role: t(`ro.role.${routing.role}`) })}</span>
          : null}
          <button type="button" className="secondary-button" onClick={() => requestSettingsCategory('routing')}>{t('ro.card.change')}</button>
          <span className="ad-freshness" title={quota.refreshError}>{quota.fetchedAt ? t(quota.refreshError ? 'accountDashboard.quotaKept' : 'accountDashboard.quotaChecked', { time: new Date(quota.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : t('accountDashboard.noSnapshot')}</span></div>
        {feedback && <p role="status" className="ad-card-note">{feedback}</p>}
      </div>
    </details>
  </article>;
}
