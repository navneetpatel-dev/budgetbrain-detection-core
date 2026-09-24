import type { ConfidenceTier, DetectionEvidence, Direction, TransactionType } from '../types/transaction';

const TIER_RANK: Readonly<Record<ConfidenceTier, number>> = { low: 0, medium: 1, high: 2 };

/**
 * Confidence tier from observed facts (spec §18, plan tasks T1.5 and T3.10).
 *
 * The backend calls this on the evidence a client sends instead of trusting a client score,
 * and the device calls it too, so both sides agree. It is deliberately conservative:
 *
 * - **high** (may be auto-created): a verified institution, exactly one amount candidate,
 *   unambiguous direction, no fuzzy merchant match, and at least one corroborating fact read
 *   from the message itself: a matched template, a date, a reference number or a known
 *   merchant. A date that fell back to the received time is not corroboration (gap F1).
 * - **medium** (needs review): the amount and direction are clear but something is missing.
 * - **low** (never created): the amount or the direction is not clear.
 */
export function scoreEvidence(evidence: DetectionEvidence): ConfidenceTier {
  if (!evidence.amountRoleUnique || !evidence.directionUnambiguous) {
    return 'low';
  }
  const corroborated =
    evidence.templateMatched || evidence.dateExtracted || evidence.referencePresent || evidence.merchantKnown;
  if (evidence.institutionVerified && corroborated && !evidence.merchantFuzzy) {
    return 'high';
  }
  return 'medium';
}

/** The lower of two tiers. Use it to combine a client-claimed tier with the server's own. */
export function minTier(a: ConfidenceTier, b: ConfidenceTier): ConfidenceTier {
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}

/**
 * Which transaction types each direction can carry (spec §7–12, plan task T1.4).
 * Money leaving can only be an expense or a transfer; money arriving can be income, a refund
 * or a transfer. Anything else is a classification bug and must be rejected, not stored.
 */
export const ALLOWED_TYPES_BY_DIRECTION: Readonly<Record<Direction, readonly TransactionType[]>> = {
  DEBIT: ['expense', 'transfer'],
  CREDIT: ['income', 'refund', 'transfer'],
};

export function isAllowedDirectionType(direction: Direction, type: TransactionType): boolean {
  return ALLOWED_TYPES_BY_DIRECTION[direction].includes(type);
}

/**
 * Effect of a transaction on its account balance: +1 adds, -1 subtracts.
 * Transfers need the direction of this leg; every other type implies it.
 */
export function balanceSign(type: TransactionType, direction: Direction | null): 1 | -1 {
  switch (type) {
    case 'income':
    case 'refund':
      return 1;
    case 'expense':
      return -1;
    case 'transfer':
      if (!direction) throw new RangeError('A transfer needs a direction to affect a balance');
      return direction === 'CREDIT' ? 1 : -1;
  }
}
