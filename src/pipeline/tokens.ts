import { isSupportedCurrency, minorUnits } from '../money/currencies';
import type { CompiledPack } from './compile';
import type { PhraseMatcher } from './phraseMatcher';
import { isWordChar, trimChars } from './text';

/** Tokenizer (plan T3.4). Every token keeps its position so roles can be assigned by context. */

export interface MoneyToken {
  start: number;
  end: number;
  currency: string;
  amountMinor: number;
  role: 'amount' | 'balance' | 'limit';
}

export interface AccountToken {
  start: number;
  end: number;
  /** Last 3–4 digits. */
  tail: string;
}

export interface DateToken {
  start: number;
  date: string;
  /** Day and month order was certain (month name, ISO, or a day above 12). */
  certain: boolean;
}

// No lookbehind and bounded quantifiers only: this runs on untrusted text on Hermes too.
const NUMBER = /\d[\d,.']{0,20}/y;
const ISO_CODE = /[A-Z]{3}/y;

/**
 * Turns `1,25,000.00`, `1250.5`, `5,00,000` or `1.234,56` into minor units. The separator that
 * appears last and is followed by 1–3 digits is the decimal point unless it looks like grouping.
 */
export function parseAmount(raw: string, currency: string, decimalHint: '.' | ',' = '.'): number | null {
  const text = trimChars(raw, '', ".,'");
  if (!/^\d/.test(text)) return null;
  const lastDot = text.lastIndexOf('.');
  const lastComma = text.lastIndexOf(',');
  let decimalSep: string | null = null;
  if (lastDot !== -1 && lastComma !== -1) {
    decimalSep = lastDot > lastComma ? '.' : ',';
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? '.' : ',';
    const count = text.split(sep).length - 1;
    const tail = text.length - text.lastIndexOf(sep) - 1;
    if (count === 1 && tail !== 3) decimalSep = sep;
    else if (count === 1 && tail === 3 && sep === decimalHint && minorUnits(currency) === 3) decimalSep = sep;
  }
  let integer = text;
  let fraction = '';
  if (decimalSep) {
    const at = text.lastIndexOf(decimalSep);
    integer = text.slice(0, at);
    fraction = text.slice(at + 1);
  }
  integer = integer.replace(/[.,']/g, '');
  if (!/^\d+$/.test(integer) || !/^\d*$/.test(fraction)) return null;
  const units = minorUnits(currency);
  if (fraction.length > units) {
    // More decimals than the currency has: not a money amount we can trust.
    if (fraction.length > 3) return null;
    fraction = fraction.slice(0, units);
  }
  const minor = Number(integer) * 10 ** units + Number(fraction.padEnd(units, '0') || '0');
  return Number.isSafeInteger(minor) ? minor : null;
}

function readNumberAt(text: string, index: number): { raw: string; end: number } | null {
  NUMBER.lastIndex = index;
  const m = NUMBER.exec(text);
  if (!m) return null;
  const raw = trimChars(m[0], '', ".,'");
  return { raw, end: index + raw.length };
}

function currencyForSymbol(codes: string[], country: string | null, pack: CompiledPack): string {
  if (codes.length === 1 || !country) return codes[0]!;
  // `$` in a Canadian message means CAD when the CA pack lists it; otherwise the first entry.
  for (const code of codes) {
    const currency = pack.currencies.get(code);
    if (currency && pack.countries.includes(country) && currency.ambiguousSymbols?.length) return code;
  }
  return codes[0]!;
}

/** Every money amount in the text, with a balance/limit role when a balance or limit phrase leads it. */
export function findMoney(text: string, pack: CompiledPack, country: string | null): MoneyToken[] {
  const tokens: MoneyToken[] = [];
  let i = 0;
  while (i < text.length) {
    let matched = false;
    // Prefix form: `Rs 1,250.00`, `₹500`, `USD 12.99`.
    for (const { symbol, codes } of pack.symbols) {
      if (!text.startsWith(symbol, i) && text.slice(i, i + symbol.length).toLowerCase() !== symbol.toLowerCase()) continue;
      if (isWordChar(symbol[0]) && isWordChar(text[i - 1])) continue;
      let j = i + symbol.length;
      if (isWordChar(symbol[symbol.length - 1]) && /[A-Z]/i.test(text[j] ?? '')) continue;
      while (text[j] === ' ' || text[j] === ' ') j += 1;
      if (j - (i + symbol.length) > 2) continue;
      const number = readNumberAt(text, j);
      if (!number || /\d/.test(text[number.end] ?? '')) continue;
      const currency = currencyForSymbol(codes, country, pack);
      const minor = parseAmount(number.raw, currency, pack.currencies.get(currency)?.decimalSeparator ?? '.');
      if (minor !== null) {
        tokens.push({ start: i, end: number.end, currency, amountMinor: minor, role: 'amount' });
        i = number.end;
        matched = true;
      }
      break;
    }
    if (matched) continue;
    // Any other ISO 4217 code before a number: `AED 45.00`, `EUR 9,99`.
    ISO_CODE.lastIndex = i;
    const code = !isWordChar(text[i - 1]) ? ISO_CODE.exec(text) : null;
    if (code && isSupportedCurrency(code[0]) && !isWordChar(text[i + 3])) {
      let j = i + 3;
      while (text[j] === ' ') j += 1;
      const number = j - i <= 5 ? readNumberAt(text, j) : null;
      if (number && !/\d/.test(text[number.end] ?? '')) {
        const minor = parseAmount(number.raw, code[0], pack.currencies.get(code[0])?.decimalSeparator ?? '.');
        if (minor !== null) {
          tokens.push({ start: i, end: number.end, currency: code[0], amountMinor: minor, role: 'amount' });
          i = number.end;
          continue;
        }
      }
    }
    i += 1;
  }
  return tokens;
}

/** Text allowed between a balance/limit phrase and its amount: `Avl Bal: Rs`, `balance is Rs`, `limit of`. */
const ROLE_GAP = /^[\s:.\-–]{0,4}(?:is|of|now)?[\s:.\-–]{0,4}$/i;

export function assignRoles(text: string, tokens: MoneyToken[], balance: PhraseMatcher, limit: PhraseMatcher): void {
  const balances = balance.findAll(text);
  const limits = limit.findAll(text);
  for (const token of tokens) {
    const leads = (matches: { end: number }[]) =>
      matches.some((m) => m.end <= token.start && token.start - m.end <= 12 && ROLE_GAP.test(text.slice(m.end, token.start)));
    if (leads(limits)) token.role = 'limit';
    else if (leads(balances)) token.role = 'balance';
  }
}

const MASKED = /[x*•]{1,12} ?(\d{3,6})/gi;

/** Masked account or card numbers: `XX1234`, `**1234`, `*1234`, `X9876`, `xx1111`. */
export function findAccounts(text: string): AccountToken[] {
  const tokens: AccountToken[] = [];
  MASKED.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MASKED.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (isWordChar(text[start - 1]) || /\d/.test(text[end] ?? '')) continue;
    const digits = m[1]!;
    tokens.push({ start, end, tail: digits.length > 4 ? digits.slice(-4) : digits });
  }
  return tokens;
}

const REFERENCE_VALUE = /^\s{0,3}(?:no\.?\s{0,3}|number\s{0,3}|#\s{0,3})?[:.#-]?\s{0,3}([A-Z0-9]{6,24})/i;

/** The first value after a reference marker (`Ref`, `UTR`, `UPI Ref`, `Txn ID`, `UPI:`) with at least 5 digits. */
export function findReference(text: string, markers: PhraseMatcher): string | null {
  for (const marker of markers.findAll(text)) {
    const m = REFERENCE_VALUE.exec(text.slice(marker.end, marker.end + 40));
    if (!m) continue;
    const value = m[1]!;
    if ((value.match(/\d/g)?.length ?? 0) >= 5) return value.toUpperCase();
  }
  return null;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const NUMERIC_DATE = /(\d{1,4})([-/.])(\d{1,2})\2(\d{2,4})/g;
const DAY_MONTH_NAME = /(\d{1,2})[-\s]?([A-Za-z]{3,4})[a-z]{0,6}[-\s,]{1,2}(\d{4}|\d{2})/g;
const MONTH_NAME_DAY = /([A-Za-z]{3,4})[a-z]{0,6}\.? (\d{1,2}),? (\d{4})/g;

function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function fullYear(value: string): number {
  const n = Number(value);
  return value.length === 2 ? 2000 + n : n;
}

/**
 * Calendar dates in the message. Numeric day/month order follows the institution's country
 * (`dateOrder`), then the device locale; `YYYY-MM-DD` and month names are unambiguous. Dates
 * are built from their parts, never through `toISOString()` (gap X1).
 */
export function findDates(text: string, dateOrder: 'DMY' | 'MDY'): DateToken[] {
  const found: DateToken[] = [];
  const bounded = (start: number, end: number) => !/\d/.test(text[start - 1] ?? '') && !/\d/.test(text[end] ?? '');

  NUMERIC_DATE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMERIC_DATE.exec(text)) !== null) {
    if (!bounded(m.index, m.index + m[0].length)) continue;
    const [, a, , b, c] = m as unknown as [string, string, string, string, string];
    let date: string | null = null;
    let certain = false;
    if (a.length === 4) {
      date = isoDate(Number(a), Number(b), Number(c));
      certain = true;
    } else if (c.length === 2 || c.length === 4) {
      const first = Number(a);
      const second = Number(b);
      const year = fullYear(c);
      const dayFirst = dateOrder === 'DMY';
      date = dayFirst ? isoDate(year, second, first) : isoDate(year, first, second);
      certain = first > 12 || second > 12 || first === second;
      if (!date) date = dayFirst ? isoDate(year, first, second) : isoDate(year, second, first);
    }
    if (date) found.push({ start: m.index, date, certain });
  }

  DAY_MONTH_NAME.lastIndex = 0;
  while ((m = DAY_MONTH_NAME.exec(text)) !== null) {
    const month = MONTHS[m[2]!.toLowerCase()];
    if (!month || !bounded(m.index, m.index + m[0].length) || isWordChar(text[m.index + m[0].length])) continue;
    const date = isoDate(fullYear(m[3]!), month, Number(m[1]));
    if (date) found.push({ start: m.index, date, certain: true });
  }

  MONTH_NAME_DAY.lastIndex = 0;
  while ((m = MONTH_NAME_DAY.exec(text)) !== null) {
    const month = MONTHS[m[1]!.toLowerCase()];
    if (!month || isWordChar(text[m.index - 1])) continue;
    const date = isoDate(Number(m[3]), month, Number(m[2]));
    if (date) found.push({ start: m.index, date, certain: true });
  }
  return found.sort((x, y) => x.start - y.start);
}

const VPA = /([A-Z0-9][\w.-]{1,40})@([A-Z][A-Z0-9]{1,20})/gi;

/** UPI VPAs (`swiggy@icici`, `priya.s@okaxis`); email addresses (a dot after the handle) are skipped. */
export function findVpas(text: string): { start: number; end: number; handle: string; psp: string }[] {
  const vpas: { start: number; end: number; handle: string; psp: string }[] = [];
  VPA.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VPA.exec(text)) !== null) {
    const end = m.index + m[0].length;
    if (text[end] === '.' && /[A-Z]/i.test(text[end + 1] ?? '')) continue;
    vpas.push({ start: m.index, end, handle: m[1]!.toLowerCase(), psp: m[2]!.toLowerCase() });
  }
  return vpas;
}
