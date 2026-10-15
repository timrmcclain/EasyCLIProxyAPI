import { describe, expect, test } from 'bun:test';
import { paletteScore, rankPalette } from '../src/components/paletteSearch';

const items = [
  { label: 'Proxy plugins', group: 'Pages' },
  { label: 'Proxy', group: 'Pages' },
  { label: 'Skills & plugins', group: 'Pages' },
  { label: 'Updates', group: 'Pages', keywords: ['upgrade', 'version'] },
  { label: 'Switch to dark theme', group: 'Appearance' },
];

describe('rankPalette', () => {
  test('an exact name beats a longer name that starts the same', () => {
    expect(rankPalette(items, 'proxy').map((item) => item.label)).toEqual(['Proxy', 'Proxy plugins']);
  });
  test('a label prefix beats a word inside another label', () => {
    expect(rankPalette(items, 'plug').map((item) => item.label)).toEqual(['Proxy plugins', 'Skills & plugins']);
  });
  test('keywords find pages whose name does not contain the word', () => {
    expect(rankPalette(items, 'version').map((item) => item.label)).toEqual(['Updates']);
  });
  test('group names still match, after everything else', () => {
    expect(rankPalette(items, 'appear').map((item) => item.label)).toEqual(['Switch to dark theme']);
  });
  test('an empty query keeps the original order', () => {
    expect(rankPalette(items, '  ').map((item) => item.label)).toEqual(items.map((item) => item.label));
  });
  test('no match returns null', () => {
    expect(paletteScore(items[0], 'zzz')).toBeNull();
  });
});
