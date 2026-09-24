/**
 * Where a message or record came from. The pipeline treats every source the same way;
 * only the access layer that produced the message knows the difference (spec §2, §29).
 */
export const MESSAGE_SOURCES = [
  'android_sms',
  'notification',
  'email',
  'pasted_sms',
  'csv',
  'ofx',
  'qif',
  'mt940',
  'camt053',
  'open_banking',
  'bank_api',
] as const;
export type MessageSource = (typeof MESSAGE_SOURCES)[number];

/**
 * The normalized input to the pipeline (spec §4). Access layers (native SMS receiver,
 * notification listener, email worker, file import) convert to this shape and nothing else.
 */
export interface NormalizedMessage {
  /** Stable id from the source (SMS `_id`, email Message-ID, import row hash). */
  id?: string;
  /** Sender address or header exactly as received, e.g. `VM-HDFCBK`, `+14155550100`, `alerts@bank.com`. */
  sender: string;
  /** Message text. Never logged, never uploaded (spec §22). */
  body: string;
  /** ISO 8601 timestamp with offset, e.g. `2026-09-23T10:00:00+05:30`. */
  receivedAt: string;
  source: MessageSource;
  /** 1-based SIM slot for SMS on dual-SIM devices. */
  simSlot?: number;
  /** Android package name for notification sources. */
  appPackage?: string;
  /** BCP 47 locale of the device, used as a fallback for date order and number format. */
  deviceLocale?: string;
}

/** @deprecated Use {@link NormalizedMessage}. Kept so the mobile app can migrate incrementally. */
export type RawIncomingMessage = NormalizedMessage;
