import { useEffect, useState } from 'react';
import { Skeleton } from './Skeleton';
import { invoke } from '@tauri-apps/api/core';
import './AccountIdentity.css';
import { useI18n } from '../i18n';
import {
  ACCOUNT_COLORS, accountColor, dailyHealth, readAccountColors, readAccountGroups, saveAccountColor, saveAccountGroup,
} from '../services/accountIdentity';
import { quotaKey, type AuthFile } from '../services/quotaService';
import { ProviderLogo } from './AuthFileProviderIcon';

/** Account colours and groups, kept in sync across every card that shows them. */
export function useAccountIdentity() {
  const [state, setState] = useState(() => ({ colors: readAccountColors(), groups: readAccountGroups() }));
  useEffect(() => {
    const sync = () => setState({ colors: readAccountColors(), groups: readAccountGroups() });
    window.addEventListener('app:account-colors', sync);
    return () => window.removeEventListener('app:account-colors', sync);
  }, []);
  return state;
}

/** The provider's logo on a ring in the account's own colour, so two Claude accounts look different at a glance. */
export function AccountAvatar({ file, provider, className = '' }: { file: AuthFile; provider: string; className?: string }) {
  const { colors } = useAccountIdentity();
  return <span className={`account-avatar ${className}`} style={{ '--account-color': accountColor(quotaKey(file), colors) } as React.CSSProperties} aria-hidden="true">
    <ProviderLogo provider={provider} />
  </span>;
}

/** Colour and group choices in an account's details. */
export function AccountIdentityEditor({ file, label }: { file: AuthFile; label: string }) {
  const { t } = useI18n();
  const { colors, groups } = useAccountIdentity();
  const key = quotaKey(file);
  const current = accountColor(key, colors);
  const [group, setGroup] = useState(groups[key] ?? '');
  useEffect(() => { setGroup(groups[key] ?? ''); }, [groups, key]);
  const known = [...new Set(Object.values(groups))].sort();
  return <div className="account-identity">
    <fieldset className="account-colors">
      <legend>{t('ai.color')}</legend>
      {ACCOUNT_COLORS.map(color => <button key={color} type="button" className="account-color" style={{ background: color }}
        aria-pressed={color === current} aria-label={t('ai.colorFor', { account: label, color: t(`ai.color.${ACCOUNT_COLORS.indexOf(color)}` as 'ai.color.0') })}
        onClick={() => saveAccountColor(key, color)} />)}
    </fieldset>
    <label className="account-group">{t('ai.group')}
      <input list="account-group-names" maxLength={40} value={group} placeholder={t('ai.groupPlaceholder')}
        onChange={event => setGroup(event.target.value)} onBlur={() => { if ((groups[key] ?? '') !== group.trim()) saveAccountGroup(key, group); }}
        onKeyDown={event => { if (event.key === 'Enter') saveAccountGroup(key, group); }} />
      <datalist id="account-group-names">{known.map(name => <option key={name} value={name} />)}</datalist>
    </label>
  </div>;
}

type Day = ReturnType<typeof dailyHealth>[number];

/** Seven days of requests and failures for one account, read from Activity when the details open. */
export function AccountHealthSparkline({ file, active }: { file: AuthFile; active: boolean }) {
  const { t } = useI18n();
  const source = typeof file.email === 'string' ? file.email : '';
  const [days, setDays] = useState<Day[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!active || !source) return;
    let live = true;
    const now = Date.now();
    invoke<{ timeline?: { hour: string; requests: number; failure?: number }[] }>('get_usage_overview', {
      query: { source, start: new Date(now - 7 * 86_400_000).toISOString(), end: new Date(now).toISOString() },
    }).then(overview => { if (live) setDays(dailyHealth(overview?.timeline ?? [], now)); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [active, source]);
  if (!source) return null;
  if (failed) return <p className="ad-card-note">{t('ai.health.unavailable')}</p>;
  if (!days) return <Skeleton shape="bars" count={7} label={t('ai.health.loading')} />;
  const peak = Math.max(1, ...days.map(day => day.requests));
  const failures = days.reduce((sum, day) => sum + day.failures, 0);
  const requests = days.reduce((sum, day) => sum + day.requests, 0);
  return <div className="account-health">
    <span className="account-health-title">{t('ai.health.title')}</span>
    <span className="account-health-bars">{days.map(day => {
      const text = t('ai.health.day', { day: new Date(day.at).toLocaleDateString([], { weekday: 'short' }), requests: day.requests, failures: day.failures });
      return <span key={day.at} className="account-health-day" title={text} aria-label={text} role="img">
        <span className="ok" style={{ height: `${((day.requests - day.failures) / peak) * 100}%` }} />
        <span className="bad" style={{ height: `${(day.failures / peak) * 100}%` }} />
      </span>;
    })}</span>
    <span className={failures ? 'account-health-sum has-failures' : 'account-health-sum'}>{t('ai.health.summary', { requests, failures })}</span>
  </div>;
}
