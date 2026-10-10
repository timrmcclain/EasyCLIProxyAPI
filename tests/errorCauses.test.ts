import { describe, expect, test } from 'bun:test';
import { classifyFailure, failureMessage, groupFailures, type FailedRequest } from '../src/services/errorCauses';

// Shapes taken from real failures in this hub's usage database (identifiers replaced).
const bodies = {
  anthropicRate: '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_x"}',
  geminiExhausted: '{ "error": { "code": 429, "message": "Resource has been exhausted (e.g. check quota).", "status": "RESOURCE_EXHAUSTED" } }',
  kimiPlan: '{"error":{"message":"Your current subscription does not have access to Kimi Code right now. Upgrade your plan to keep coding with Kimi Code: https://www.kimi.com","type":"access_terminated_error"}}',
  retiredModel: '{"type":"error","error":{"type":"not_found_error","message":"model: claude-3-old"},"request_id":"req_y"}',
  billing: '{"error":{"code":"billing_not_configured","message":"Billing verification failed. Please check your payment method.","param":null,"type":"billing_error"}}',
  revoked: '{"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."},"request_id":"req_z"}',
  videoModel: '{"code":"invalid-argument","error":"The model grok-imagine-video-1.5 is a video model and is therefore not available on this endpoint. Please use a compatible endpoint."}',
  devin: 'devin upstream error (permission_denied): an internal error occurred (trace ID: abc)',
  overloaded: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_o"}',
  cloudflare: '<html> <head><title>502 Bad Gateway</title></head> <body> <center><h1>502 Bad Gateway</h1></center> <hr><center>cloudflare</center> </body> </html>',
  stream: 'stream error: stream disconnected before completion: stream closed before response.completed',
};

describe('classifyFailure', () => {
  test('sorts real provider errors into causes', () => {
    expect(classifyFailure(429, bodies.anthropicRate)).toBe('rateLimit');
    expect(classifyFailure(429, bodies.geminiExhausted)).toBe('rateLimit');
    expect(classifyFailure(403, bodies.kimiPlan)).toBe('plan');
    expect(classifyFailure(404, bodies.retiredModel)).toBe('model');
    expect(classifyFailure(402, bodies.billing)).toBe('billing');
    expect(classifyFailure(401, bodies.revoked)).toBe('signIn');
    expect(classifyFailure(400, bodies.videoModel)).toBe('model');
    expect(classifyFailure(500, bodies.devin)).toBe('provider');
    expect(classifyFailure(529, bodies.overloaded)).toBe('provider');
    expect(classifyFailure(502, bodies.cloudflare)).toBe('provider');
    expect(classifyFailure(408, bodies.stream)).toBe('connection');
    expect(classifyFailure(418, 'teapot')).toBe('other');
  });
});

describe('failureMessage', () => {
  test('pulls the sentence out of JSON, HTML and plain errors', () => {
    expect(failureMessage(bodies.anthropicRate)).toBe("This request would exceed your account's rate limit. Please try again later.");
    expect(failureMessage(bodies.videoModel)).toStartWith('The model grok-imagine-video-1.5 is a video model');
    expect(failureMessage(bodies.cloudflare)).toBe('502 Bad Gateway 502 Bad Gateway cloudflare');
    expect(failureMessage('x'.repeat(400))).toHaveLength(178);
  });
});

describe('groupFailures', () => {
  const request = (timestamp: string, provider: string, status: number, body: string): FailedRequest =>
    ({ timestamp, provider, source: provider, failure_status: status, failure_body: body });

  test('groups worst first with providers, statuses and the newest message', () => {
    const groups = groupFailures([
      request('2026-10-10T12:00:00Z', 'claude', 429, bodies.anthropicRate),
      request('2026-10-10T11:00:00Z', 'gemini', 429, bodies.geminiExhausted),
      request('2026-10-10T10:00:00Z', 'claude', 429, bodies.anthropicRate),
      request('2026-10-10T13:00:00Z', 'kimi', 403, bodies.kimiPlan),
      request('2026-10-09T09:00:00Z', 'codex', 500, bodies.devin),
    ]);
    expect(groups.map(group => group.cause)).toEqual(['rateLimit', 'plan', 'provider']);
    const [rate] = groups;
    expect(rate.count).toBe(3);
    expect(rate.providers).toEqual([{ name: 'claude', count: 2 }, { name: 'gemini', count: 1 }]);
    expect(rate.statuses).toEqual([429]);
    expect(rate.lastSeen).toBe('2026-10-10T12:00:00Z');
    expect(rate.example).toStartWith('This request would exceed');
    expect(rate.target).toBe('oauth');
    expect(groups[2].target).toBeUndefined();
  });

  test('breaks count ties by recency', () => {
    const groups = groupFailures([
      request('2026-10-10T08:00:00Z', 'a', 401, bodies.revoked),
      request('2026-10-10T09:00:00Z', 'b', 529, bodies.overloaded),
    ]);
    expect(groups.map(group => group.cause)).toEqual(['provider', 'signIn']);
  });
});
