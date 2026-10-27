import { describe, expect, it } from 'bun:test';
import { ALERT_RANK, rankAlerts } from '../src/services/overviewInsights';

const alert = (key: string, rank: number, at: number) => ({ key, text: key, rank, at });

describe('Overview alerts', () => {
  it('puts what needs you first and good news last, newest first within a rank', () => {
    const ranked = rankAlerts([
      alert('recovered-a', ALERT_RANK.recovered, 5),
      alert('network', ALERT_RANK.network, 1),
      alert('auth', ALERT_RANK.auth, 0),
      alert('limit-old', ALERT_RANK.limit, 2),
      alert('limit-new', ALERT_RANK.limit, 3),
    ]);
    expect(ranked.map(a => a.key)).toEqual(['auth', 'limit-new', 'limit-old', 'network', 'recovered-a']);
  });

  it('drops good news before a failure when there are too many', () => {
    const many = [alert('auth', ALERT_RANK.auth, 0), ...Array.from({ length: 6 }, (_, i) => alert(`recovered-${i}`, ALERT_RANK.recovered, 10 + i))];
    const kept = rankAlerts(many);
    expect(kept).toHaveLength(5);
    expect(kept[0].key).toBe('auth');
    expect(kept.map(a => a.key)).not.toContain('recovered-0');
  });
});
