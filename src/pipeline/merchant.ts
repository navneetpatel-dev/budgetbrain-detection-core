import type { PackMerchant } from '../pack/types';
import type { CompiledPack } from './compile';
import { collapseSpaces, isWordChar, nfkc, titleCase, trimChars } from './text';

/** Merchant normalizer and resolver (plan T3.8). */

export type MerchantKind = 'brand' | 'raw' | 'p2p' | 'none';

export interface ResolvedMerchant {
  kind: MerchantKind;
  /** Display name: the brand name, or the cleaned raw name. */
  name: string | null;
  merchantId: string | null;
  merchant: PackMerchant | null;
  /** Normalized key, used for user rules and exclusions. */
  key: string | null;
  fuzzy: boolean;
}

export const NO_MERCHANT: ResolvedMerchant = { kind: 'none', name: null, merchantId: null, merchant: null, key: null, fuzzy: false };

/** Rail and processor prefixes banks put before the merchant (`UPI-`, `POS 1234`, `NEFT-`). */
const RAIL_PREFIX = /^(?:upi|pos|neft|imps|rtgs|ach|sepa|vps|ecom|pur|purchase)[\s/:-]+/i;
/** Legal suffixes removed from display names and keys. "Corp" is kept: it often is the name. */
const LEGAL_SUFFIX = /(?:\s(?:private|pvt\.?|pte\.?))?\s(?:ltd\.?|limited|llp|llc|inc\.?|gmbh|plc|s\.?a\.?|ag|b\.?v\.?)$/i;
const DOMAIN_SUFFIX = /\.(?:com|in|co\.in|net|org|co|io|app)$/i;
/** Store and terminal numbers: `DMART 0423`, `STORE #12`. */
const STORE_NUMBER = /\s(?:#\s?|no\.?\s?|store\s)?\d{2,8}$/i;

export function cleanMerchantName(raw: string): string {
  let name = trimChars(collapseSpaces(nfkc(raw)), ' "\'([', ' "\')].,;:');
  for (let i = 0; i < 3; i += 1) {
    const before = name;
    name = name.replace(RAIL_PREFIX, '').replace(DOMAIN_SUFFIX, '').replace(LEGAL_SUFFIX, '').replace(STORE_NUMBER, '').trim();
    if (name === before) break;
  }
  return name;
}

/** Lowercase, NFKC, punctuation folded to spaces: the key aliases and user rules are stored under. */
export function merchantKey(raw: string): string {
  let folded = '';
  for (const ch of cleanMerchantName(raw).toLowerCase()) folded += isWordChar(ch) || ch === '&' ? ch : ' ';
  return collapseSpaces(folded);
}

function hasLetter(text: string): boolean {
  for (const ch of text) if (isWordChar(ch) && !/\d/.test(ch)) return true;
  return false;
}

/** Jaro-Winkler similarity in [0, 1]. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = Math.max(0, i - window); j < Math.min(b.length, i + window + 1); j += 1) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

function aliasHit(pack: CompiledPack, key: string, country: string | null): PackMerchant | null {
  for (const entry of pack.aliases.get(key) ?? []) {
    if (entry.country && country && entry.country !== country) continue;
    const merchant = pack.merchants.get(entry.merchantId);
    if (merchant) return merchant;
  }
  return null;
}

/**
 * Strict matching: an exact alias for the whole name or its leading words (`amazon pay india`
 * → `amazon pay`), then a fuzzy match only for single-word names with Jaro-Winkler ≥ 0.92, the
 * same first letter and a merchant from the same country or a global brand. Anything else
 * stays the cleaned raw name, never a guessed brand (gap M1).
 */
export function resolveMerchantName(raw: string, pack: CompiledPack, country: string | null): ResolvedMerchant {
  const cleaned = cleanMerchantName(raw);
  const key = merchantKey(raw);
  if (!key || !hasLetter(key)) return NO_MERCHANT;
  const words = key.split(' ');
  for (let n = Math.min(words.length, pack.maxAliasTokens); n >= 1; n -= 1) {
    const hit = aliasHit(pack, words.slice(0, n).join(' '), country);
    if (hit) return { kind: 'brand', name: hit.name, merchantId: hit.id, merchant: hit, key, fuzzy: false };
  }
  if (words.length === 1 && key.length >= 5) {
    for (const [alias, entries] of pack.aliases) {
      if (alias.includes(' ') || alias[0] !== key[0] || jaroWinkler(alias, key) < 0.92) continue;
      for (const entry of entries) {
        const merchant = pack.merchants.get(entry.merchantId);
        if (!merchant) continue;
        if (merchant.country !== null && country !== null && merchant.country !== country) continue;
        return { kind: 'brand', name: merchant.name, merchantId: merchant.id, merchant, key, fuzzy: true };
      }
    }
  }
  return { kind: 'raw', name: titleCase(cleaned), merchantId: null, merchant: null, key, fuzzy: false };
}

/** Words that mark a business rather than a person. */
const BUSINESS_WORDS =
  /\b(?:store|stores|mart|shop|shoppe|market|supermarket|traders?|enterprises?|services?|solutions|technologies|tech|india|corp|corporation|company|co|ltd|limited|pvt|llp|inc|bank|restaurant|cafe|hotel|hospital|pharmacy|medical|petrol|fuel|station|school|college|kirana|bazaar|foods?|retail|online|pay|wallet|insurance|finance|motors|agency|centre|center)\b/i;

/** A counterparty that reads like a person's name: 1–4 alphabetic words, no business words. */
export function looksLikePerson(name: string): boolean {
  const text = collapseSpaces(name);
  if (!text || text.length > 40 || BUSINESS_WORDS.test(text)) return false;
  const words = text.split(' ');
  return (
    words.length <= 4 &&
    words.every((w) => [...w].every((ch, i) => (i === 0 ? isWordChar(ch) && !/\d/.test(ch) : (isWordChar(ch) && !/\d/.test(ch)) || ch === '.' || ch === "'")))
  );
}

/** UPI handles that belong to people rather than merchants: dotted names, phone numbers, `ok…` PSPs. */
export function isPersonalVpa(handle: string, psp: string): boolean {
  return handle.includes('.') || /^\d{10}$/.test(handle) || psp.startsWith('ok');
}
