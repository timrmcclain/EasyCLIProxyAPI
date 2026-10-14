import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { useI18n } from '../i18n';
import { openFindings, readPolicy, secretGuardService } from '../services/secretGuard';
import { pluginsApi } from '../services/plugins';
import { navigateHelp } from '../services/uxNavigation';
import './AppDriftBanner.css';

/** On the Overview while Secret Guard has findings nobody has dealt with yet. */
export function SecretGuardBanner({ coreReady }: { coreReady: boolean }) {
  const { t } = useI18n();
  const [count, setCount] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const findings = await secretGuardService.findings();
        let allow: string[] = [];
        if (coreReady) {
          try { allow = readPolicy(await pluginsApi.getConfig('secret-guard')).allow; } catch { /* not configured yet */ }
        }
        if (alive) setCount(openFindings(findings, { defaultMode: 'report', modes: {}, allow }).length);
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
