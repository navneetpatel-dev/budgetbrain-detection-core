import { escapeRegExp, isWordChar } from './text';

export interface PhraseMatch {
  phrase: string;
  start: number;
  end: number;
}

/**
 * Matches a list of plain-text phrases case-insensitively on word boundaries, with one
 * combined regular expression built once per pack (plan T3.14). Longer phrases win.
 */
export class PhraseMatcher {
  private readonly regex: RegExp | null;

  constructor(phrases: readonly string[]) {
    const unique = [...new Set(phrases.map((p) => p.trim().toLowerCase()).filter(Boolean))];
    unique.sort((a, b) => b.length - a.length);
    this.regex = unique.length > 0 ? new RegExp(unique.map((p) => escapeRegExp(p).replace(/ /g, '\\s+')).join('|'), 'gi') : null;
  }

  get isEmpty(): boolean {
    return this.regex === null;
  }

  /** Every non-overlapping match, left to right. */
  findAll(text: string): PhraseMatch[] {
    if (!this.regex) return [];
    const matches: PhraseMatch[] = [];
    this.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = this.regex.exec(text)) !== null) {
      const start: number = m.index;
      const end = start + m[0].length;
      const first = m[0].charAt(0);
      const last = m[0].charAt(m[0].length - 1);
      // Only enforce a boundary where the phrase itself starts or ends with a word character.
      const okStart = !isWordChar(first) || !isWordChar(text[start - 1]);
      const okEnd = !isWordChar(last) || !isWordChar(text[end]);
      if (okStart && okEnd) matches.push({ phrase: m[0].toLowerCase(), start, end });
      // A rejected match may hide a valid one starting inside it (e.g. "bal" in "global balance").
      else this.regex.lastIndex = start + 1;
    }
    return matches;
  }

  find(text: string): PhraseMatch | null {
    return this.findAll(text)[0] ?? null;
  }

  test(text: string): boolean {
    return this.findAll(text).length > 0;
  }
}
