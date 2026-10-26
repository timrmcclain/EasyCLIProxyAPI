import { describe, expect, it } from 'bun:test';
import { rotateUrl, secretSeverity, weeklySafety, wordsFoundIn } from '../src/services/secretSeverity';
import type { SecretGuardFinding } from '../src/services/secretGuard';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 26, 12);
const finding = (kind: string, daysAgo: number, actions: string[]): SecretGuardFinding => ({
  fingerprint: `${kind}-${daysAgo}`, kind, firstSeen: NOW - daysAgo * DAY, lastSeen: NOW - daysAgo * DAY, sightings: 1,
  providers: ['claude'], models: [], clients: [], actions, dismissedAt: null,
});

describe('secret severity', () => {
  it('ranks keys that spend money or change code above account keys, and unknown kinds as medium', () => {
    expect(secretSeverity('aws_access_key')).toBe('critical');
    expect(secretSeverity('github_token')).toBe('critical');
    expect(secretSeverity('anthropic_key')).toBe('high');
    expect(secretSeverity('jwt')).toBe('medium');
    expect(secretSeverity('something_new')).toBe('medium');
  });

  it('knows where to rotate provider keys, and has no single place for passwords', () => {
    expect(rotateUrl('openai_key')).toBe('https://platform.openai.com/api-keys');
    expect(rotateUrl('password_assignment')).toBeUndefined();
  });

  it('sums the last seven days: caught, stopped before a provider, only reported, critical', () => {
    const summary = weeklySafety([
      finding('aws_access_key', 1, ['blocked']),
      finding('openai_key', 2, ['redacted']),
      finding('jwt', 3, ['reported']),
      finding('github_token', 10, ['reported']),
    ], NOW);
    expect(summary).toEqual({ caught: 3, stopped: 2, reported: 1, critical: 1 });
  });
});

describe('sensitive words test box', () => {
  it('finds list words in the text, ignoring case, once each and in list order', () => {
    expect(wordsFoundIn('Ask Acme about the PROJECT-X launch; acme again', ['project-x', 'Acme', 'acme', ' ', 'Globex']))
      .toEqual(['project-x', 'Acme']);
    expect(wordsFoundIn('nothing here', ['Acme'])).toEqual([]);
  });
});
