import type {
  KnowledgePack,
  LexiconClass,
  PackCurrency,
  PackInstitution,
  PackKillSwitch,
  PackMerchant,
  PackPaymentRail,
  PackTemplate,
  TemplateFieldRole,
} from '../pack/types';
import { LEXICON_CLASSES } from '../pack/types';
import { isSupportedCurrency } from '../money/currencies';
import { PhraseMatcher } from './phraseMatcher';
import { collapseSpaces, escapeRegExp } from './text';
import { merchantKey } from './merchant';

export interface CompiledTemplate {
  template: PackTemplate;
  regex: RegExp;
  /** Placeholder name for each capture group, in order. */
  placeholders: string[];
  fields: TemplateFieldRole[];
}

export interface CompiledPack {
  countries: string[];
  packVersions: Record<string, number>;
  institutions: Map<string, PackInstitution>;
  smsHeaders: Map<string, string>;
  exactSenders: Map<string, string>;
  emailDomains: Map<string, string>;
  /**
   * Content signal (plan T3.2): distinctive multi-word institution names (upper case, e.g.
   * `HDFC BANK`), each naming exactly one institution, and IFSC-style 4-letter prefixes.
   */
  contentNames: { needle: string; institutionId: string }[];
  ifscPrefixes: Map<string, string>;
  lexicon: Record<LexiconClass, PhraseMatcher>;
  templatesByInstitution: Map<string, CompiledTemplate[]>;
  merchants: Map<string, PackMerchant>;
  /** Normalized alias → merchant ids, each with an optional country restriction. */
  aliases: Map<string, { merchantId: string; country: string | null }[]>;
  /** Longest alias length in tokens, so prefix lookups stop early. */
  maxAliasTokens: number;
  /** Currency symbols and codes, longest first, with every currency they can mean. */
  symbols: { symbol: string; codes: string[] }[];
  currencies: Map<string, PackCurrency>;
  rails: PackPaymentRail[];
  railMatchers: { rail: PackPaymentRail; matcher: PhraseMatcher }[];
  taxonomy: Map<string, { name: string; parent: string | null }>;
  mcc: Map<string, string>;
  killSwitches: PackKillSwitch[];
}

/**
 * Symbols every build understands even without a pack entry (gap-doc §6.7). Packs add local
 * symbols and say which currency an ambiguous symbol like `$` means in their country.
 */
const BUILTIN_SYMBOLS: Readonly<Record<string, string[]>> = {
  '₹': ['INR'],
  'Rs.': ['INR'],
  Rs: ['INR'],
  $: ['USD'],
  'US$': ['USD'],
  '€': ['EUR'],
  '£': ['GBP'],
  '¥': ['JPY'],
  'S$': ['SGD'],
  'A$': ['AUD'],
  'C$': ['CAD'],
  'R$': ['BRL'],
  AED: ['AED'],
};

const PLACEHOLDER_PATTERNS: Readonly<Record<string, string>> = {
  AMT: '(\\d[\\d,.\']*)',
  ACCT: '([xX*•]*\\d{3,6})',
  DATE: '(\\S+?)',
  TIME: '(\\S+?)',
  REF: '([A-Za-z0-9]+)',
  VPA: '(\\S+)',
  NUM: '(\\S+?)',
  NAME: '(.+?)',
  TEXT: '(.+?)',
};

function compileTemplate(template: PackTemplate): CompiledTemplate | null {
  const placeholders: string[] = [];
  let source = '';
  let rest = collapseSpaces(template.skeleton);
  for (;;) {
    const open = rest.indexOf('<');
    if (open === -1) break;
    const close = rest.indexOf('>', open);
    if (close === -1) break;
    const name = rest.slice(open + 1, close);
    const pattern = PLACEHOLDER_PATTERNS[name];
    if (!pattern) return null;
    source += escapeRegExp(rest.slice(0, open)).replace(/ /g, '\\s+') + pattern;
    placeholders.push(name);
    rest = rest.slice(close + 1);
  }
  source += escapeRegExp(rest).replace(/ /g, '\\s+');
  try {
    return { template, regex: new RegExp(`^${source}[\\s.]*$`, 'i'), placeholders, fields: template.fields };
  } catch {
    return null;
  }
}

/**
 * Builds every lookup structure once per pack (plan T3.14): maps and sets for senders and
 * aliases, one combined regular expression per lexicon class, templates indexed by institution.
 * Pass the global core pack and the country packs together; later packs extend earlier ones.
 */
export function compilePack(packs: KnowledgePack | readonly KnowledgePack[]): CompiledPack {
  const list = Array.isArray(packs) ? (packs as readonly KnowledgePack[]) : [packs as KnowledgePack];
  const compiled: CompiledPack = {
    countries: [],
    packVersions: {},
    institutions: new Map(),
    smsHeaders: new Map(),
    exactSenders: new Map(),
    emailDomains: new Map(),
    contentNames: [],
    ifscPrefixes: new Map(),
    lexicon: {} as Record<LexiconClass, PhraseMatcher>,
    templatesByInstitution: new Map(),
    merchants: new Map(),
    aliases: new Map(),
    maxAliasTokens: 1,
    symbols: [],
    currencies: new Map(),
    rails: [],
    railMatchers: [],
    taxonomy: new Map(),
    mcc: new Map(),
    killSwitches: [],
  };
  const phrases = new Map<LexiconClass, string[]>(LEXICON_CLASSES.map((c) => [c, []]));
  const symbolCodes = new Map<string, Set<string>>();
  for (const [symbol, codes] of Object.entries(BUILTIN_SYMBOLS)) symbolCodes.set(symbol, new Set(codes));

  for (const pack of list) {
    compiled.countries.push(pack.meta.country);
    compiled.packVersions[pack.meta.country] = pack.meta.packVersion;
    for (const institution of pack.institutions) compiled.institutions.set(institution.id, institution);
    for (const sender of pack.senders) {
      if (sender.channel === 'sms' && sender.match === 'header') compiled.smsHeaders.set(sender.key.toUpperCase(), sender.institutionId);
      else if (sender.match === 'domain') compiled.emailDomains.set(sender.key.toLowerCase(), sender.institutionId);
      else compiled.exactSenders.set(sender.key.toLowerCase(), sender.institutionId);
    }
    for (const lexicon of pack.lexicons) phrases.get(lexicon.class)?.push(...lexicon.phrases);
    for (const template of pack.templates) {
      const built = compileTemplate(template);
      if (!built) continue;
      const bucket = compiled.templatesByInstitution.get(template.institutionId) ?? [];
      bucket.push(built);
      compiled.templatesByInstitution.set(template.institutionId, bucket);
    }
    for (const merchant of pack.merchants) compiled.merchants.set(merchant.id, merchant);
    for (const alias of pack.merchantAliases) {
      const key = merchantKey(alias.alias);
      if (!key) continue;
      const bucket = compiled.aliases.get(key) ?? [];
      bucket.push({ merchantId: alias.merchantId, country: alias.country ?? null });
      compiled.aliases.set(key, bucket);
      compiled.maxAliasTokens = Math.max(compiled.maxAliasTokens, key.split(' ').length);
    }
    // Merchant names are aliases of themselves.
    for (const merchant of pack.merchants) {
      const key = merchantKey(merchant.name);
      if (key && !compiled.aliases.has(key)) compiled.aliases.set(key, [{ merchantId: merchant.id, country: merchant.country }]);
    }
    for (const currency of pack.currencies) {
      compiled.currencies.set(currency.code, currency);
      for (const symbol of [...currency.symbols, currency.code]) {
        const set = symbolCodes.get(symbol) ?? new Set<string>();
        // A pack that lists an ambiguous symbol puts its own currency first.
        if (currency.ambiguousSymbols?.includes(symbol) || !set.has(currency.code)) {
          const ordered = new Set([currency.code, ...set]);
          symbolCodes.set(symbol, ordered);
        }
      }
    }
    compiled.rails.push(...pack.paymentRails);
    for (const node of pack.taxonomy) compiled.taxonomy.set(node.code, { name: node.name, parent: node.parent ?? null });
    for (const mapping of pack.mcc) compiled.mcc.set(mapping.mcc, mapping.taxonomyCode);
    compiled.killSwitches.push(...pack.killSwitches);
  }

  for (const lexiconClass of LEXICON_CLASSES) compiled.lexicon[lexiconClass] = new PhraseMatcher(phrases.get(lexiconClass) ?? []);
  compiled.symbols = [...symbolCodes.entries()]
    .filter(([, codes]) => [...codes].every((code) => isSupportedCurrency(code)))
    .map(([symbol, codes]) => ({ symbol, codes: [...codes] }))
    .sort((a, b) => b.symbol.length - a.symbol.length);
  compiled.railMatchers = compiled.rails.map((rail) => ({ rail, matcher: new PhraseMatcher(rail.keywords) }));
  buildContentSignal(compiled);
  return compiled;
}

/**
 * Names an institution can be recognised by in a message body (plan T3.2): its name and display
 * name, also without a trailing "Limited"/"Ltd", upper case with single spaces. Only names of two
 * or more words count (one word such as "SBI" or "Paytm" appears in too many other messages),
 * and a name two institutions share is dropped.
 */
function buildContentSignal(compiled: CompiledPack): void {
  const owners = new Map<string, Set<string>>();
  for (const institution of compiled.institutions.values()) {
    for (const raw of [institution.name, institution.displayName]) {
      if (!raw) continue;
      const base = raw.toUpperCase().replace(/\s+/g, ' ').trim();
      for (const name of [base, base.replace(/ (?:LIMITED|LTD\.?)$/, '')]) {
        if (name.length < 6 || !name.includes(' ')) continue;
        const set = owners.get(name) ?? new Set<string>();
        set.add(institution.id);
        owners.set(name, set);
      }
    }
    const prefix = institution.codes?.ifscPrefix?.toUpperCase();
    if (prefix && /^[A-Z]{4}$/.test(prefix)) compiled.ifscPrefixes.set(prefix, institution.id);
  }
  for (const [needle, ids] of owners) {
    if (ids.size === 1) compiled.contentNames.push({ needle, institutionId: [...ids][0]! });
  }
  // Longest first, so "STATE BANK OF INDIA" is tried before a shorter name inside it.
  compiled.contentNames.sort((a, b) => b.needle.length - a.needle.length);
}
