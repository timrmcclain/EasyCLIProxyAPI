import { describe, expect, it } from 'bun:test';
import { needsPlanCheck, planBlockFromFailure, withPlanBlocks } from '../src/services/planBlock';
import { quotaAvailability } from '../src/services/quotaAvailability';

const now = 1800000000000;
const kimiBody = JSON.stringify({ error: { message: 'Your current subscription does not have access to Kimi Code right now. Upgrade your plan to keep coding with Kimi Code: https://www.kimi.com/code', type: 'permission_denied_error' } });

describe('plan block detection', () => {
  it('reads a subscription refusal as a plan block and keeps the provider message', () => {
    expect(planBlockFromFailure({ failure_status: 403, failure_body: kimiBody }))
      .toBe('Your current subscription does not have access to Kimi Code right now. Upgrade your plan to keep coding with Kimi Code: https://www.kimi.com/code');
  });
  it('ignores ordinary failures that say nothing about the plan', () => {
    expect(planBlockFromFailure({ failure_status: 403, failure_body: '{"error":{"message":"Request blocked by safety filter"}}' })).toBeNull();
    expect(planBlockFromFailure({ failure_status: 429, failure_body: 'Upgrade your plan for higher rate limits' })).toBeNull();
    expect(planBlockFromFailure({ failure_status: 400, failure_body: 'model is not available on your plan' })).toBeNull();
  });
  it('accepts payment-required responses with a plain-text body', () => {
    expect(planBlockFromFailure({ failure_status: 402, failure_body: 'Payment required: no active subscription' })).toBe('Payment required: no active subscription');
  });
  it('only checks accounts that have never served a request but have failed', () => {
    expect(needsPlanCheck({ success: 0, failed: 15 })).toBe(true);
    expect(needsPlanCheck({ success: 3, failed: 15 })).toBe(false);
    expect(needsPlanCheck({ success: 0, failed: 0 })).toBe(false);
    expect(needsPlanCheck({})).toBe(false);
  });
  it('attaches the message to matching accounts only', () => {
    const files = [{ name: 'kimi.json', auth_index: '7' }, { name: 'claude.json', auth_index: '2' }];
    const result = withPlanBlocks(files, { '7': 'No subscription' });
    expect(result[0].plan_block_message).toBe('No subscription');
    expect(result[1].plan_block_message).toBeUndefined();
    expect(withPlanBlocks(files, {})).toBe(files);
  });
});

describe('plan block availability', () => {
  it('marks a plan-blocked account unavailable even when quota looks fine', () => {
    const file = { provider: 'kimi', status: 'active', plan_block_message: 'Your subscription does not include Kimi Code.' };
    const result = quotaAvailability(file, { status: 'success', fetchedAt: now, rows: [] }, now);
    expect(result.kind).toBe('unavailable');
    expect(result.reason).toBe('planBlocked');
    expect(result.planMessage).toBe('Your subscription does not include Kimi Code.');
  });
  it('still reports a disabled account as disabled', () => {
    expect(quotaAvailability({ provider: 'kimi', disabled: true, plan_block_message: 'x' }, undefined, now).kind).toBe('disabled');
  });
});

describe('saved accounts status badge', () => {
  const { authFileListStatus } = require('../src/services/authFileHealth') as typeof import('../src/services/authFileHealth');
  const active = { status: 'active' };
  const model = (name: string) => ({ scope: 'model', model: name, reason: 'not_found', retryAt: '2099-01-01T00:00:00Z', remainingSeconds: 3600 });
  it('stays Available when only individual models are cooling down', () => {
    expect(authFileListStatus(active, { receivedAtMs: 0, records: [model('claude-3-5-haiku-20241022')] as never })).toEqual({ label: 'authFiles.list.available', tone: 'success' });
  });
  it('says Cooling when the whole credential is cooling down', () => {
    expect(authFileListStatus(active, { receivedAtMs: 0, records: [{ ...model(''), scope: 'credential' }] as never })).toEqual({ label: 'authFiles.list.cooling', tone: 'warning' });
  });
  it('names a plan block ahead of everything but disabled', () => {
    expect(authFileListStatus({ ...active, plan_block_message: 'No subscription' }, undefined)).toEqual({ label: 'availability.planBlockedLabel', tone: 'error' });
    expect(authFileListStatus({ status: 'disabled', plan_block_message: 'x' }, undefined).label).toBe('authFiles.status.disabled');
  });
});
