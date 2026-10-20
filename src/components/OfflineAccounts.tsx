import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { PowerOff } from 'lucide-react';
import { useI18n } from '../i18n';
import { navigateHelp } from '../services/uxNavigation';
import { labelFor } from '../services/quotaWatcher';
import { readableError } from '../services/readableError';
import './OfflineAccounts.css';
import { StateMessage } from './StateMessage';

type OfflineAccount = { name: string; provider: string; email: string; disabled: boolean; priority: number; modifiedMs: number };

/**
 * Accounts while the proxy is stopped: read straight from the accounts folder, so you can still see what you
 * have. Changing anything needs the proxy, so this list is read-only and points to Overview to start it.
 */
export function OfflineAccounts() {
  const { t, locale } = useI18n();
  const [accounts, setAccounts] = useState<OfflineAccount[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    invoke<OfflineAccount[]>('list_offline_accounts')
      .then(list => { if (active) setAccounts(list); })
      .catch(reason => { if (active) { setError(readableError(reason)); setAccounts([]); } });
    return () => { active = false; };
  }, []);
  const date = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return (
    <section className="panel offline-accounts" aria-label={t('offlineAccounts.title')}>
      <div className="offline-accounts-banner" role="status">
        <PowerOff size={16} aria-hidden="true" />
        <span>{t('offlineAccounts.banner')}</span>
        <button type="button" className="secondary-button compact-button" onClick={() => navigateHelp('home')}>{t('offlineAccounts.openOverview')}</button>
      </div>
      {error ? <p className="offline-accounts-error">{error}</p> : null}
      {accounts === null ? <StateMessage kind="loading" size="section" title={t('authFiles.loading')} />
        : accounts.length === 0 ? <p className="offline-accounts-empty">{t('offlineAccounts.empty')}</p>
        : <table className="offline-accounts-table">
          <thead><tr>
            <th scope="col">{t('offlineAccounts.account')}</th>
            <th scope="col">{t('offlineAccounts.provider')}</th>
            <th scope="col">{t('offlineAccounts.priority')}</th>
            <th scope="col">{t('offlineAccounts.state')}</th>
            <th scope="col">{t('offlineAccounts.changed')}</th>
          </tr></thead>
          <tbody>{accounts.map(account => (
            <tr key={account.name} className={account.disabled ? 'off' : undefined}>
              <td title={account.name}>{labelFor({ name: account.name, provider: account.provider, email: account.email })}</td>
              <td>{account.provider || '—'}</td>
              <td>{account.priority}</td>
              <td>{account.disabled ? t('offlineAccounts.off') : t('offlineAccounts.on')}</td>
              <td>{account.modifiedMs ? date.format(account.modifiedMs) : '—'}</td>
            </tr>
          ))}</tbody>
        </table>}
    </section>
  );
}
