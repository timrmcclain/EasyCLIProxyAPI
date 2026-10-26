import { describe, expect, it } from 'bun:test';
import { buildHubPrompt } from '../src/services/askHub';
import { digestBody, digestDue, localDay, yesterdayRange } from '../src/services/morningDigest';

const usage = { totalRequests: 42, successCount: 40, failureCount: 2, canceledCount: 0, successRate: 95.2, timeline: [] };

describe('morning summary', () => {
  it('is due once a day, from 8am', () => {
    const early = new Date(2026, 9, 26, 7, 59);
    const morning = new Date(2026, 9, 26, 8, 0);
    expect(digestDue(early, null)).toBe(false);
    expect(digestDue(morning, null)).toBe(true);
    expect(digestDue(morning, localDay(morning))).toBe(false);
    expect(digestDue(morning, '2026-10-25')).toBe(true);
  });

  it('covers yesterday, midnight to midnight local time', () => {
    const { start, end } = yesterdayRange(new Date(2026, 9, 26, 9, 30));
    expect(new Date(start).getTime()).toBe(new Date(2026, 9, 25).getTime());
    expect(new Date(end).getTime()).toBe(new Date(2026, 9, 26).getTime());
  });

  it("says yesterday's requests and how quota stands now", () => {
    expect(digestBody(usage, 'Quota: Codex ok · Claude 1 low', 'en')).toBe('Yesterday: 42 requests, 2 failed. Quota: Codex ok · Claude 1 low');
    expect(digestBody({ ...usage, totalRequests: 0, failureCount: 0 }, null, 'en')).toBe('Yesterday was quiet: no requests.');
    expect(digestBody(null, null, 'en')).toBe("Yesterday's activity couldn't be read.");
  });
});

describe('ask the hub', () => {
  it('tells the model only counts and states, and to say when it cannot tell', () => {
    const prompt = buildHubPrompt({ proxyRunning: true, quotaLine: 'Quota: Claude 1 low', usage24h: usage, settings: ['Each request can go to any account.'], page: 'Overview' }, 'en');
    expect(prompt).toContain('The proxy is running.');
    expect(prompt).toContain('Quota now: Quota: Claude 1 low.');
    expect(prompt).toContain('Last 24 hours: 42 requests, 2 failed, 0 canceled.');
    expect(prompt).toContain('- Each request can go to any account.');
    expect(prompt).toContain('say you cannot tell from here');
    expect(prompt).toContain('Answer in English');
    expect(buildHubPrompt({ proxyRunning: false, quotaLine: null, usage24h: null, settings: [], page: 'Settings' }, 'ja'))
      .toContain('Answer in Japanese');
  });
});
