import { authFileHealth } from './authFileHealth';
import { parseAuthFilePriority } from './authFiles';
import { primaryQuotaRow, quotaPercentLeft } from './quotaLedger';
import { rankAccount, type RoutingTier } from './quotaRouting';
import { fileName, providerForFile, quotaKey, type AuthFile, type QuotaState } from './quotaService';

/**
 * One visible order per provider decides which account pays for each request. The proxy uses the highest-priority
 * account that's ready, so the hub writes this order as account priorities and nothing else does.
 *
 * - "Your order" (manual): the accounts go in the order you dragged them into.
 * - "Smart": accounts with room before low ones before blocked ones, and within each group the one whose weekly window
 *   resets soonest, so quota that would expire unused is spent first.
 *
 * In both modes Reserve accounts sit at the bottom, used only when every other account can't take the request, and an
 * account a rule is holding back (below its keep-back floor, or outside its hours) sits just above the reserve.
 */
export type RoutingMode = 'manual' | 'smart';
export type AccountRule = { keepPercent?: number; hours?: { from: number; to: number } };
export type ProviderOrder = { mode: RoutingMode; order: string[] };
export type ChangeSource = 'you' | 'smart';
export type RoutingHistoryEntry = { at: number; provider: string; by: ChangeSource; order: string[]; before?: RoutingSnapshot };
export type RoutingSnapshot = { provider: ProviderOrder; reserve: string[]; rules: Record<string, AccountRule> };
export type RoutingState = {
  version: 1;
  /** The mode a provider gets before you choose one (from the old "soonest reset first" switch). */
  defaultMode: RoutingMode;
  providers: Record<string, ProviderOrder>;
  /** Accounts (by quota key) used only when the rest can't be. */
  reserve: string[];
  rules: Record<string, AccountRule>;
  history: RoutingHistoryEntry[];
};

export type Role = 'primary' | 'next' | 'held' | 'reserve';
export type Reason = 'order' | 'smart' | 'low' | 'out' | 'floor' | 'hours' | 'reserve' | 'unchecked';
export type OrderEntry = {
  file: AuthFile; key: string; name: string; role: Role; reason: Reason; tier: RoutingTier | null;
  percent: number | null; resetAt: number | null; priority: number; current: number;
};
export type ProviderPlan = {
  provider: string; mode: RoutingMode; entries: OrderEntry[]; next: OrderEntry | null; checked: boolean;
  /** You've saved an order (or Reserve, or a rule) for this provider; until then Your order leaves the proxy's priorities alone. */
  owned: boolean;
};

export const ROUTING_KEY = 'personal.routingOrders';
const HISTORY_LIMIT = 20;
const WEEKLY = /week|7.day|seven_day|7\s*天|7\s*日|週|周/i;

const currentPriority = (file: AuthFile) => parseAuthFilePriority(file.priority) ?? 0;

export const emptyRoutingState = (defaultMode: RoutingMode = 'manual'): RoutingState =>
  ({ version: 1, defaultMode, providers: {}, reserve: [], rules: {}, history: [] });

/** The state as saved, or one built from the old switch and "Save for last" marks the first time. */
export function readRoutingState(storage: Pick<Storage, 'getItem'> = localStorage): RoutingState {
  try {
    const parsed = JSON.parse(storage.getItem(ROUTING_KEY) ?? 'null') as Partial<RoutingState> | null;
    if (parsed && parsed.version === 1) {
      return {
        ...emptyRoutingState(parsed.defaultMode === 'smart' ? 'smart' : 'manual'),
        providers: parsed.providers ?? {}, reserve: Array.isArray(parsed.reserve) ? parsed.reserve : [],
        rules: parsed.rules ?? {}, history: Array.isArray(parsed.history) ? parsed.history : [],
      };
    }
  } catch { /* fall through to the migration */ }
  const smart = storage.getItem('personal.quotaRouting') === 'true';
  let reserve: string[] = [];
  try {
    const last = JSON.parse(storage.getItem('personal.routingLast') ?? '[]');
    if (Array.isArray(last)) reserve = last.filter((key): key is string => typeof key === 'string');
  } catch { /* no marks */ }
  return { ...emptyRoutingState(smart ? 'smart' : 'manual'), reserve };
}

export function writeRoutingState(state: RoutingState) {
  localStorage.setItem(ROUTING_KEY, JSON.stringify({ ...state, history: state.history.slice(-HISTORY_LIMIT) }));
  window.dispatchEvent(new Event('app:routing-order'));
}

export const modeFor = (state: RoutingState, provider: string): RoutingMode => state.providers[provider]?.mode ?? state.defaultMode;

function percentFor(quota: QuotaState | undefined, weeklyOnly: boolean): number | null {
  const rows = quota?.rows ?? [];
  const weekly = rows.filter(row => WEEKLY.test(row.windowId ?? '') || WEEKLY.test(row.label));
  const left = quotaPercentLeft(primaryQuotaRow(weeklyOnly && weekly.length ? weekly : rows, []));
  return left ? left.percent : null;
}

function insideHours(hours: { from: number; to: number }, now: number) {
  const hour = new Date(now).getHours();
  return hours.from === hours.to || (hours.from < hours.to ? hour >= hours.from && hour < hours.to : hour >= hours.from || hour < hours.to);
}

/** Accounts grouped by provider, skipping turned-off ones; only providers with a choice to make. */
export function accountsByProvider(files: AuthFile[]) {
  const byProvider = new Map<string, AuthFile[]>();
  for (const file of files) {
    const provider = providerForFile(file);
    if (!provider || authFileHealth(file).disabled) continue;
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), file]);
  }
  return new Map([...byProvider].filter(([, accounts]) => accounts.length > 1));
}

/** The order one provider's accounts go in right now, with each account's role and why it's there. */
export function providerPlan(provider: string, accounts: AuthFile[], quotas: Record<string, QuotaState>, now: number, state: RoutingState): ProviderPlan {
  const mode = modeFor(state, provider);
  const reserve = new Set(state.reserve);
  const rows = accounts.map(file => {
    const key = quotaKey(file);
    const quota = quotas[key];
    const rank = rankAccount(file, quota, now);
    const rule = state.rules[key] ?? {};
    const percent = percentFor(quota, false);
    const weekly = percentFor(quota, true);
    let held: Reason | null = null;
    if (rule.keepPercent && weekly !== null && weekly < rule.keepPercent && rank?.tier !== 'out') held = 'floor';
    else if (rule.hours && !insideHours(rule.hours, now)) held = 'hours';
    return { file, key, name: fileName(file), rank, rule, percent, held, reserved: reserve.has(key) };
  });
  const checked = rows.every(row => row.rank);
  const byCurrent = (a: typeof rows[number], b: typeof rows[number]) =>
    currentPriority(b.file) - currentPriority(a.file) || a.name.localeCompare(b.name);
  const saved = state.providers[provider]?.order ?? [];
  const position = (key: string) => { const index = saved.indexOf(key); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
  const tierRank = { ready: 0, low: 1, out: 2 } as const;
  const base = [...rows].sort((a, b) => {
    // Smart order needs every account's quota; until then it keeps the order the proxy already has.
    if (mode === 'smart' && checked) {
      return tierRank[a.rank!.tier] - tierRank[b.rank!.tier] || a.rank!.resetAt - b.rank!.resetAt || a.name.localeCompare(b.name);
    }
    if (mode === 'manual') return position(a.key) - position(b.key) || byCurrent(a, b);
    return byCurrent(a, b);
  });
  const ordered = [
    ...base.filter(row => !row.reserved && !row.held),
    ...base.filter(row => !row.reserved && row.held),
    ...base.filter(row => row.reserved),
  ];
  let primaryTaken = false;
  const entries = ordered.map((row, index): OrderEntry => {
    const tier = row.rank?.tier ?? null;
    let role: Role;
    let reason: Reason;
    if (row.reserved) { role = 'reserve'; reason = 'reserve'; }
    else if (row.held) { role = 'held'; reason = row.held; }
    else {
      role = !primaryTaken && tier !== 'out' ? 'primary' : 'next';
      if (role === 'primary') primaryTaken = true;
      reason = !row.rank ? 'unchecked' : tier === 'out' ? 'out' : tier === 'low' ? 'low' : mode === 'smart' ? 'smart' : 'order';
    }
    return {
      file: row.file, key: row.key, name: row.name, role, reason, tier, percent: row.percent,
      resetAt: row.rank && Number.isFinite(row.rank.resetAt) ? row.rank.resetAt : null,
      priority: (ordered.length - index) * 10, current: currentPriority(row.file),
    };
  });
  // The account the next request goes to: the first one that isn't out of quota.
  const next = entries.find(entry => entry.tier !== 'out') ?? null;
  const owned = saved.length > 0 || rows.some(row => row.reserved || row.held || state.rules[row.key]);
  return { provider, mode, entries, next, checked, owned };
}

export function routingPlans(files: AuthFile[], quotas: Record<string, QuotaState>, now: number, state: RoutingState): ProviderPlan[] {
  return [...accountsByProvider(files)].map(([provider, accounts]) => providerPlan(provider, accounts, quotas, now, state));
}

/** True when the proxy's priorities already put the accounts in this order, so nothing needs writing. */
export const alreadyOrdered = (plan: ProviderPlan) =>
  plan.entries.every((entry, index) => index === 0 || plan.entries[index - 1].current > entry.current);

/** Priorities to write so the proxy follows the plan; none when its current priorities already give the same order. */
export function priorityWrites(plan: ProviderPlan): { name: string; priority: number }[] {
  if (plan.mode === 'smart' && !plan.checked) return [];
  if (plan.mode === 'manual' && !plan.owned) return [];
  if (alreadyOrdered(plan)) return [];
  return plan.entries.filter(entry => entry.priority !== entry.current).map(entry => ({ name: entry.name, priority: entry.priority }));
}

/** A copy of the state with one provider's choices replaced, and the change recorded so it can be undone. */
export function withProviderChange(state: RoutingState, provider: string, next: RoutingSnapshot, by: ChangeSource, order: string[], now: number): RoutingState {
  const before: RoutingSnapshot = {
    provider: state.providers[provider] ?? { mode: modeFor(state, provider), order: [] },
    reserve: state.reserve, rules: state.rules,
  };
  return {
    ...state,
    providers: { ...state.providers, [provider]: next.provider },
    reserve: next.reserve, rules: next.rules,
    history: [...state.history, { at: now, provider, by, order, before }].slice(-HISTORY_LIMIT),
  };
}

export const recordSmartChange = (state: RoutingState, provider: string, order: string[], now: number): RoutingState =>
  ({ ...state, history: [...state.history, { at: now, provider, by: 'smart' as const, order }].slice(-HISTORY_LIMIT) });

/**
 * A warning when traffic doesn't match the order: a Reserve or held account served a real share of recent requests
 * while an account above it still had quota (usually conversations that started on it before the order changed).
 */
export function orderMismatch(plan: ProviderPlan, recentByKey: Record<string, number>): { key: string; served: number; total: number } | null {
  const total = plan.entries.reduce((sum, entry) => sum + (recentByKey[entry.key] ?? 0), 0);
  if (total < 5) return null;
  const firstBackup = plan.entries.findIndex(entry => entry.role === 'reserve' || entry.role === 'held');
  if (firstBackup < 0 || !plan.entries.slice(0, firstBackup).some(entry => entry.tier !== 'out')) return null;
  const worst = plan.entries.slice(firstBackup).map(entry => ({ key: entry.key, served: recentByKey[entry.key] ?? 0 }))
    .sort((a, b) => b.served - a.served)[0];
  return worst && worst.served / total >= 0.3 ? { ...worst, total } : null;
}
