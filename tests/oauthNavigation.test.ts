import { expect, test } from 'bun:test';
import { isSignInExpiredError, takePendingOAuthSubpage } from '../src/oauthNavigation';

test('recognises expired or rejected sign-ins', () => {
  for (const message of [
    'HTTP 401 Unauthorized',
    'request failed: 401',
    'invalid_grant: refresh token revoked',
    'OAuth token has expired',
    'Please re-authenticate this account',
  ]) expect(isSignInExpiredError(message)).toBe(true);
});

test('does not offer Sign in again for ordinary failures', () => {
  for (const message of [undefined, '', 'HTTP 429 rate limit exceeded', 'HTTP 500 upstream error', 'timeout after 4010ms', 'quota exhausted'])
    expect(isSignInExpiredError(message)).toBe(false);
});

test('a pending Accounts tab is read once', () => {
  expect(takePendingOAuthSubpage()).toBeNull();
});
