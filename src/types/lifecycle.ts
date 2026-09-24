import type { SyncItemResultStatus } from './transaction';

/**
 * Local lifecycle of a message through the pipeline (spec §24, task T2.10).
 * Only the state and a reason code are stored; never the message text.
 */
export const LIFECYCLE_STATES = [
  'RECEIVED',
  'ELIGIBLE',
  'PARSED',
  'CLASSIFIED',
  'VALIDATED',
  'DEDUP_CHECKED',
  'CREATED',
  'SYNC_PENDING',
  'SYNCED',
  'NEEDS_REVIEW',
  'PARSE_FAILED',
  'DUPLICATE',
  'INELIGIBLE',
  'IGNORED',
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/** States a processed message can finish the pipeline in (before sync). */
export const TERMINAL_PIPELINE_STATES = ['CREATED', 'NEEDS_REVIEW', 'IGNORED'] as const;
export type TerminalPipelineState = (typeof TERMINAL_PIPELINE_STATES)[number];

/**
 * Allowed transitions. `IGNORED` is reached from the failure side states;
 * `NEEDS_REVIEW` can be reached from any stage that found ambiguity.
 */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  RECEIVED: ['ELIGIBLE', 'INELIGIBLE'],
  ELIGIBLE: ['PARSED', 'PARSE_FAILED'],
  PARSED: ['CLASSIFIED', 'NEEDS_REVIEW', 'PARSE_FAILED'],
  CLASSIFIED: ['VALIDATED', 'NEEDS_REVIEW', 'PARSE_FAILED'],
  VALIDATED: ['DEDUP_CHECKED', 'DUPLICATE', 'NEEDS_REVIEW'],
  DEDUP_CHECKED: ['CREATED', 'NEEDS_REVIEW', 'IGNORED'],
  CREATED: ['SYNC_PENDING'],
  NEEDS_REVIEW: ['SYNC_PENDING', 'IGNORED'],
  SYNC_PENDING: ['SYNCED', 'SYNC_PENDING', 'IGNORED'],
  SYNCED: [],
  PARSE_FAILED: ['IGNORED'],
  DUPLICATE: ['IGNORED'],
  INELIGIBLE: ['IGNORED'],
  IGNORED: [],
};

export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

/** Throws when `from -> to` is not an allowed transition. Returns `to` so callers can assign it. */
export function assertTransition(from: LifecycleState, to: LifecycleState): LifecycleState {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid lifecycle transition ${from} -> ${to}`);
  }
  return to;
}

/**
 * Why a message ended where it did. Used for local diagnostics counters and the
 * privacy-safe daily upload (task T7.1). Codes are stable: add new ones, never rename.
 */
export const REASON_CODES = [
  // Eligibility
  'unknown_sender',
  'otp_marker',
  'promo_marker',
  'non_transaction_notice',
  'failed_or_declined',
  'future_or_request',
  'no_money_token',
  'no_movement_wording',
  'kill_switch',
  'excluded_merchant',
  'excluded_account',
  'sim_filtered',
  // Parsing
  'no_amount',
  'multiple_amounts',
  'ambiguous_direction',
  'unparseable_date',
  'unsupported_currency',
  // Classification / confidence
  'low_confidence',
  'medium_confidence',
  'unknown_type',
  // Validation
  'invalid_amount',
  'invalid_date',
  'future_date',
  // Duplicates
  'duplicate_fingerprint',
  'possible_manual_duplicate',
  // Success
  'auto_created',
  // Sync
  'server_rejected',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface SyncOutcome {
  state: Extract<LifecycleState, 'SYNCED' | 'IGNORED'>;
  reason: ReasonCode | null;
  /** The server kept the item for the user to review (it lives in the server review queue). */
  awaitingReview: boolean;
}

/**
 * Where a SYNC_PENDING item goes once the server answers for it. Review happens on the
 * server, so `needs_review` is still SYNCED locally; a rejected item is never retried.
 */
export function lifecycleForSyncResult(status: SyncItemResultStatus): SyncOutcome {
  switch (status) {
    case 'created':
      return { state: 'SYNCED', reason: 'auto_created', awaitingReview: false };
    case 'needs_review':
      return { state: 'SYNCED', reason: null, awaitingReview: true };
    case 'already_synced':
      return { state: 'SYNCED', reason: 'duplicate_fingerprint', awaitingReview: false };
    case 'validation_error':
      return { state: 'IGNORED', reason: 'server_rejected', awaitingReview: false };
  }
}
