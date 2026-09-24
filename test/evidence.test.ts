import { describe, expect, it } from 'vitest';
import { balanceSign, isAllowedDirectionType, minTier, scoreEvidence, type DetectionEvidence } from '../src';

const strong: DetectionEvidence = {
  templateMatched: false,
  institutionVerified: true,
  amountRoleUnique: true,
  directionUnambiguous: true,
  merchantKnown: false,
  dateExtracted: true,
  referencePresent: true,
  merchantFuzzy: false,
};

describe('scoreEvidence', () => {
  it('is high for a verified bank with a clear amount, direction, date and reference', () => {
    expect(scoreEvidence(strong)).toBe('high');
  });

  it('is high when a template matched even without a reference', () => {
    expect(scoreEvidence({ ...strong, referencePresent: false, dateExtracted: false, templateMatched: true })).toBe('high');
  });

  it('is high with only a date read from the message (salary, interest, cashback alerts)', () => {
    expect(scoreEvidence({ ...strong, referencePresent: false })).toBe('high');
  });

  it('is high with only a reference, when the date fell back to the received time', () => {
    expect(scoreEvidence({ ...strong, dateExtracted: false })).toBe('high');
  });

  it('is high with a known merchant instead of a reference', () => {
    expect(scoreEvidence({ ...strong, referencePresent: false, merchantKnown: true })).toBe('high');
  });

  it.each([
    ['unknown institution', { institutionVerified: false }],
    ['nothing read from the message corroborates it (fallback date, no reference, no known merchant, no template)', { referencePresent: false, dateExtracted: false }],
    ['fuzzy merchant match', { merchantFuzzy: true }],
  ])('drops to medium: %s', (_label, change) => {
    expect(scoreEvidence({ ...strong, ...change })).toBe('medium');
  });

  it.each([
    ['multiple amount candidates', { amountRoleUnique: false }],
    ['ambiguous direction', { directionUnambiguous: false }],
  ])('is low: %s, whatever else is true', (_label, change) => {
    expect(scoreEvidence({ ...strong, templateMatched: true, merchantKnown: true, ...change })).toBe('low');
  });

  it('cannot be pushed to high by a client that only claims a template for an unknown sender', () => {
    expect(scoreEvidence({ ...strong, templateMatched: true, institutionVerified: false })).toBe('medium');
  });
});

describe('minTier', () => {
  it('takes the lower tier', () => {
    expect(minTier('high', 'medium')).toBe('medium');
    expect(minTier('low', 'high')).toBe('low');
    expect(minTier('high', 'high')).toBe('high');
  });
});

describe('isAllowedDirectionType', () => {
  it.each([
    ['DEBIT', 'expense', true],
    ['DEBIT', 'transfer', true],
    ['DEBIT', 'income', false],
    ['DEBIT', 'refund', false],
    ['CREDIT', 'income', true],
    ['CREDIT', 'refund', true],
    ['CREDIT', 'transfer', true],
    ['CREDIT', 'expense', false],
  ] as const)('%s + %s → %s', (direction, type, allowed) => {
    expect(isAllowedDirectionType(direction, type)).toBe(allowed);
  });
});

describe('balanceSign', () => {
  it('adds income and refunds, subtracts expenses', () => {
    expect(balanceSign('income', null)).toBe(1);
    expect(balanceSign('refund', null)).toBe(1);
    expect(balanceSign('expense', null)).toBe(-1);
  });

  it('follows the leg direction for transfers and requires it', () => {
    expect(balanceSign('transfer', 'CREDIT')).toBe(1);
    expect(balanceSign('transfer', 'DEBIT')).toBe(-1);
    expect(() => balanceSign('transfer', null)).toThrow(RangeError);
  });
});
