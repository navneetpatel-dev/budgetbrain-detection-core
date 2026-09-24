import { minorUnits } from './currencies';

/**
 * Integer minor units stay exact up to Number.MAX_SAFE_INTEGER (≈ 9.0e15), i.e. 90 trillion
 * in a 2-decimal currency — far above any single retail transaction. Beyond that we refuse
 * rather than lose precision.
 */
const MAX_MINOR = Number.MAX_SAFE_INTEGER;

const DECIMAL_PATTERN = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * Parses a canonical decimal string (`"1250.5"`, `"1250.00"`, `"0.075"`) into integer minor units.
 * This is the wire and database format; locale formats such as `1.234,56` or `12,34,567.00`
 * are handled by the tokenizer (task T3.4), not here.
 *
 * Numbers are accepted for backwards compatibility with existing API responses, but they are
 * converted through their shortest string form, so pass strings whenever you can.
 */
export function parseDecimalToMinor(value: string | number, currency: string): number {
  const text = typeof value === 'number' ? numberToPlainString(value) : value.trim();
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) {
    throw new TypeError(`Not a decimal amount: ${JSON.stringify(value)}`);
  }
  const [, sign, whole = '', fraction = ''] = match;
  const units = minorUnits(currency);
  if (fraction.length > units && /[1-9]/.test(fraction.slice(units))) {
    throw new RangeError(`${currency} allows ${units} decimal places, got ${JSON.stringify(value)}`);
  }
  const paddedFraction = fraction.slice(0, units).padEnd(units, '0');
  const digits = `${whole}${paddedFraction}`.replace(/^0+(?=\d)/, '');
  const minor = Number(digits);
  if (!Number.isSafeInteger(minor) || minor > MAX_MINOR) {
    throw new RangeError(`Amount too large: ${JSON.stringify(value)}`);
  }
  return sign ? -minor : minor;
}

/** Formats integer minor units as a canonical decimal string (`125050` INR → `"1250.50"`). */
export function formatMinorToDecimal(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError(`Minor units must be a safe integer, got ${minor}`);
  }
  const units = minorUnits(currency);
  const negative = minor < 0;
  const digits = String(Math.abs(minor));
  if (units === 0) {
    return `${negative ? '-' : ''}${digits}`;
  }
  const padded = digits.padStart(units + 1, '0');
  const whole = padded.slice(0, -units);
  const fraction = padded.slice(-units);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Parses a money value from an API response (decimal string or legacy number) into minor units.
 * Use this in UI code instead of `Number(amount)` / `amount.toFixed()` (gap P0-7).
 */
export function parseMoney(value: string | number, currency: string): number {
  return parseDecimalToMinor(value, currency);
}

function numberToPlainString(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Not a finite amount: ${value}`);
  }
  const text = String(value);
  // Exponent notation (1e21, 1e-7) is outside any real transaction; refuse instead of guessing.
  if (/e/i.test(text)) {
    throw new RangeError(`Amount out of range: ${value}`);
  }
  return text;
}
