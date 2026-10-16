import { describe, expect, it } from 'bun:test';
import { accountDisplayName, privateAccountLabel } from '../src/services/accountPrivacy';

const file = { name: 'claude-1f9e2c7a4b.json', email: 'me@example.test', provider: 'claude' };

describe('accountDisplayName', () => {
  it('prefers your name for the account, then its email, then its file name', () => {
    const key = privateAccountLabel(file, 'claude');
    expect(accountDisplayName(file, 'claude', { [key]: 'Work' }, false)).toBe('Work');
    expect(accountDisplayName(file, 'claude', {}, false)).toBe('me@example.test');
    expect(accountDisplayName({ name: 'claude-1f9e2c7a4b.json' }, 'claude', {}, false)).toBe('claude-1f9e2c7a4b.json');
  });
  it('shows only the private pseudonym with Hide emails on, even over a custom name', () => {
    const key = privateAccountLabel(file, 'claude');
    expect(accountDisplayName(file, 'claude', { [key]: 'Work' }, true)).toBe(key);
  });
});
