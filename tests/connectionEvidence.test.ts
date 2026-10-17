import { expect, test } from 'bun:test';
import { connectionEvidence, listConnectionState, type ConnectionStatus } from '../src/services/connectionEvidence';
import type { DashboardRequest } from '../src/services/dashboardActivity';
const now = Date.parse('2026-10-04T21:00:00Z');
const status: ConnectionStatus = { id: 'claude-desktop', installed: true, supportedPlatform: true, configValid: true, connectionState: 'configured', codexNativeOauth: false, error: null };
const request = (overrides: Partial<DashboardRequest> = {}): DashboardRequest => ({ timestamp: new Date(now - 60000).toISOString(), user_agent: 'claude-desktop/1', model: 'test', failed: false, canceled: false, ...overrides });
test('configured is never verified without recent matching successful evidence', () => {
  expect(connectionEvidence(status, [], now).stage).toBe('configured');
  expect(connectionEvidence(status, [request()], now).stage).toBe('verified');
  for (const item of [request({ failed: true }), request({ canceled: true }), request({ user_agent: 'claude-cli' }), request({ timestamp: new Date(now - 360000).toISOString() }), request({ timestamp: new Date(now + 5000).toISOString() })]) {
    expect(connectionEvidence(status, [item], now).stage).toBe('configured');
  }
});
test('latest failure supersedes older success; direct sign-in and invalid configs stay distinct', () => {
  expect(connectionEvidence(status, [request(), request({ failed: true, timestamp: new Date(now - 10000).toISOString() })], now).stage).toBe('configured');
  expect(connectionEvidence({ ...status, connectionState: 'not-configured' }, [request()], now).stage).toBe('detected');
  expect(connectionEvidence({ ...status, configValid: false }, [request()], now).stage).toBe('attention');
  expect(connectionEvidence({ ...status, installed: false }, [request()], now).stage).toBe('notDetected');
  expect(connectionEvidence({ ...status, codexNativeOauth: true }, [request()], now).stage).toBe('native');
});

test('the AI apps list keeps installed, connected and working apart', () => {
  // Installed but not set up through the hub is not connected.
  expect(listConnectionState({ ...status, connectionState: 'not-configured' }, [], now)).toEqual({ key: 'installed' });
  // Connected with no request seen: no time, and never "working".
  expect(listConnectionState(status, [], now)).toEqual({ key: 'connected', at: undefined });
  // An older success is a timestamp on "connected", not "working".
  const older = request({ timestamp: new Date(now - 2 * 3600000).toISOString() });
  expect(listConnectionState(status, [older], now)).toEqual({ key: 'connected', at: Date.parse(older.timestamp) });
  expect(listConnectionState(status, [request()], now)?.key).toBe('verified');
  // A latest failure carries no success time.
  expect(listConnectionState(status, [request({ failed: true })], now)).toEqual({ key: 'connected', at: undefined });
  expect(listConnectionState({ ...status, connectionState: 'needs-update' }, [], now)).toEqual({ key: 'attention' });
  expect(listConnectionState({ ...status, installed: false }, [], now)).toBeNull();
});
