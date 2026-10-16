import { describe, expect, it } from 'bun:test';
import { plainText } from '../src/services/plugins';

describe('plugin catalogue text', () => {
  it('decodes HTML character references into plain text', () => {
    expect(plainText('Tim&#39;s plugin')).toBe("Tim's plugin");
    expect(plainText('A &amp; B &lt;fast&gt; &quot;x&quot; &#x2014; done')).toBe('A & B <fast> "x" — done');
  });
  it('leaves unknown or invalid references alone and never produces markup it was not given', () => {
    expect(plainText('&bogus; &#0; &#x110000;')).toBe('&bogus; &#0; &#x110000;');
    expect(plainText(undefined)).toBe('');
  });
});
