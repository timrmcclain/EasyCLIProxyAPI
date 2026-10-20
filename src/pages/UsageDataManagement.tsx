import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Wrench } from 'lucide-react';
import { getCurrentLocale, useI18n } from '../i18n';
import { MessageNotice, FeedbackNotice, useAppNotice } from '../appNotice';
import { useConfirmation } from '../components/ConfirmationDialog';
import { formatUsageNumber } from '../services/usageNumber';
import { readableError } from '../services/readableError';
import { useUnsavedChangesGuard } from '../services/unsavedChanges';

type UsageRepairResult = {
  scanned: number;
  repaired: number;
  deleted: number;
  backupPath: string | null;
};

type UsageStorageSettings = {
  maxDatabaseSizeMb: number;
  databaseSizeBytes: number;
  totalRecords: number;
  deletedRecords: number;
};

const compactNumber = (value: number) => formatUsageNumber(value, getCurrentLocale());

const formatStorageBytes = (value: number) => {
  const bytes = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

/** Settings → Storage: the activity database's size limit, shrinking it, and repairing old records.
 *  Saving the limit is the one primary action; shrinking and repairing change data, so they stay
 *  outlined and each asks first. */
export function UsageDataManagement() {
  const { askConfirmation, confirmationDialog } = useConfirmation();
  const { t } = useI18n();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<UsageRepairResult | null>(null);
  const [error, setError] = useState('');
  const [storage, setStorage] = useState<UsageStorageSettings | null>(null);
  const [limitDraft, setLimitDraft] = useState('0');
  const [loadingLimit, setLoadingLimit] = useState(true);
  const [savingLimit, setSavingLimit] = useState(false);
  const [shrinkDraft, setShrinkDraft] = useState('');
  const [shrinking, setShrinking] = useState(false);
  const feedback = useAppNotice();
  const { showNotice, clearNotice } = feedback;
  const limitDirty = storage !== null && limitDraft.trim() !== String(storage.maxDatabaseSizeMb);
  useUnsavedChangesGuard('usage-storage-limit', limitDirty);

  useEffect(() => {
    let disposed = false;
    invoke<UsageStorageSettings>('get_usage_storage_settings')
      .then((next) => {
        if (disposed) return;
        setStorage(next);
        setLimitDraft(String(next.maxDatabaseSizeMb));
      })
      .catch((requestError) => {
        if (!disposed) setError(readableError(requestError));
      })
      .finally(() => {
        if (!disposed) setLoadingLimit(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

  const saveStorageLimit = async () => {
    const normalized = limitDraft.trim();
    const maxDatabaseSizeMb = Number(normalized);
    if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(maxDatabaseSizeMb)) {
      setError(t('usage.dataManagement.storageInvalid'));
      return;
    }
    setSavingLimit(true);
    setError('');
    clearNotice();
    try {
      const next = await invoke<UsageStorageSettings>('save_usage_storage_settings', { maxDatabaseSizeMb });
      setStorage(next);
      setLimitDraft(String(next.maxDatabaseSizeMb));
      showNotice({
        key: next.deletedRecords > 0 ? 'usage.dataManagement.storageSavedWithCleanup' : 'usage.dataManagement.storageSaved',
        variables: { deleted: next.deletedRecords.toLocaleString() },
      });
    } catch (requestError) {
      setError(readableError(requestError));
    } finally {
      setSavingLimit(false);
    }
  };

  const shrinkDatabase = async () => {
    const normalized = shrinkDraft.trim();
    const targetDatabaseSizeMb = Number(normalized);
    if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(targetDatabaseSizeMb) || targetDatabaseSizeMb <= 0) {
      setError(t('usage.dataManagement.shrinkInvalid'));
      return;
    }
    const confirmed = await askConfirmation({
      title: t('usage.dataManagement.shrinkConfirmTitle'),
      message: t('usage.dataManagement.shrinkConfirm', { size: targetDatabaseSizeMb }),
    });
    if (!confirmed) return;
    setShrinking(true);
    setError('');
    clearNotice();
    try {
      const next = await invoke<UsageStorageSettings>('shrink_usage_database', { targetDatabaseSizeMb });
      setStorage(next);
      showNotice({
        key: next.deletedRecords > 0 ? 'usage.dataManagement.shrinkSuccess' : 'usage.dataManagement.shrinkNoCleanup',
        variables: {
          deleted: next.deletedRecords.toLocaleString(),
          size: formatStorageBytes(next.databaseSizeBytes),
        },
      });
    } catch (requestError) {
      setError(readableError(requestError));
    } finally {
      setShrinking(false);
    }
  };

  const repair = async () => {
    if (!await askConfirmation({ title: t('usage.dataManagement.title'), message: t('usage.dataManagement.confirm') })) return;
    setRunning(true);
    setError('');
    clearNotice();
    setResult(null);
    try {
      const next = await invoke<UsageRepairResult>('repair_usage_cache_records');
      setResult(next);
      showNotice({ key: 'usage.dataManagement.success', variables: { repaired: next.repaired, deleted: next.deleted } });
      const nextStorage = await invoke<UsageStorageSettings>('get_usage_storage_settings');
      setStorage(nextStorage);
    } catch (requestError) {
      setError(readableError(requestError));
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="panel usage-data-management-panel">
      {confirmationDialog}
      <div className="usage-data-management-heading">
        <div>
          <Wrench size={20} aria-hidden="true" />
          <h2>{t('usage.dataManagement.title')}</h2>
        </div>
        <span className="usage-data-management-badge">{t('usage.dataManagement.manualBadge')}</span>
      </div>

      <div className="usage-data-management-action usage-storage-limit-action">
        <div>
          <strong>{t('usage.dataManagement.storageTitle')}</strong>
          <span title={t('usage.dataManagement.storageDetail')}>{t('usage.dataManagement.storageDescription')}</span>
          {storage ? (
            <small>
              {t('usage.dataManagement.storageCurrent', {
                size: formatStorageBytes(storage.databaseSizeBytes),
                records: compactNumber(storage.totalRecords),
              })}
            </small>
          ) : null}
        </div>
        <div className="usage-storage-limit-editor">
          <label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={limitDraft}
              disabled={loadingLimit || savingLimit || shrinking || running}
              onChange={(event) => setLimitDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && limitDirty && !loadingLimit && !savingLimit && !shrinking && !running) void saveStorageLimit();
              }}
              aria-label={t('usage.dataManagement.storageInput')}
            />
            <span>{t('usage.dataManagement.storageUnit')}</span>
          </label>
          <span className="config-card-status" role="status">{limitDirty ? t('common.unsavedChanges') : ''}</span>
          <button
            type="button"
            className="primary-button"
            onClick={() => void saveStorageLimit()}
            disabled={loadingLimit || savingLimit || shrinking || running || !limitDirty}
          >
            {savingLimit ? t('usage.dataManagement.storageSaving') : t('usage.dataManagement.storageSave')}
          </button>
        </div>
      </div>

      <div className="usage-data-management-action">
        <div>
          <strong>{t('usage.dataManagement.shrinkTitle')}</strong>
          <span title={t('usage.dataManagement.shrinkDetail')}>{t('usage.dataManagement.shrinkDescription')}</span>
        </div>
        <div className="usage-storage-limit-editor">
          <label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={shrinkDraft}
              disabled={savingLimit || shrinking || running}
              onChange={(event) => setShrinkDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !savingLimit && !shrinking && !running) void shrinkDatabase();
              }}
              aria-label={t('usage.dataManagement.shrinkInput')}
            />
            <span>{t('usage.dataManagement.storageUnit')}</span>
          </label>
          <button
            type="button"
            className="danger-button"
            onClick={() => void shrinkDatabase()}
            disabled={savingLimit || shrinking || running}
          >
            {shrinking ? t('usage.dataManagement.shrinking') : t('usage.dataManagement.shrinkRun')}
          </button>
        </div>
      </div>

      <FeedbackNotice feedback={feedback} />

      <div className="usage-data-management-action">
        <div>
          <strong>{t('usage.dataManagement.actionTitle')}</strong>
          <span>{t('usage.dataManagement.actionDescription')}</span>
        </div>
        <button type="button" className="secondary-button" onClick={() => void repair()} disabled={running || savingLimit || shrinking}>
          {running ? t('usage.dataManagement.running') : t('usage.dataManagement.run')}
        </button>
      </div>

      {error ? <MessageNotice inline message={error} onDismiss={() => setError('')} /> : null}
      {result ? (
        <>
          <div className="usage-data-management-result">
          <div><span>{t('usage.dataManagement.scanned')}</span><strong>{result.scanned.toLocaleString()}</strong></div>
          <div><span>{t('usage.dataManagement.repaired')}</span><strong>{result.repaired.toLocaleString()}</strong></div>
          <div><span>{t('usage.dataManagement.deleted')}</span><strong>{result.deleted.toLocaleString()}</strong></div>
          <div><span>{t('usage.dataManagement.backup')}</span><strong title={result.backupPath ?? undefined}>{result.backupPath ?? '—'}</strong></div>
          </div>
        </>
      ) : null}
    </section>
  );
}
