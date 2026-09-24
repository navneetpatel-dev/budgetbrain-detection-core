import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Direction } from '../types/transaction';
import { utf8Bytes } from '../utf8';

export { utf8Bytes };

/** Bump when the identity inputs change; stored as a prefix so old and new never collide. */
export const FINGERPRINT_VERSION = 'v2';

/**
 * When a message has no reference number, identity falls back to the calendar date plus the
 * time the message was received, rounded down to this bucket. SMS and push alerts for the
 * same transaction usually arrive within seconds; a bucket boundary can still split them, and
 * the manual-duplicate matcher (task T3.12) catches that case as a review item.
 */
export const FINGERPRINT_TIME_BUCKET_MS = 15 * 60 * 1000;

export interface FingerprintInput {
  userId: string;
  /** Knowledge-base institution id; `null` when the sender is unknown. */
  institutionId: string | null;
  accountTail: string | null;
  amountMinor: number;
  currency: string;
  direction: Direction;
  referenceNumber: string | null;
  /** Calendar date `YYYY-MM-DD`. */
  transactionDate: string;
  /** ISO 8601 received time; only used when there is no reference number. */
  receivedAt: string;
}

/**
 * Stable identity for one real-world transaction (spec §19, task T3.11).
 *
 * Transaction type and merchant are deliberately excluded: they come from classification,
 * which can change between parser versions or between an SMS and a push notification for the
 * same payment (gap D3). The inputs are things the bank states directly.
 */
export function computeFingerprint(input: FingerprintInput): string {
  if (!Number.isSafeInteger(input.amountMinor)) {
    throw new RangeError('amountMinor must be a safe integer');
  }
  const reference = normalizeReference(input.referenceNumber);
  const timeKey = reference
    ? `ref:${reference}`
    : `dt:${input.transactionDate}:${receivedBucket(input.receivedAt)}`;
  const parts = [
    FINGERPRINT_VERSION,
    input.userId,
    input.institutionId ?? '-',
    normalizeTail(input.accountTail),
    String(input.amountMinor),
    input.currency.toUpperCase(),
    input.direction,
    timeKey,
  ];
  // Length-prefixing each part makes the encoding unambiguous even if a part contains the separator.
  const seed = parts.map((part) => `${part.length}:${part}`).join('|');
  return `${FINGERPRINT_VERSION}_${bytesToHex(sha256(utf8Bytes(seed)))}`;
}

function normalizeReference(reference: string | null): string | null {
  if (!reference) return null;
  const cleaned = reference.replace(/[^0-9a-z]/gi, '').toUpperCase();
  return cleaned.length >= 6 ? cleaned : null;
}

function normalizeTail(tail: string | null): string {
  if (!tail) return '-';
  const digits = tail.replace(/\D/g, '');
  return digits ? digits.slice(-4) : '-';
}

function receivedBucket(receivedAt: string): string {
  const ms = Date.parse(receivedAt);
  if (Number.isNaN(ms)) {
    throw new RangeError(`Invalid receivedAt: ${receivedAt}`);
  }
  return String(Math.floor(ms / FINGERPRINT_TIME_BUCKET_MS));
}

