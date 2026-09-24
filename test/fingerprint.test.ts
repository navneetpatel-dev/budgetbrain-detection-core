import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeFingerprint, FINGERPRINT_TIME_BUCKET_MS, type FingerprintInput } from '../src';

const base: FingerprintInput = {
  userId: 'user-1',
  institutionId: 'in.hdfc_bank',
  accountTail: '1234',
  amountMinor: 125000,
  currency: 'INR',
  direction: 'DEBIT',
  referenceNumber: '425612345678',
  transactionDate: '2026-09-23',
  receivedAt: '2026-09-23T10:00:00+05:30',
};

describe('computeFingerprint', () => {
  it('is deterministic, versioned and hex', () => {
    const a = computeFingerprint(base);
    expect(a).toBe(computeFingerprint({ ...base }));
    expect(a).toMatch(/^v2_[0-9a-f]{64}$/);
  });

  it('equals SHA-256 of the documented length-prefixed seed (checked with node:crypto)', () => {
    const parts = ['v2', 'user-1', 'in.hdfc_bank', '1234', '125000', 'INR', 'DEBIT', 'ref:425612345678'];
    const seed = parts.map((p) => `${p.length}:${p}`).join('|');
    expect(computeFingerprint(base)).toBe(`v2_${createHash('sha256').update(seed, 'utf8').digest('hex')}`);
  });

  it('matches a known vector so every platform agrees', () => {
    // Recompute only if the identity inputs change on purpose (then bump FINGERPRINT_VERSION).
    expect(computeFingerprint(base)).toMatchInlineSnapshot(`"v2_7505d3daa380fde76953975c3719c66021e2ff8da7897c4ebc0258b0f0301a77"`);
  });

  it('ignores differences that do not change the real transaction', () => {
    const a = computeFingerprint(base);
    expect(computeFingerprint({ ...base, receivedAt: '2026-09-23T11:30:00+05:30' })).toBe(a); // reference wins
    expect(computeFingerprint({ ...base, referenceNumber: '4256 1234 5678' })).toBe(a);
    expect(computeFingerprint({ ...base, accountTail: 'XX1234' })).toBe(a);
    expect(computeFingerprint({ ...base, currency: 'inr' })).toBe(a);
  });

  it('changes when any identity input changes', () => {
    const a = computeFingerprint(base);
    for (const change of [
      { userId: 'user-2' },
      { institutionId: 'in.icici_bank' },
      { accountTail: '9999' },
      { amountMinor: 125001 },
      { currency: 'USD' },
      { direction: 'CREDIT' as const },
      { referenceNumber: '999999999999' },
    ]) {
      expect(computeFingerprint({ ...base, ...change })).not.toBe(a);
    }
  });

  it('falls back to date plus a received-time bucket when there is no reference', () => {
    const noRef = { ...base, referenceNumber: null };
    const bucketStart = Math.floor(Date.parse(base.receivedAt) / FINGERPRINT_TIME_BUCKET_MS) * FINGERPRINT_TIME_BUCKET_MS;
    const sameBucket = new Date(bucketStart + FINGERPRINT_TIME_BUCKET_MS - 1).toISOString();
    const nextBucket = new Date(bucketStart + FINGERPRINT_TIME_BUCKET_MS).toISOString();
    expect(computeFingerprint({ ...noRef, receivedAt: sameBucket })).toBe(computeFingerprint(noRef));
    expect(computeFingerprint({ ...noRef, receivedAt: nextBucket })).not.toBe(computeFingerprint(noRef));
  });

  it('treats too-short references as missing', () => {
    expect(computeFingerprint({ ...base, referenceNumber: '123' })).toBe(
      computeFingerprint({ ...base, referenceNumber: null }),
    );
  });

  it('does not depend on transaction type or merchant (gap D3)', () => {
    // FingerprintInput has no type/merchant fields at all; this guards against adding them back.
    const keys = Object.keys(base).sort();
    expect(keys).not.toContain('transactionType');
    expect(keys).not.toContain('merchantName');
  });

  it('handles non-ASCII input correctly (gap D7)', () => {
    const a = computeFingerprint({ ...base, userId: 'ユーザー', institutionId: 'in.domino’s' });
    expect(a).toMatch(/^v2_[0-9a-f]{64}$/);
    expect(a).not.toBe(computeFingerprint({ ...base, userId: 'ユーザ', institutionId: 'in.domino’s' }));
  });

  it('rejects bad inputs', () => {
    expect(() => computeFingerprint({ ...base, amountMinor: 12.5 })).toThrow(RangeError);
    expect(() => computeFingerprint({ ...base, referenceNumber: null, receivedAt: 'yesterday' })).toThrow(RangeError);
  });
});
