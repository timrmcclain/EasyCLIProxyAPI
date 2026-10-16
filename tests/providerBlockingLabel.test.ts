import { describe, expect, it } from 'bun:test';
import { blockingLabel } from '../src/components/QuotaProviderSummary';
import type { Availability } from '../src/services/quotaAvailability';

const state = (kind: Availability['kind'], reason?: Availability['reason']): Availability => ({ kind, reason, blockers: [], updating: false });
const t = (key: string) => key;

describe('provider card: accounts that cannot take requests', () => {
  it('names the shared cause only when every blocked account has it', () => {
    expect(blockingLabel([state('unavailable', 'termsRequired')], t)).toBe('availability.termsRequiredLabel');
    expect(blockingLabel([state('unavailable', 'planBlocked'), state('unavailable', 'planBlocked')], t)).toBe('availability.planBlockedLabel');
    expect(blockingLabel([state('exhausted'), state('exhausted')], t)).toBe('availability.exhausted');
  });
  it('never calls an out-of-quota account "not in your plan"', () => {
    expect(blockingLabel([state('exhausted')], t)).not.toBe('availability.planBlockedLabel');
    expect(blockingLabel([state('exhausted'), state('unavailable', 'planBlocked')], t)).toBe('availability.cantTakeRequests');
  });
});
