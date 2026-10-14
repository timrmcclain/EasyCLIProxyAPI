import { expect, test } from 'bun:test';
import { interpolate, translate } from '../src/i18n';

test('{s} and {es} drop only when count is exactly 1', () => {
  expect(interpolate('{count} model{s}', { count: 1 })).toBe('1 model');
  expect(interpolate('{count} model{s}', { count: 0 })).toBe('0 models');
  expect(interpolate('{count} model{s}', { count: 2 })).toBe('2 models');
  expect(interpolate('{count} alias{es}', { count: 1 })).toBe('1 alias');
  expect(interpolate('{count} alias{es}', { count: 3 })).toBe('3 aliases');
  expect(interpolate('{count} model{s}', { count: '1,204' })).toBe('1,204 models');
});

test('{s} is left alone without a count, and a real {s} variable still wins', () => {
  expect(interpolate('model{s}', { other: 1 })).toBe('model{s}');
  expect(interpolate('x{s}', { count: 1, s: '!' })).toBe('x!');
});

test('English strings no longer say "1 API keys" or "1 models"', () => {
  expect(translate('en', 'apiAccess.entries.summaryKeys', { count: 1 })).toBe('1 API key');
  expect(translate('en', 'apiAccess.models.summary', { count: 1 })).toBe('1 model');
  expect(translate('en', 'apiAccess.models.summary', { count: 5 })).toBe('5 models');
});
