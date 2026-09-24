import { describe, expect, it } from 'vitest';
import { canTransition, LIFECYCLE_STATES, LIFECYCLE_TRANSITIONS, TERMINAL_PIPELINE_STATES } from '../src';
import { compareCorpusResult, validateCorpusCase, type CorpusCase } from '../src/corpus';

describe('lifecycle', () => {
  it('only references known states', () => {
    for (const [from, targets] of Object.entries(LIFECYCLE_TRANSITIONS)) {
      expect(LIFECYCLE_STATES).toContain(from);
      for (const to of targets) expect(LIFECYCLE_STATES).toContain(to);
    }
  });

  it('reaches every terminal pipeline state from RECEIVED', () => {
    const reachable = new Set(['RECEIVED']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const state of [...reachable]) {
        for (const next of LIFECYCLE_TRANSITIONS[state as keyof typeof LIFECYCLE_TRANSITIONS]) {
          if (!reachable.has(next)) {
            reachable.add(next);
            grew = true;
          }
        }
      }
    }
    for (const state of LIFECYCLE_STATES) expect(reachable.has(state), state).toBe(true);
    for (const state of TERMINAL_PIPELINE_STATES) expect(reachable.has(state)).toBe(true);
  });

  it('follows the spec order: validate before duplicate check (gap S7)', () => {
    expect(canTransition('VALIDATED', 'DEDUP_CHECKED')).toBe(true);
    expect(canTransition('CLASSIFIED', 'DEDUP_CHECKED')).toBe(false);
    expect(canTransition('SYNCED', 'SYNC_PENDING')).toBe(false);
  });
});

const goodCase: CorpusCase = {
  id: 'in.hdfc_bank.example',
  provenance: 'synthetic',
  country: 'IN',
  institution: 'in.hdfc_bank',
  language: 'en',
  input: { sender: 'VM-HDFCBK', body: 'Rs 10 debited', receivedAt: '2026-09-23T10:00:00+05:30', source: 'android_sms' },
  expected: { terminal: 'CREATED', direction: 'DEBIT', transactionType: 'expense', amount: '10.00', currency: 'INR' },
};

describe('validateCorpusCase', () => {
  it('accepts a well-formed case', () => {
    expect(validateCorpusCase(goodCase)).toEqual([]);
  });

  it.each([
    ['bad id', { ...goodCase, id: 'HDFC-1' }, /id/],
    ['received time without offset', { ...goodCase, input: { ...goodCase.input, receivedAt: '2026-09-23T10:00:00' } }, /UTC offset/],
    ['IGNORED without reason', { ...goodCase, expected: { terminal: 'IGNORED' } }, /reasonCode/],
    ['CREATED without amount', { ...goodCase, expected: { terminal: 'CREATED', direction: 'DEBIT', transactionType: 'expense', currency: 'INR' } }, /amount/],
    ['numeric amount', { ...goodCase, expected: { ...goodCase.expected, amount: 10 } }, /decimal string/],
    ['unknown reason', { ...goodCase, expected: { terminal: 'IGNORED', reasonCode: 'because' } }, /reason code/],
  ])('rejects %s', (_label, value, pattern) => {
    expect(validateCorpusCase(value).join('\n')).toMatch(pattern);
  });
});

describe('compareCorpusResult', () => {
  it('compares only pinned fields; merchant names case-insensitively; missing counts as null', () => {
    expect(
      compareCorpusResult(
        { terminal: 'CREATED', merchantName: 'Local Kirana Store', referenceNumber: null },
        { terminal: 'CREATED', merchantName: 'local kirana store', direction: 'DEBIT' },
      ),
    ).toEqual([]);
  });

  it('reports each mismatch', () => {
    expect(
      compareCorpusResult({ terminal: 'CREATED', amount: '10.00' }, { terminal: 'NEEDS_REVIEW', amount: '10.00' }),
    ).toEqual([{ field: 'terminal', expected: 'CREATED', actual: 'NEEDS_REVIEW' }]);
  });
});

describe('lifecycle helpers (v0.3)', () => {
  it('assertTransition returns the target or throws', async () => {
    const { assertTransition } = await import('../src');
    expect(assertTransition('SYNC_PENDING', 'SYNCED')).toBe('SYNCED');
    expect(() => assertTransition('SYNCED', 'SYNC_PENDING')).toThrow(/SYNCED -> SYNC_PENDING/);
  });

  it('maps every sync result to an allowed transition from SYNC_PENDING', async () => {
    const { lifecycleForSyncResult } = await import('../src');
    const statuses = ['created', 'needs_review', 'already_synced', 'validation_error'] as const;
    for (const status of statuses) {
      expect(canTransition('SYNC_PENDING', lifecycleForSyncResult(status).state)).toBe(true);
    }
    expect(lifecycleForSyncResult('validation_error')).toEqual({ state: 'IGNORED', reason: 'server_rejected', awaitingReview: false });
    expect(lifecycleForSyncResult('needs_review').awaitingReview).toBe(true);
  });
});
