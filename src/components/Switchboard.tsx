import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import './Switchboard.css';
import { useI18n } from '../i18n';
import { resetCountdown } from '../services/accountDashboard';
import { accountColor, readAccountColors } from '../services/accountIdentity';
import type { DashboardRequest } from '../services/dashboardActivity';
import { useQuotaHistory } from '../services/quotaForecast';
import { quotaKey, type AuthFile, type QuotaState } from '../services/quotaService';
import { routingPlans, type RoutingState } from '../services/routingOrder';
import { requestSettingsCategory } from '../services/settingsNavigation';
import { appFlows, hubLanes, hubState, keptBack, resetCalendar, servedByHour, type Lane } from '../services/switchboard';
import { requestAccountRequests } from '../usageNavigation';
import { ProviderLogo } from './AuthFileProviderIcon';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const STRIP_REFRESH_MS = 5 * 60_000;

/**
 * Overview's first answer: is it working, and who is paying. Apps on the left send requests to the hub, which hands
 * each provider's requests to the account at the top of its routing order. A lane pulses while requests are flowing.
 */
export function Switchboard({ ready, files, quotas, now, items, routing, labelFor, providerName }: {
  ready: boolean; files: AuthFile[]; quotas: Record<string, QuotaState>; now: number; items: DashboardRequest[] | undefined;
  routing: RoutingState; labelFor: (file: AuthFile) => string; providerName: (provider: string) => string;
}) {
  const { t } = useI18n();
  const history = useQuotaHistory();
  const colors = useAccountColors();
  const plans = useMemo(() => routingPlans(files, quotas, now, routing), [files, quotas, now, routing]);
  const lanes = useMemo(() => hubLanes(plans, quotas, items ?? [], history, now), [plans, quotas, items, history, now]);
  const apps = useMemo(() => appFlows(items ?? [], now), [items, now]);
  const state = hubState(ready, lanes);
  const colorOf = (key: string) => accountColor(key, colors);

  if (ready && !lanes.length) return null;

  const blocked = lanes.find(lane => !lane.serving);
  const reserve = lanes.find(lane => lane.serving && (lane.serving.role === 'reserve' || lane.serving.role === 'held'));
  let sentence: string;
  if (state === 'down') sentence = t('sb.sentence.down');
  else if (blocked) {
    const resets = blocked.plan.entries.map(entry => entry.resetAt).filter((at): at is number => typeof at === 'number' && at > now);
    const soonest = resets.length ? Math.min(...resets) : null;
    const provider = providerName(blocked.provider);
    sentence = soonest
      ? t('sb.sentence.blocked', { provider, time: new Date(soonest).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) })
      : t('sb.sentence.blockedUnknown', { provider });
  } else if (reserve?.serving) sentence = t('sb.sentence.reserve', { provider: providerName(reserve.provider), account: labelFor(reserve.serving.file) });
  else sentence = t('sb.sentence.working', { count: lanes.length });

  return <section className={`switchboard state-${state}`} aria-labelledby="switchboard-title">
    <header className="sb-head">
      <h2 id="switchboard-title" className="sr-only">{t('sb.title')}</h2>
      <span className={`sb-state state-${state}`}><span className="sb-state-dot" aria-hidden="true" />{t(`sb.state.${state}`)}</span>
      <p className="sb-sentence" role="status">{sentence}</p>
      {(state === 'blocked' || state === 'reserve') && <button type="button" className="secondary-button compact-button sb-fix"
        onClick={() => requestSettingsCategory('routing')}>{t('sb.fix.order')}</button>}
    </header>
    {ready && <div className="sb-flow">
      <div className="sb-apps" aria-label={t('sb.apps')}>
        <h3 className="sr-only">{t('sb.apps')}</h3>
        {apps.length ? <ul>{apps.map(app => <li key={app.client} className={app.live ? 'live' : undefined}>
          <span className="sb-app-name">{app.client === 'other' ? t('sb.app.other') : app.client}</span>
          <span className="sb-app-count">{t('sb.app.count', { count: app.count })}</span>
        </li>)}</ul> : <p className="sb-muted">{t('sb.apps.none')}</p>}
      </div>
      <div className={`sb-hub${lanes.some(lane => lane.live) ? ' live' : ''}`} aria-hidden="true"><span>{t('sb.hub')}</span></div>
      <div className="sb-lanes" aria-label={t('sb.lanes')}>
        <h3 className="sr-only">{t('sb.lanes')}</h3>
        <ul>{lanes.map(lane => <LaneRow key={lane.provider} lane={lane} now={now} name={providerName(lane.provider)} labelFor={labelFor} colorOf={colorOf} />)}</ul>
      </div>
    </div>}
  </section>;
}

function useAccountColors() {
  const [colors, setColors] = useState(readAccountColors);
  useEffect(() => {
    const sync = () => setColors(readAccountColors());
    window.addEventListener('app:account-colors', sync);
    return () => window.removeEventListener('app:account-colors', sync);
  }, []);
  return colors;
}

/** Below the account list: who served each of the last 24 hours, and the week's weekly refills, in account colours. */
export function SwitchboardHistory({ files, quotas, now, routing, labelFor }: {
  files: AuthFile[]; quotas: Record<string, QuotaState>; now: number; routing: RoutingState; labelFor: (file: AuthFile) => string;
}) {
  const { t } = useI18n();
  const colors = useAccountColors();
  const colorOf = (key: string) => accountColor(key, colors);
  const byKey = useMemo(() => new Map(files.map(file => [quotaKey(file), file])), [files]);
  const plans = useMemo(() => routingPlans(files, quotas, now, routing), [files, quotas, now, routing]);
  if (!plans.length) return null;
  return <section className="switchboard sb-history" aria-label={t('sb.strip')}>
    <HourStrip files={files} now={now} labelFor={labelFor} colorOf={colorOf} byKey={byKey} />
    <ResetCalendar marks={resetCalendar(plans, quotas, now)} now={now} labelFor={labelFor} colorOf={colorOf} />
  </section>;
}

function Gauge({ weekly, session, color }: { weekly: number | null; session: number | null; color: string }) {
  const ring = (radius: number, percent: number | null, width: number) => {
    const length = 2 * Math.PI * radius;
    return <>
      <circle className="sb-gauge-track" cx="20" cy="20" r={radius} strokeWidth={width} />
      {percent !== null && <circle className="sb-gauge-fill" cx="20" cy="20" r={radius} strokeWidth={width} stroke={color}
        strokeDasharray={`${(percent / 100) * length} ${length}`} transform="rotate(-90 20 20)" />}
    </>;
  };
  return <svg className="sb-gauge" viewBox="0 0 40 40" width="30" height="30" aria-hidden="true">
    {ring(16, weekly, 4)}
    {ring(9.5, session, 3)}
  </svg>;
}

function LaneRow({ lane, now, name, labelFor, colorOf }: {
  lane: Lane; now: number; name: string; labelFor: (file: AuthFile) => string; colorOf: (key: string) => string;
}) {
  const { t } = useI18n();
  const serving = lane.serving;
  const account = serving ? labelFor(serving.file) : t('sb.lane.none');
  const kept = keptBack(lane);
  const forecast = lane.forecast;
  return <li className={`sb-lane${lane.live ? ' live' : ''}${serving ? '' : ' out'}`}>
    <span className="sb-wire" aria-hidden="true" />
    <button type="button" className="sb-lane-body" aria-label={t('sb.lane.label', { provider: name, account })}
      onClick={() => requestSettingsCategory('routing')}>
      <Gauge weekly={lane.weekly} session={lane.session} color={serving ? colorOf(serving.key) : 'var(--c-danger)'} />
      <span className="sb-lane-text">
        <span className="sb-lane-title"><ProviderLogo provider={lane.provider} />{name}
          {lane.live > 0 && <span className="sb-live" title={t('sb.lane.live', { count: lane.live })}><span className="sr-only">{t('sb.lane.live', { count: lane.live })}</span></span>}</span>
        <span className="sb-lane-account">{serving && <span className="sb-swatch" style={{ background: colorOf(serving.key) }} aria-hidden="true" />}<strong title={account}>{account}</strong></span>
        <span className="sb-lane-meta">
          {lane.weekly !== null && <span>{t('sb.lane.week', { percent: Math.round(lane.weekly) })}</span>}
          {lane.session !== null && <span>{t('sb.lane.session', { percent: Math.round(lane.session) })}</span>}
          {forecast?.kind === 'lastsToReset' && <span className="sb-good">{t('sb.lane.lasts')}</span>}
          {forecast?.kind === 'runsOut' && <span className="sb-warn">{t('sb.lane.runsOut', { time: resetCountdown(forecast.emptyAt, now) })}</span>}
        </span>
        {kept.length > 0 && <span className="sb-lane-kept">{t('sb.lane.kept', { accounts: kept.map(entry => labelFor(entry.file)).join(', ') })}</span>}
      </span>
    </button>
  </li>;
}

type Timeline = { hour: string; requests: number }[];

/** The last 24 hours as stacked bars, one colour per account; an hour opens that account's requests in Activity. */
function HourStrip({ files, now, labelFor, colorOf, byKey }: {
  files: AuthFile[]; now: number; labelFor: (file: AuthFile) => string; colorOf: (key: string) => string; byKey: Map<string, AuthFile>;
}) {
  const { t } = useI18n();
  const [timelines, setTimelines] = useState<Record<string, Timeline> | null>(null);
  const [failed, setFailed] = useState(false);
  const sources = useMemo(() => files.filter(file => typeof file.email === 'string' && file.email)
    .map(file => ({ key: quotaKey(file), source: String(file.email) })), [files]);
  const sourceList = sources.map(item => item.key).join('|');
  const bucket = Math.floor(now / STRIP_REFRESH_MS);
  useEffect(() => {
    let active = true;
    const end = Date.now();
    Promise.all(sources.map(async ({ key, source }) => {
      const overview = await invoke<{ timeline?: Timeline }>('get_usage_overview', {
        query: { source, start: new Date(end - DAY).toISOString(), end: new Date(end).toISOString() },
      });
      return [key, Array.isArray(overview?.timeline) ? overview.timeline : []] as const;
    })).then(entries => { if (active) { setTimelines(Object.fromEntries(entries)); setFailed(false); } })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
    // Reloads when the accounts change and every few minutes, not on every clock tick.
  }, [sourceList, bucket]);
  if (!sources.length) return null;
  const slices = timelines ? servedByHour(timelines, now) : [];
  const peak = Math.max(1, ...slices.map(slice => slice.total));
  const hourText = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric' });
  return <div className="sb-strip">
    <h3>{t('sb.strip')}</h3>
    {failed ? <p className="sb-muted">{t('sb.strip.unavailable')}</p>
      : !timelines ? <p className="sb-muted" role="status">{t('sb.strip.loading')}</p>
        : <div className="sb-strip-bars">
          {slices.map(slice => {
            const ranked = Object.entries(slice.byKey).sort((a, b) => b[1] - a[1]);
            const top = ranked[0] ? byKey.get(ranked[0][0]) : undefined;
            const label = slice.total && top
              ? t('sb.strip.hour', { time: hourText(slice.at), count: slice.total, account: labelFor(top) })
              : t('sb.strip.empty', { time: hourText(slice.at) });
            return <button key={slice.at} type="button" className="sb-strip-hour" aria-label={label} title={label} disabled={!top}
              onClick={() => { if (top?.email) requestAccountRequests(String(top.email)); }}>
              <span className="sb-strip-stack" style={{ height: `${Math.max(slice.total ? 8 : 0, (slice.total / peak) * 100)}%` }}>
                {ranked.map(([key, count]) => <span key={key} style={{ flexGrow: count, background: colorOf(key) }} />)}
              </span>
            </button>;
          })}
          <span className="sb-strip-axis" aria-hidden="true">
            <span>{hourText(slices[0]?.at ?? now - DAY)}</span><span>{hourText(slices[12]?.at ?? now - DAY / 2)}</span><span>{hourText(slices[23]?.at ?? now)}</span>
          </span>
        </div>}
  </div>;
}

function ResetCalendar({ marks, now, labelFor, colorOf }: {
  marks: ReturnType<typeof resetCalendar>; now: number; labelFor: (file: AuthFile) => string; colorOf: (key: string) => string;
}) {
  const { t } = useI18n();
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, index) => today.getTime() + index * DAY);
  return <div className="sb-calendar">
    <h3>{t('sb.calendar')}</h3>
    {!marks.length ? <p className="sb-muted">{t('sb.calendar.none')}</p> : <ol>
      {days.map((day, index) => {
        const inDay = marks.filter(mark => mark.at >= day && mark.at < day + DAY);
        return <li key={day} className={inDay.length ? 'has-marks' : undefined}>
          <span className="sb-calendar-day">{index === 0 ? t('sb.calendar.today') : new Date(day).toLocaleDateString([], { weekday: 'short' })}</span>
          {inDay.map(mark => {
            const label = t('sb.calendar.mark', { account: labelFor(mark.file), time: new Date(mark.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) });
            return <span key={mark.key} className="sb-calendar-mark" title={label}>
              <span className="sb-swatch" style={{ background: colorOf(mark.key) }} aria-hidden="true" />
              <span className="sb-calendar-name">{labelFor(mark.file)}</span>
              <span className="sr-only">{label}</span>
            </span>;
          })}
        </li>;
      })}
    </ol>}
  </div>;
}
