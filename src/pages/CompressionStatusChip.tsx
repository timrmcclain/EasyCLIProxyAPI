import { useEffect, useState } from 'react';
import { Shrink } from 'lucide-react';
import { useI18n } from '../i18n';
import { compressionText } from '../i18n/compression';
import { compressionService, type CompressionStatus } from '../services/compression';
import { navigateHelp } from '../services/uxNavigation';
import { formatTokens } from './CompressionPage';

const REFRESH_MS = 30_000;

/** Home status-line chip: shown only while compression is on, so the line stays about what's active. */
export function CompressionStatusChip() {
  const { locale } = useI18n();
  const [status, setStatus] = useState<CompressionStatus | null>(null);
  const [saved, setSaved] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await compressionService.status();
        if (cancelled) return;
        setStatus(next);
        if (next.enabled && next.running) {
          const stats = await compressionService.stats();
          if (!cancelled) setSaved(stats.persistentSavings?.lifetime?.tokens_saved ?? 0);
        }
      } catch {
        // The chip is optional; the Compression page reports errors.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (!status?.enabled) return null;
  const fallback = !status.routed;
  const detail = fallback
    ? compressionText('chipFallback', locale)
    : saved !== null
      ? compressionText('chipSaved', locale, { tokens: formatTokens(saved, locale) })
      : '';
  return (
    <button
      type="button"
      className={`home-status-chip home-status-compression ${fallback ? 'error' : 'neutral'}`}
      onClick={() => navigateHelp('compression')}
    >
      <Shrink size={12} aria-hidden="true" />
      {compressionText('chipLabel', locale)}{detail ? ` · ${detail}` : ''}
    </button>
  );
}
