import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, Lightbulb, Loader2 } from 'lucide-react';
import { useAppNotice, FeedbackNotice } from '../appNotice';
import { useI18n } from '../i18n';
import { compressionText, type CompressionTextKey } from '../i18n/compression';
import { compressionService, type LearnPreview } from '../services/compression';

/** Project learnings: dry-run `headroom learn` for one folder, then write its CLAUDE.local.md on request. */
export function CompressionLearnings({ installed }: { installed: boolean }) {
  const { locale } = useI18n();
  const t = (key: CompressionTextKey, values?: Record<string, string | number>) => compressionText(key, locale, values);
  const feedback = useAppNotice();
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<LearnPreview | null>(null);
  const [applied, setApplied] = useState<string[]>([]);

  const choose = async () => {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === 'string') setFolder(picked);
    } catch {
      // Dialog unavailable (browser preview); the field can still be typed into.
    }
  };

  const analyze = async () => {
    setBusy(true);
    setPreview(null);
    setApplied([]);
    try {
      setPreview(await compressionService.learnPreview(folder.trim()));
    } catch (error) {
      feedback.showNotice(t('learnFailed', { error: String(error) }), 'error');
    } finally {
      setBusy(false);
    }
  };

  const apply = async (path: string, content: string) => {
    try {
      await compressionService.learnApply(path, content);
      setApplied((paths) => [...paths, path]);
      feedback.showNotice(t('learnApplied'), 'success');
    } catch (error) {
      feedback.showNotice(String(error), 'error');
    }
  };

  return (
    <section className="compression-card compression-learn" aria-labelledby="compression-learn-title">
      <h2 id="compression-learn-title"><Lightbulb size={16} aria-hidden="true" />{t('learnTitle')}</h2>
      <p className="compression-learn-body">{t('learnBody')}</p>
      <p className="compression-learn-note">{t('learnPrivacy')}</p>
      <div className="compression-learn-row">
        <label>
          <span>{t('learnFolder')}</span>
          <input type="text" value={folder} onChange={(event) => setFolder(event.target.value)} disabled={busy || !installed} spellCheck={false} />
        </label>
        <button type="button" className="secondary-button" onClick={() => void choose()} disabled={busy || !installed}>
          <FolderOpen size={16} aria-hidden="true" />{t('learnChoose')}
        </button>
        <button type="button" className="primary-button" onClick={() => void analyze()} disabled={busy || !installed || !folder.trim()}>
          {busy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : null}{t('learnAnalyze')}
        </button>
      </div>
      <FeedbackNotice feedback={feedback} />
      {busy ? <p className="compression-learn-note" role="status">{t('learnAnalyzing')}</p> : null}
      {preview ? (
        <div className="compression-learn-result">
          {preview.summary ? <p className="compression-learn-note">{preview.summary}</p> : null}
          {preview.proposals.length === 0 ? <p>{t('learnNothing')}</p> : preview.proposals.map((proposal) => (
            <div key={proposal.path} className="compression-learn-proposal">
              <p className="compression-learn-path">{t('learnWillWrite', { path: proposal.path })}</p>
              <pre>{proposal.content}</pre>
              <button
                type="button"
                className="primary-button"
                disabled={applied.includes(proposal.path)}
                onClick={() => void apply(proposal.path, proposal.content)}
              >
                {t('learnApply')}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
