/**
 * Text helpers for the parser. Regexes here avoid lookbehind and `\p{…}` classes so the same
 * code runs on Hermes (mobile) and Node (backend); word boundaries are checked in code instead.
 */

/** Messages are cut to this length before parsing (plan §3.1): no single message can stall a run. */
export const MAX_BODY_CHARS = 1000;

/** Letters (any script), combining marks and digits count as word characters. */
export function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return true;
  // Everything above ASCII except common punctuation and spaces is treated as a letter or mark.
  return code >= 0xc0 && !isUnicodePunctuationOrSpace(code);
}

function isUnicodePunctuationOrSpace(code: number): boolean {
  return (
    (code >= 0x2000 && code <= 0x206f) || // general punctuation, spaces
    (code >= 0x20a0 && code <= 0x20cf) || // currency symbols (₹, €)
    code === 0x3000 ||
    code === 0x0964 || // Devanagari danda
    code === 0x0965 ||
    code === 0xa0
  );
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** NFKC when the runtime supports it (Hermes without Intl may not). */
export function nfkc(text: string): string {
  try {
    return text.normalize('NFKC');
  } catch {
    return text;
  }
}

/** Collapses whitespace runs to one space and trims. */
export function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** "ACME CORP" → "Acme Corp". Keeps short all-caps tokens with digits (e.g. "7ELEVEN") readable. */
export function titleCase(text: string): string {
  return collapseSpaces(text)
    .toLowerCase()
    .split(' ')
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/** Replaces [start, end) with spaces so later matches keep their positions. */
export function blank(text: string, start: number, end: number): string {
  return text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);
}

/** Strips leading and trailing characters from the given set without a regex (no backtracking). */
export function trimChars(text: string, leading: string, trailing: string = leading): string {
  let start = 0;
  let end = text.length;
  while (start < end && leading.includes(text[start]!)) start += 1;
  while (end > start && trailing.includes(text[end - 1]!)) end -= 1;
  return text.slice(start, end);
}
