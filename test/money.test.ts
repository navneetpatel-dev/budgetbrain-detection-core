import { describe, expect, it } from 'vitest';
import { formatMinorToDecimal, isSupportedCurrency, minorUnits, parseDecimalToMinor, parseMoney } from '../src';

describe('minorUnits', () => {
  it('uses 2 by default and the ISO exceptions otherwise', () => {
    expect(minorUnits('INR')).toBe(2);
    expect(minorUnits('usd')).toBe(2);
    expect(minorUnits('JPY')).toBe(0);
    expect(minorUnits('KRW')).toBe(0);
    expect(minorUnits('KWD')).toBe(3);
    expect(minorUnits('CLF')).toBe(4);
  });

  it('rejects unknown codes instead of guessing', () => {
    expect(() => minorUnits('XYZ')).toThrow(RangeError);
    expect(isSupportedCurrency('XYZ')).toBe(false);
  });
});

describe('parseDecimalToMinor', () => {
  it.each([
    ['1250.00', 'INR', 125000],
    ['1250.5', 'INR', 125050],
    ['1250', 'INR', 125000],
    ['0.07', 'USD', 7],
    ['007.10', 'USD', 710],
    ['1500', 'JPY', 1500],
    ['1.250', 'KWD', 1250],
    ['-12.34', 'EUR', -1234],
  ])('%s %s → %i', (value, currency, expected) => {
    expect(parseDecimalToMinor(value, currency)).toBe(expected);
  });

  it('accepts legacy numeric API values without float drift', () => {
    expect(parseDecimalToMinor(0.1 + 0.2 - 0.3 + 19.99, 'USD')).toBe(1999);
    expect(parseDecimalToMinor(1250, 'INR')).toBe(125000);
  });

  it('accepts trailing zeros past the minor unit but rejects real extra precision', () => {
    expect(parseDecimalToMinor('12.3400', 'USD')).toBe(1234);
    expect(() => parseDecimalToMinor('12.345', 'USD')).toThrow(RangeError);
    expect(() => parseDecimalToMinor('12.5', 'JPY')).toThrow(RangeError);
  });

  it.each(['', '1,250.00', '12.', '.5', 'abc', '1e3', '1 250'])('rejects %j', (value) => {
    expect(() => parseDecimalToMinor(value, 'INR')).toThrow();
  });

  it('refuses amounts beyond safe integer precision', () => {
    expect(() => parseDecimalToMinor('99999999999999999.00', 'INR')).toThrow(RangeError);
    expect(() => parseDecimalToMinor(1e21, 'INR')).toThrow(RangeError);
    expect(() => parseDecimalToMinor(Number.NaN, 'INR')).toThrow(TypeError);
  });
});

describe('formatMinorToDecimal', () => {
  it.each([
    [125000, 'INR', '1250.00'],
    [5, 'USD', '0.05'],
    [0, 'USD', '0.00'],
    [-1234, 'EUR', '-12.34'],
    [1500, 'JPY', '1500'],
    [1250, 'KWD', '1.250'],
  ])('%i %s → %s', (minor, currency, expected) => {
    expect(formatMinorToDecimal(minor, currency)).toBe(expected);
  });

  it('round-trips with parseDecimalToMinor', () => {
    for (const value of ['0.01', '1.00', '999999.99', '125000.75']) {
      expect(formatMinorToDecimal(parseDecimalToMinor(value, 'INR'), 'INR')).toBe(value);
    }
  });

  it('rejects non-integer minor units', () => {
    expect(() => formatMinorToDecimal(1.5, 'INR')).toThrow(RangeError);
  });
});

describe('parseMoney (UI helper for API values, gap P0-7)', () => {
  it('handles the DECIMAL strings Postgres returns', () => {
    expect(parseMoney('1250.00', 'INR')).toBe(125000);
  });
});
