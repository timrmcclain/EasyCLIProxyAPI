import { useI18n } from '../i18n';
import type { AccountTrend } from '../services/quotaTrend';
import './QuotaTrendChart.css';

const DAY = 24 * 3_600_000;
const SPAN = 7 * DAY;
const WIDTH = 280;
const HEIGHT = 56;
/** A gap longer than this (hub closed, say) breaks the line instead of drawing a guess across it. */
const MAX_GAP = 6 * 3_600_000;

/** A week of one quota window, remaining % over time, with resets showing as jumps back up. */
export function QuotaTrendChart({ trend, now }: { trend: AccountTrend | undefined; now: number }) {
  const { t } = useI18n();
  const samples = (trend?.samples ?? []).filter(sample => now - sample.at <= SPAN);
  if (samples.length < 2 || !trend) return <p className="ad-card-note quota-trend-empty">{t('trend.collecting')}</p>;

  const x = (at: number) => ((at - (now - SPAN)) / SPAN) * WIDTH;
  const y = (percent: number) => HEIGHT - (Math.max(0, Math.min(100, percent)) / 100) * HEIGHT;
  const segments: string[] = [];
  let current: string[] = [];
  samples.forEach((sample, index) => {
    if (index > 0 && sample.at - samples[index - 1].at > MAX_GAP) { segments.push(current.join(' ')); current = []; }
    current.push(`${x(sample.at).toFixed(1)},${y(sample.percent).toFixed(1)}`);
  });
  segments.push(current.join(' '));
  const lowest = Math.min(...samples.map(sample => sample.percent));
  const latest = samples[samples.length - 1].percent;
  const summary = t('trend.summary', { label: trend.label, now: Math.round(latest), lowest: Math.round(lowest) });

  return (
    <figure className="quota-trend">
      <figcaption>{t('trend.title', { label: trend.label })}</figcaption>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={summary}>
        {[1, 2, 3, 4, 5, 6].map(day => <line key={day} className="quota-trend-day" x1={(day / 7) * WIDTH} x2={(day / 7) * WIDTH} y1={0} y2={HEIGHT} />)}
        {segments.filter(Boolean).map((points, index) => <polyline key={index} points={points} />)}
      </svg>
      <div className="quota-trend-axis" aria-hidden="true"><span>{t('trend.weekAgo')}</span><span>{summary}</span><span>{t('trend.now')}</span></div>
    </figure>
  );
}
