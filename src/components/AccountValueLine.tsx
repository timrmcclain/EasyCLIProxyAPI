import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { loadAccountValue, parsePriceInput, readAccountPrices, saveAccountPrice, valueMultiple } from '../services/accountValue';
import { quotaKey, type AuthFile } from '../services/quotaService';
import './AccountDashboard.css';

const usd = (amount: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: amount >= 100 ? 0 : 2 }).format(amount);

/**
 * What an account's last 30 days of requests would have cost at API prices, beside the monthly price you pay
 * for it if you've entered one. Loads only while the details are open.
 */
export function AccountValueLine({ file, active }: { file: AuthFile; active: boolean }) {
  const { t } = useI18n();
  const key = quotaKey(file);
  // Activity matches each request to the email the proxy records as its source.
  const source = typeof file.email === 'string' ? file.email : '';
  const [value, setValue] = useState<number | null | 'error'>(null);
  const [price, setPrice] = useState<number | undefined>(() => readAccountPrices()[key]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (!active || !source) return;
    let current = true;
    loadAccountValue(source).then(amount => { if (current) setValue(amount); }, () => { if (current) setValue('error'); });
    return () => { current = false; };
  }, [active, source]);
  if (!source) return null;
  const multiple = typeof value === 'number' ? valueMultiple(value, price) : undefined;
  const save = () => {
    const parsed = parsePriceInput(draft);
    if (parsed === undefined) { setInvalid(true); return; }
    setPrice(saveAccountPrice(key, parsed)[key]);
    setEditing(false);
  };
  return <div className="ad-card-note account-value-line">
    <span>{value === null ? t('accountValue.loading') : value === 'error' ? t('accountValue.unavailable')
      : price ? t('accountValue.withPrice', { price: usd(price), value: usd(value), multiple: String(multiple ?? 0) })
      : t('accountValue.noPrice', { value: usd(value) })}</span>
    {editing ? <span className="account-value-editor">
      <label>{t('accountValue.priceLabel')}<input inputMode="decimal" value={draft} aria-invalid={invalid}
        onChange={event => { setDraft(event.target.value); setInvalid(false); }}
        onKeyDown={event => { if (event.key === 'Enter') save(); if (event.key === 'Escape') setEditing(false); }} /></label>
      <button type="button" className="secondary-button compact-button" onClick={save}>{t('accountValue.save')}</button>
      {invalid && <span role="alert">{t('accountValue.invalid')}</span>}
    </span> : <button type="button" className="glance-open" onClick={() => { setDraft(price ? String(price) : ''); setEditing(true); }}>
      {t(price ? 'accountValue.changePrice' : 'accountValue.setPrice')}</button>}
  </div>;
}
