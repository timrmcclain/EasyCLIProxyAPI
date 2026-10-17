import { describe, expect, it } from 'bun:test';
import { outageFor, type ProviderStatus } from '../src/services/providerStatus';

const statuses: ProviderStatus[] = [
  { provider: 'claude', indicator: 'major', description: 'Elevated errors', pageUrl: 'https://status.claude.com' },
  { provider: 'codex', indicator: 'none', description: 'All Systems Operational', pageUrl: 'https://status.openai.com' },
  { provider: 'kimi', indicator: 'unknown', description: '', pageUrl: 'https://example.test' },
];

describe('provider outage badges', () => {
  it('badges only providers whose status page reports a problem', () => {
    expect(outageFor(statuses, 'claude')?.indicator).toBe('major');
    expect(outageFor(statuses, 'codex')).toBeUndefined();
  });
  it('never treats an unreadable feed or a provider without a feed as an outage', () => {
    expect(outageFor(statuses, 'kimi')).toBeUndefined();
    expect(outageFor(statuses, 'xai')).toBeUndefined();
    expect(outageFor([], 'claude')).toBeUndefined();
  });
});
