import { REASON_CODES, TERMINAL_PIPELINE_STATES } from '../types/lifecycle';
import { MESSAGE_SOURCES } from '../types/message';
import { DIRECTIONS, PAYMENT_METHODS, TRANSACTION_SUBTYPES, TRANSACTION_TYPES } from '../types/transaction';
import { isSupportedCurrency } from '../money/currencies';
import type { CorpusActual, CorpusCase, CorpusExpectation, CorpusMismatch } from './types';

const CASE_INSENSITIVE_FIELDS: ReadonlySet<keyof CorpusExpectation> = new Set(['merchantName']);

/** Compares only the fields the case pins down. */
export function compareCorpusResult(expected: CorpusExpectation, actual: CorpusActual): CorpusMismatch[] {
  const mismatches: CorpusMismatch[] = [];
  for (const field of Object.keys(expected) as (keyof CorpusExpectation)[]) {
    const want = expected[field];
    const got = actual[field];
    // A missing actual field counts as null, so `expected: null` matches "not extracted".
    const equal = CASE_INSENSITIVE_FIELDS.has(field)
      ? normalizeText(want) === normalizeText(got)
      : want === (got === undefined ? null : got);
    if (!equal) mismatches.push({ field, expected: want, actual: got });
  }
  return mismatches;
}

function normalizeText(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : (value ?? null);
}

/** Validates the shape of a corpus case file. Returns problems; empty means valid. */
export function validateCorpusCase(value: unknown, file = 'case'): string[] {
  const errors: string[] = [];
  const err = (path: string, message: string) => errors.push(`${file} ${path}: ${message}`);
  if (typeof value !== 'object' || value === null) return [`${file}: must be an object`];
  const c = value as Partial<CorpusCase> & Record<string, unknown>;

  if (typeof c.id !== 'string' || !/^[a-z]{2}\.[a-z0-9_]+\.[a-z0-9_]+$/.test(c.id)) {
    err('id', 'must look like <country>.<institution>.<slug> in lowercase');
  }
  if (!['gap_doc', 'synthetic', 'field_anonymized'].includes(String(c.provenance))) err('provenance', 'unknown');
  if (typeof c.country !== 'string' || !/^[A-Z]{2}$/.test(c.country)) err('country', 'must be ISO alpha-2');
  if (typeof c.institution !== 'string' || c.institution.length === 0) err('institution', 'required');
  if (typeof c.language !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(c.language)) err('language', 'BCP 47');

  const input = c.input as Record<string, unknown> | undefined;
  if (!input || typeof input !== 'object') {
    err('input', 'required');
  } else {
    if (typeof input.sender !== 'string' || input.sender.length === 0) err('input.sender', 'required');
    if (typeof input.body !== 'string' || input.body.length === 0) err('input.body', 'required');
    if (typeof input.receivedAt !== 'string' || Number.isNaN(Date.parse(input.receivedAt))) {
      err('input.receivedAt', 'must be ISO 8601');
    } else if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(input.receivedAt)) {
      err('input.receivedAt', 'must include a UTC offset so date tests are timezone-independent');
    }
    if (!(MESSAGE_SOURCES as readonly string[]).includes(String(input.source))) err('input.source', 'unknown source');
  }

  const e = c.expected as Record<string, unknown> | undefined;
  if (!e || typeof e !== 'object') {
    err('expected', 'required');
    return errors;
  }
  if (!(TERMINAL_PIPELINE_STATES as readonly string[]).includes(String(e.terminal))) err('expected.terminal', 'unknown');
  if (e.reasonCode !== undefined && !(REASON_CODES as readonly string[]).includes(String(e.reasonCode))) {
    err('expected.reasonCode', 'unknown reason code');
  }
  if (e.direction !== undefined && !(DIRECTIONS as readonly string[]).includes(String(e.direction))) err('expected.direction', 'unknown');
  if (e.transactionType !== undefined && !(TRANSACTION_TYPES as readonly string[]).includes(String(e.transactionType))) {
    err('expected.transactionType', 'unknown');
  }
  if (e.subtype !== undefined && e.subtype !== null && !(TRANSACTION_SUBTYPES as readonly string[]).includes(String(e.subtype))) {
    err('expected.subtype', 'unknown');
  }
  if (e.paymentMethod !== undefined && e.paymentMethod !== null && !(PAYMENT_METHODS as readonly string[]).includes(String(e.paymentMethod))) {
    err('expected.paymentMethod', 'unknown');
  }
  if (e.amount !== undefined && (typeof e.amount !== 'string' || !/^\d+(?:\.\d+)?$/.test(e.amount))) {
    err('expected.amount', 'must be a decimal string');
  }
  if (e.currency !== undefined && !isSupportedCurrency(String(e.currency))) err('expected.currency', 'unknown currency');
  if (e.transactionDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(e.transactionDate))) {
    err('expected.transactionDate', 'must be YYYY-MM-DD');
  }
  if (e.merchantKind !== undefined && !['brand', 'raw', 'p2p', 'none'].includes(String(e.merchantKind))) {
    err('expected.merchantKind', 'unknown');
  }
  if (e.terminal === 'CREATED' || e.terminal === 'NEEDS_REVIEW') {
    for (const field of ['direction', 'transactionType', 'amount', 'currency']) {
      if (e[field] === undefined && e.reasonCode === undefined) {
        err(`expected.${field}`, 'required for CREATED/NEEDS_REVIEW cases unless a reasonCode pins the behaviour');
      }
    }
  }
  if (e.terminal === 'IGNORED' && e.reasonCode === undefined) err('expected.reasonCode', 'required for IGNORED cases');
  return errors;
}
