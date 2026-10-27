import { useEffect, useRef, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { useI18n } from '../i18n';
import { EMPTY_POLICY, openFindings, readPolicy, secretGuardService } from '../services/secretGuard';
import { pluginsApi } from '../services/plugins';
import { navigateHelp } from '../services/uxNavigation';
import './AppDriftBanner.css';

/** On the Overview while Secret Guard has findings nobody has dealt with yet. */
export function SecretGuardBanner({ coreReady }: { coreReady: boolean }) {
  const { t } = useI18n();
  const [count, setCount] = useState(0);

  // The allowlist lives in the proxy's config. While it can't be read, use the last one seen, so findings marked
  // safe don't come back as needing attention whenever the proxy restarts.
  const lastAllow = useRef<string[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const findings = await secretGuardService.findings();
        if (coreReady) {
          try { lastAllow.current = readPolicy(await pluginsApi.getConfig('secret-guard')).allow; } catch { /* keep the last one */ }
        }
        const allow = lastAllow.current;
        if (allow === null) return;
        if (alive) setCount(openFindings(findings, { ...EMPTY_POLICY, allow }).length);
      } catch {
        if (alive) setCount(0);
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 30_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [coreReady]);

  if (!count) return null;
  return <section className="app-drift-banner sg-banner" role="status">
    <KeyRound size={18} aria-hidden="true" />
    <div className="app-drift-copy">
      <strong>{count === 1 ? t('sg.attentionOne') : t('sg.attention', { count })}</strong>
      <small>{t('sg.banner.detail')}</small>
    </div>
    <div className="app-drift-actions">
      <button type="button" className="primary-button compact-button" onClick={() => navigateHelp('secret-guard')}>{t('sg.review')}</button>
    </div>
  </section>;
}
