import type { LifecycleState, ReasonCode, TerminalPipelineState } from '../types/lifecycle';
import type { DetectedCandidate, Direction, TransactionType } from '../types/transaction';
import type { MerchantKind } from './merchant';

/** A digest of one recent transaction, used for manual-duplicate, refund-of and transfer pairing. */
export interface RecentTransaction {
  id: string;
  amountMinor: number;
  currency: string;
  direction: Direction;
  transactionType: TransactionType;
  /** `YYYY-MM-DD`. */
  date: string;
  source: 'manual' | 'detected';
  merchantId?: string | null;
  /** Normalized merchant key (`merchantKey`). */
  merchantKey?: string | null;
  accountTail?: string | null;
}

export interface MerchantRule {
  categoryId: string;
  taxonomyCode?: string | null;
}

/**
 * What the pipeline knows about the user (plan T3.1). Plain data: the caller loads it from its
 * own store, so the pipeline never touches Redux, SQLite or the network.
 */
export interface UserContext {
  userId: string;
  /** Masked tails of the user's own accounts and cards ("My accounts"). */
  ownAccountTails?: readonly string[];
  /** The user's own UPI VPAs / wallet ids. */
  ownVpas?: readonly string[];
  /** Learned rules, keyed by `merchantKey`. */
  merchantRules?: Readonly<Record<string, MerchantRule>>;
  /** Last 30–90 days, newest first. */
  recentTransactions?: readonly RecentTransaction[];
  /** Merchant keys and account tails the user excluded from detection. */
  excludedMerchants?: readonly string[];
  excludedAccountTails?: readonly string[];
  /** Keep only this 1-based SIM slot; null or omitted keeps all. */
  simSlot?: number | null;
  /** BCP 47, the fallback for date order when the institution's country is unknown. */
  deviceLocale?: string;
}

export interface PipelineResult {
  terminal: TerminalPipelineState;
  /** The state the message reached before its terminal: INELIGIBLE, PARSE_FAILED, DUPLICATE, … */
  stage: LifecycleState;
  reasonCode: ReasonCode;
  institutionId: string | null;
  /** Present for CREATED and NEEDS_REVIEW. */
  candidate: DetectedCandidate | null;
  merchantKind: MerchantKind;
}
