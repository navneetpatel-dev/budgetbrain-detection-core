import type { NormalizedMessage } from '../types/message';
import type { ReasonCode, TerminalPipelineState } from '../types/lifecycle';
import type { Direction, PaymentMethod, TransactionSubtype, TransactionType } from '../types/transaction';

/**
 * Where a corpus message came from.
 * - `gap_doc`: the 13 sample messages from the gap analysis (§4).
 * - `synthetic`: written from a bank's published alert format with fake values.
 * - `field_anonymized`: a real message with every name, number and reference replaced.
 *
 * Every body must be anonymized: fake names, fake account digits, fake references.
 */
export type CorpusProvenance = 'gap_doc' | 'synthetic' | 'field_anonymized';

/** How the merchant or counterparty should be resolved. */
export type ExpectedMerchantKind = 'brand' | 'raw' | 'p2p' | 'none';

/**
 * Expected pipeline result. Only fields present are compared, so a case can pin just the
 * behaviour it is about (e.g. only `terminal` + `reasonCode` for an OTP message).
 */
export interface CorpusExpectation {
  terminal: TerminalPipelineState;
  reasonCode?: ReasonCode;
  direction?: Direction;
  transactionType?: TransactionType;
  subtype?: TransactionSubtype | null;
  /** Canonical decimal string, e.g. `"1250.00"`. */
  amount?: string;
  currency?: string;
  /** `YYYY-MM-DD`. */
  transactionDate?: string;
  accountTail?: string | null;
  referenceNumber?: string | null;
  institutionId?: string | null;
  merchantKind?: ExpectedMerchantKind;
  /** Expected cleaned merchant or counterparty name (case-insensitive compare). */
  merchantName?: string | null;
  /** Knowledge-base merchant id when `merchantKind` is `brand`. */
  merchantId?: string | null;
  paymentMethod?: PaymentMethod | null;
}

export interface CorpusCase {
  /** Unique, stable id: `<country>.<institution>.<slug>`. */
  id: string;
  provenance: CorpusProvenance;
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** Knowledge-pack institution id, or `unknown` for unknown senders. */
  institution: string;
  /** BCP 47 language of the body. */
  language: string;
  input: NormalizedMessage;
  /** User context the pipeline receives alongside the message (task T3.1 `userCtx`). */
  context?: CorpusUserContext;
  expected: CorpusExpectation;
  /** Why this case exists; link to the gap id when relevant. */
  notes?: string;
  /** Gap ids this case guards, e.g. `["X1"]`. */
  gaps?: string[];
}

export interface CorpusUserContext {
  /** Masked tails of the user's own accounts and cards ("My accounts", task T5.7). */
  ownAccountTails?: string[];
  /** The user's own UPI VPAs / wallet ids. */
  ownVpas?: string[];
}

/** The subset of a pipeline result the corpus compares against. */
export interface CorpusActual {
  terminal: TerminalPipelineState;
  reasonCode?: ReasonCode;
  direction?: Direction;
  transactionType?: TransactionType;
  subtype?: TransactionSubtype | null;
  amount?: string;
  currency?: string;
  transactionDate?: string;
  accountTail?: string | null;
  referenceNumber?: string | null;
  institutionId?: string | null;
  merchantKind?: ExpectedMerchantKind;
  merchantName?: string | null;
  merchantId?: string | null;
  paymentMethod?: PaymentMethod | null;
}

export interface CorpusMismatch {
  field: keyof CorpusExpectation;
  expected: unknown;
  actual: unknown;
}
