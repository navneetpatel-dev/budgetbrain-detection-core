import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { LEXICON_CLASSES } from '../pack/types';
import type { NormalizedMessage } from '../types/message';
import { utf8Bytes } from '../utf8';
import type { CompiledPack } from './compile';
import { resolveSender } from './sender';
import { MAX_BODY_CHARS, collapseSpaces, isWordChar, nfkc, trimChars } from './text';
import { findAccounts, findMoney, findVpas } from './tokens';

/**
 * Message skeletons for opt-in template learning (plan T7.4, spec §6.6).
 *
 * A skeleton is the message with everything personal replaced by placeholders, in the same
 * `<AMT>`, `<ACCT>`, `<DATE>` … syntax as pack templates, so an admin can publish it as a
 * template after mapping its fields. It is built with an allowlist: only words that are
 * structural (the pack's lexicon phrases, institution names and a fixed set of connectives)
 * survive; every other
 * word becomes `<NAME>` and every other number `<NUM>`. Merchant and person names therefore
 * never leave the device, even when the parser didn't recognise them.
 *
 * The hash groups the same shape across users (k-anonymity is counted on it server-side).
 * Like the rest of the parser, no regex here uses lookbehind or `\p{…}` classes (Hermes).
 */

export interface MessageSkeleton {
  skeleton: string;
  /** sha256 hex of the lower-cased skeleton. */
  hash: string;
  institutionId: string | null;
  /** SMS header, email domain or app package the institution was resolved from. */
  senderKey: string;
}

/** Connectives and bank vocabulary that carry the shape of a message but nothing personal. */
const STRUCTURAL_WORDS = new Set(
  (
    'a an the of on at to from by via for with in into is was has have been be your you yours our we ' +
    'and or not no if call sms send dear customer team bank thank thanks please kindly ' +
    'account acct ac a/c card credit debit debited credited spent paid received sent transferred withdrawn deposited ' +
    'txn transaction trf transfer ref reference no number id utr rrn upi imps neft rtgs atm pos ecom online ' +
    'inr rs usd eur gbp aed sgd amt amount avl available bal balance limit total due min minimum ' +
    'info towards using vpa wallet cash emi auto pay autopay mandate refund reversal reversed cashback ' +
    'dated date time today yesterday block blocked report fraud helpline is are its it this that'
  ).split(' ')
);

/** Words of a phrase; `a/c` stays one word. */
function splitWords(text: string): string[] {
  const words: string[] = [];
  let word = '';
  for (const ch of text) {
    if (isWordChar(ch) || (ch === '/' && word)) {
      word += ch;
    } else if (word) {
      words.push(word);
      word = '';
    }
  }
  if (word) words.push(word);
  return words;
}

const allowlists = new WeakMap<CompiledPack, Set<string>>();

function allowlist(pack: CompiledPack): Set<string> {
  let words = allowlists.get(pack);
  if (!words) {
    words = new Set(STRUCTURAL_WORDS);
    // Institution names are public, and templates keep them as literal text.
    for (const institution of pack.institutions.values()) {
      for (const word of splitWords(`${institution.name} ${institution.displayName ?? ''}`)) {
        if (!/\d/.test(word)) words.add(word.toLowerCase());
      }
    }
    for (const cls of LEXICON_CLASSES) {
      for (const phrase of pack.lexicon[cls]?.phrases ?? []) {
        for (const word of splitWords(phrase)) if (!/\d/.test(word)) words.add(word.toLowerCase());
      }
    }
    allowlists.set(pack, words);
  }
  return words;
}

/**
 * Masks one stretch of text that no token pattern claimed: numbers become `<NUM>`, words that
 * aren't structural become `<NAME>`, punctuation and spacing stay.
 */
function maskPlain(segment: string, allowed: Set<string>): string {
  let out = '';
  let i = 0;
  while (i < segment.length) {
    if (!isWordChar(segment[i])) {
      out += segment[i];
      i += 1;
      continue;
    }
    let j = i;
    while (
      j < segment.length &&
      (isWordChar(segment[j]) || ((segment[j] === '/' || segment[j] === "'") && isWordChar(segment[j + 1])))
    ) {
      j += 1;
    }
    const word = segment.slice(i, j);
    out += /\d/.test(word) ? '<NUM>' : allowed.has(word.toLowerCase()) ? word : '<NAME>';
    i = j;
  }
  return out;
}

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
const PATTERNS: { placeholder: string; regex: RegExp }[] = [
  {
    placeholder: 'DATE',
    regex: new RegExp(
      `\\b(?:\\d{1,4}[-/.]\\d{1,2}[-/.]\\d{2,4}|\\d{1,2}[-\\s]?${MONTH}[-\\s,]*\\d{2,4}|${MONTH}\\s+\\d{1,2},?\\s+\\d{2,4}|\\d{1,2}[-/]${MONTH})\\b`,
      'gi'
    ),
  },
  { placeholder: 'TIME', regex: /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?m\.?)?/gi },
  // Long or mixed letter/digit tokens: references, UTRs, card or order ids.
  { placeholder: 'REF', regex: /\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{6,}\b|\b\d{9,}\b/gi },
];

interface Span {
  start: number;
  end: number;
  placeholder: string;
}

/** Links and email addresses (a dot after the `@`), found by scanning whitespace-separated tokens. */
function linkSpans(text: string): Span[] {
  const spans: Span[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === ' ') {
      i += 1;
      continue;
    }
    let j = i;
    while (j < text.length && text[j] !== ' ') j += 1;
    const token = trimChars(text.slice(i, j), '', '.,;:)');
    const lower = token.toLowerCase();
    const at = token.indexOf('@');
    const isLink = lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('www.');
    const isEmail = at > 0 && token.indexOf('.', at) > at + 1;
    if (isLink || isEmail) spans.push({ start: i, end: i + token.length, placeholder: 'TEXT' });
    i = j;
  }
  return spans;
}

export function buildSkeleton(
  message: Pick<NormalizedMessage, 'sender' | 'body' | 'source'>,
  pack: CompiledPack
): MessageSkeleton | null {
  const text = collapseSpaces(nfkc(message.body)).slice(0, MAX_BODY_CHARS);
  if (!text) return null;
  const sender = resolveSender(message.sender, message.source, pack);
  const country = sender.institutionId ? (pack.institutions.get(sender.institutionId)?.country ?? null) : null;

  // Links and emails first (a VPA-looking `name@bank.com` is an email), then the parser's own
  // tokens, so they win a tie with the generic patterns below.
  const spans: Span[] = linkSpans(text);
  for (const account of findAccounts(text)) spans.push({ start: account.start, end: account.end, placeholder: 'ACCT' });
  for (const vpa of findVpas(text)) spans.push({ start: vpa.start, end: vpa.end, placeholder: 'VPA' });
  for (const money of findMoney(text, pack, country)) {
    // Only the number: templates keep the currency as literal text (`Rs.<AMT>`).
    const digits = /\d[\d,.']*\d|\d/.exec(text.slice(money.start, money.end));
    if (digits) spans.push({ start: money.start + digits.index, end: money.start + digits.index + digits[0].length, placeholder: 'AMT' });
  }
  for (const { placeholder, regex } of PATTERNS) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) spans.push({ start: m.index, end: m.index + m[0].length, placeholder });
  }

  // Earliest first, longest first (stable, so a tie keeps the parser's token); a span that
  // overlaps one already kept is dropped.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Span[] = [];
  for (const span of spans) {
    const last = kept[kept.length - 1];
    if (last && span.start < last.end) continue;
    kept.push(span);
  }

  const words = allowlist(pack);
  let out = '';
  let at = 0;
  for (const span of kept) {
    out += maskPlain(text.slice(at, span.start), words) + `<${span.placeholder}>`;
    at = span.end;
  }
  out += maskPlain(text.slice(at), words);

  const skeleton = collapseSpaces(out.replace(/<NAME>(?:[ &.,'-]*<NAME>)+/g, '<NAME>'));
  return {
    skeleton,
    hash: bytesToHex(sha256(utf8Bytes(skeleton.toLowerCase()))),
    institutionId: sender.institutionId,
    senderKey: sender.key,
  };
}
