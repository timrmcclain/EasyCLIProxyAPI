import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountStatusSection } from '../src/components/AccountStatusSection';
import { I18nProvider } from '../src/i18n';
import type { QuotaState } from '../src/services/quotaService';

const now = Date.parse('2030-01-01T00:00:00Z');
const file = { name: 'test.json', provider: 'claude', status: 'active', priority: 3 };
// Weekly cap used up; the 5-hour window still has room but doesn't make the account usable.
const exhausted: QuotaState = {
  status: 'success', fetchedAt: new Date(now).toISOString(), rows: [
    { label: 'Weekly limit', scope: 'account', windowId: 'seven_day', remainingPercent: 0, resetAtMs: now + 4 * 86_400_000 },
    { label: '5-hour limit', scope: 'account', windowId: 'five_hour', remainingPercent: 80, resetAtMs: now + 3_600_000 },
  ],
};
const render = (props: Partial<Parameters<typeof AccountStatusSection>[0]> = {}) => renderToStaticMarkup(
  <I18nProvider><AccountStatusSection file={file} quota={exhausted} now={now} {...props} /></I18nProvider>,
);

describe('shared account status section', () => {
  it('explains a blocked account the same way wherever it is shown', () => {
    const html = render();
    expect(html).toContain('quota-availability');
    expect(html).toContain('ad-recovery-hint');
    expect(html).toContain('ad-card-note');
  });
  it('leaves out the notice and credential lines where the row or a health panel already shows them', () => {
    const full = render();
    const slim = render({ notice: false, credential: false });
    expect(slim).not.toContain('quota-availability');
    expect(slim).toContain('ad-recovery-hint');
    expect(full.match(/ad-card-note/g)!.length).toBeGreaterThan(slim.match(/ad-card-note/g)!.length);
  });
});
