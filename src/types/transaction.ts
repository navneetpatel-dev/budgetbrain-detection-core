import type { MessageSource } from './message';

/** Money movement relative to the user's account (spec §7). */
export const DIRECTIONS = ['DEBIT', 'CREDIT'] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** Financial meaning, kept separate from direction (spec §8, decision D-1). */
export const TRANSACTION_TYPES = ['expense', 'income', 'refund', 'transfer'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

/** Finer classification stored alongside the type (gap C3). */
export const TRANSACTION_SUBTYPES = [
  'cashback',
  'reversal',
  'card_bill',
  'p2p',
  'self_transfer',
  'wallet_topup',
] as const;
export type TransactionSubtype = (typeof TRANSACTION_SUBTYPES)[number];

/**
 * Payment rail. `card`, `upi`, `bank_transfer`, `cash` and `other` match the backend
 * `transactions.payment_method` values; `wallet` is mapped to `other` until the backend enum is extended.
 */
export const PAYMENT_METHODS = ['card', 'upi', 'bank_transfer', 'wallet', 'cash', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Server-side status of a detected transaction record. */
export const DETECTION_STATUSES = [
  'auto_approved',
  'pending_review',
  'user_confirmed',
  'rejected',
  'duplicate',
] as const;
export type DetectionStatus = (typeof DETECTION_STATUSES)[number];

export const CONFIDENCE_TIERS = ['high', 'medium', 'low'] as const;
export type ConfidenceTier = (typeof CONFIDENCE_TIERS)[number];

/** Per-field reliability (spec §13, gap M2). */
export type FieldReliability = 'high' | 'medium' | 'low';

/**
 * Facts the pipeline observed. The backend recomputes the tier from these flags instead of
 * trusting a client-sent score (gap F3, task T1.5).
 */
export interface DetectionEvidence {
  /** Message matched a published template for its institution. */
  templateMatched: boolean;
  templateId?: string;
  /** Sender resolved to a verified institution in the knowledge pack. */
  institutionVerified: boolean;
  /** Exactly one money token qualified as the transaction amount. */
  amountRoleUnique: boolean;
  /** Direction came from unambiguous wording. */
  directionUnambiguous: boolean;
  /** Merchant matched the knowledge base (not just any extracted string). */
  merchantKnown: boolean;
  /** Date was read from the message rather than falling back to the received time. */
  dateExtracted: boolean;
  referencePresent: boolean;
  /** Merchant came from a fuzzy match (penalised). */
  merchantFuzzy: boolean;
}

/** Normalized transaction produced by the pipeline, before persistence. */
export interface DetectedCandidate {
  /** Integer amount in the currency's minor units (paise, cents). Never a float. */
  amountMinor: number;
  /** ISO 4217 code. */
  currency: string;
  direction: Direction;
  transactionType: TransactionType;
  subtype: TransactionSubtype | null;
  paymentMethod: PaymentMethod | null;
  institutionId: string | null;
  /** Last 3–4 digits of the account or card. */
  accountTail: string | null;
  referenceNumber: string | null;
  /** Cleaned merchant or counterparty name (never raw message text). */
  merchantName: string | null;
  /** Knowledge-base merchant id when matched. */
  merchantId: string | null;
  /** Standard taxonomy code (spec §16, gap-doc §6.9). */
  taxonomyCode: string | null;
  /** User category id, when a user rule or mapping resolved it. */
  categoryId: string | null;
  /** Calendar date `YYYY-MM-DD` in the institution's local time. */
  transactionDate: string;
  confidenceTier: ConfidenceTier;
  reliability: {
    amount: FieldReliability;
    date: FieldReliability;
    direction: FieldReliability;
    merchant: FieldReliability;
  };
  evidence: DetectionEvidence;
  source: MessageSource;
  fingerprint: string;
  /** Local ids when the classifier linked this to other records (transfer pairs, refund-of). */
  transferGroupKey?: string;
  refundOfTransactionId?: string;
}

/**
 * Wire format for `POST /detected-transactions/sync` (task T1.6).
 * Money is a decimal string so no side ever uses floats.
 */
export interface SyncItemPayload {
  clientId: string;
  amount: string;
  currency: string;
  direction: Direction;
  transactionType: TransactionType;
  subtype: TransactionSubtype | null;
  paymentMethod: PaymentMethod | null;
  institutionId: string | null;
  accountTail: string | null;
  referenceNumber: string | null;
  merchantName: string | null;
  merchantId: string | null;
  taxonomyCode: string | null;
  categoryId: string | null;
  /** `user` when the user explicitly picked the category for this item (task T1.9). */
  categorySource: 'user' | 'rule' | 'knowledge_base' | 'context' | 'fallback' | null;
  financialAccountId: string | null;
  transactionDate: string;
  evidence: DetectionEvidence;
  confidenceTier: ConfidenceTier;
  dedupFingerprint: string;
  source: MessageSource;
}

export type SyncItemResultStatus = 'created' | 'needs_review' | 'already_synced' | 'validation_error';

export interface SyncItemResult {
  clientId: string;
  fingerprint: string;
  status: SyncItemResultStatus;
  detectedId?: string;
  transactionId?: string | null;
  error?: string;
}
