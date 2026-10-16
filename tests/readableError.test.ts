import { describe, expect, it } from 'bun:test';
import { errorText, readableError } from '../src/services/readableError';

describe('readableError', () => {
  it('names a plain cause for an unreachable proxy and keeps the original after it', () => {
    const text = readableError('Management API request failed: error sending request for url (http://127.0.0.1:8317/v0/management/config): tcp connect error: No connection could be made because the target machine actively refused it. (os error 10061)');
    expect(text.startsWith("The hub couldn't reach the proxy.")).toBe(true);
    expect(text).toContain('os error 10061');
  });
  it('explains a refused management key and proxy-side failures', () => {
    expect(readableError('Management API error (401): invalid management key')).toStartWith("The proxy refused the hub's management key.");
    expect(readableError(new Error('Management API error (502)'))).toStartWith('The proxy hit an error.');
  });
  it('drops Error: prefixes and pulls the message out of a JSON body', () => {
    expect(errorText('Error: Error: Save failed')).toBe('Save failed');
    expect(errorText('HTTP 400: {"error":{"type":"invalid_request_error","message":"model not found"}}')).toBe('HTTP 400: model not found');
    expect(errorText({ message: 'from an object' })).toBe('from an object');
    expect(errorText({ code: 7 })).toBe('{"code":7}');
  });
  it('leaves messages it has no better words for unchanged', () => {
    expect(readableError('Port must be between 1 and 65535')).toBe('Port must be between 1 and 65535');
    expect(readableError(undefined)).toBe('');
  });
});
