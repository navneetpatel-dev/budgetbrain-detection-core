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
  SYNC_PENDING: ['SYNCED', 'SYNC_PENDING'],
  SYNCED: [],
  PARSE_FAILED: ['IGNORED'],
  DUPLICATE: ['IGNORED'],
  INELIGIBLE: ['IGNORED'],
  IGNORED: [],
};

export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  return LIFECYCLE_TRANSITIONS[from].includes(to);
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
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
