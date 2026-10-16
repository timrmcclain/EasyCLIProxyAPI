import { describe, expect, it } from 'bun:test';
import { quotaAvailability } from '../src/services/quotaAvailability';
import { primaryQuotaRow } from '../src/services/quotaLedger';
import type { QuotaRow, QuotaState } from '../src/services/quotaService';

// Overview's ledger leads each row with one state and the window that decides it.
const H = 3_600_000;
const now = 1_800_000_000_000;
const claude = { provider: 'claude', status: 'active' };
const row = (windowId: string, left: number | null, resetIn: number): QuotaRow =>
  ({ label: windowId, scope: 'account', windowId, remainingPercent: left, resetAtMs: now + resetIn * H } as QuotaRow);
const state = (rows: QuotaRow[]): QuotaState => ({ status: 'success', fetchedAt: now, rows });

describe('ledger primary state', () => {
  it('a weekly block wins over a five-hour window with quota left', () => {
    const fiveHour = row('five_hour', 80, 2);
    const weekly = row('seven_day', 0, 4 * 24 + 23);
    const result = quotaAvailability(claude, state([fiveHour, weekly]), now);
    expect(result.kind).toBe('exhausted');
    // Back when the weekly window resets, not when the five-hour one does.
    expect(result.recoveryAt).toBe(weekly.resetAtMs);
    // The row's face shows the weekly window; the five-hour allowance goes to the details.
    expect(primaryQuotaRow([fiveHour, weekly], result.blockers)).toBe(weekly);
  });

  it('a usable account shows its tightest window', () => {
    const fiveHour = row('five_hour', 30, 2);
    const weekly = row('seven_day', 70, 50);
    const result = quotaAvailability(claude, state([fiveHour, weekly]), now);
    expect(result.kind).toBe('available');
    expect(result.recoveryAt).toBeUndefined();
    expect(primaryQuotaRow([weekly, fiveHour], result.blockers)).toBe(fiveHour);
  });

  it('accepted terms required leads even when quota is available', () => {
    // The hub marks an account this way when its recent requests failed with the terms error (see planBlock).
    const marked = { ...claude, plan_block_kind: 'terms', plan_block_message: "You'll need to accept them in claude.ai" };
    const result = quotaAvailability(marked, state([row('five_hour', 80, 2), row('seven_day', 90, 50)]), now);
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'termsRequired' });
    // No recovery time: waiting for a reset won't fix it.
    expect(result.recoveryAt).toBeUndefined();
  });

  it('an account with no quota reading stays unconfirmed, not usable', () => {
    expect(quotaAvailability(claude, { status: 'idle', rows: [] } as unknown as QuotaState, now).kind).toBe('unknown');
  });
});
