import { isSupportedCurrency, minorUnits } from '../money/currencies';
import { PAYMENT_METHODS, TRANSACTION_SUBTYPES, TRANSACTION_TYPES } from '../types/transaction';
import { LEXICON_CLASSES, PACK_SCHEMA_VERSION, TEMPLATE_PLACEHOLDERS } from './types';

/**
 * Structural and referential validation of a knowledge pack, with no dependencies so it can
 * run on the device before a downloaded pack is activated. The JSON Schema in
 * `schema/knowledge-pack.schema.json` describes the same structure for tooling; a test keeps
 * the two in agreement. This function additionally checks cross-references the schema can't.
 *
 * Returns a list of human-readable problems; an empty list means the pack is valid.
 */
export function validateKnowledgePack(pack: unknown): string[] {
  const errors: string[] = [];
  const err = (path: string, message: string) => errors.push(`${path}: ${message}`);

  if (!isRecord(pack)) {
    return ['pack: must be an object'];
  }

  const meta = pack.meta;
  if (!isRecord(meta)) {
    err('meta', 'must be an object');
  } else {
    if (meta.schemaVersion !== PACK_SCHEMA_VERSION) {
      err('meta.schemaVersion', `must be ${PACK_SCHEMA_VERSION}`);
    }
    if (!isPositiveInt(meta.packVersion)) err('meta.packVersion', 'must be a positive integer');
    if (!(meta.country === 'GLOBAL' || isCountry(meta.country))) {
      err('meta.country', 'must be GLOBAL or an ISO 3166-1 alpha-2 code');
    }
    if (!isIsoDateTime(meta.generatedAt)) err('meta.generatedAt', 'must be an ISO 8601 date-time');
    if (!isSemver(meta.minCoreVersion)) err('meta.minCoreVersion', 'must be a semver version');
    if (meta.baseVersion !== undefined && !isPositiveInt(meta.baseVersion)) {
      err('meta.baseVersion', 'must be a positive integer');
    }
  }

  const sections = [
    'institutions',
    'senders',
    'lexicons',
    'templates',
    'merchants',
    'merchantAliases',
    'currencies',
    'paymentRails',
    'taxonomy',
    'mcc',
    'killSwitches',
  ] as const;
  for (const section of sections) {
    if (!Array.isArray(pack[section])) err(section, 'must be an array');
  }
  if (errors.length > 0) return errors;

  const institutions = pack.institutions as unknown[];
  const institutionIds = uniqueIds(institutions, 'institutions', err, (item, path) => {
    requireString(item, 'name', path, err);
    requireString(item, 'displayName', path, err);
    if (!isCountry(item.country)) err(`${path}.country`, 'must be an ISO 3166-1 alpha-2 code');
    if (!oneOf(item.type, ['bank', 'card_issuer', 'wallet', 'nbfc', 'payment_app', 'broker', 'credit_union'])) {
      err(`${path}.type`, 'unknown institution type');
    }
    if (typeof item.verified !== 'boolean') err(`${path}.verified`, 'must be a boolean');
    if (item.bic !== undefined && !/^[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(String(item.bic))) {
      err(`${path}.bic`, 'must be an 8 or 11 character BIC');
    }
  });

  const senderKeys = new Set<string>();
  (pack.senders as unknown[]).forEach((item, i) => {
    const path = `senders[${i}]`;
    if (!isRecord(item)) return err(path, 'must be an object');
    if (!institutionIds.has(String(item.institutionId))) err(`${path}.institutionId`, 'unknown institution');
    if (!oneOf(item.channel, ['sms', 'email', 'notification'])) err(`${path}.channel`, 'unknown channel');
    if (!oneOf(item.match, ['header', 'exact', 'domain'])) err(`${path}.match`, 'unknown match type');
    if (!nonEmptyString(item.key)) return err(`${path}.key`, 'must be a non-empty string');
    const key = `${String(item.channel)}|${String(item.match)}|${item.key}`;
    if (senderKeys.has(key)) err(`${path}.key`, `duplicate sender key ${item.key}`);
    senderKeys.add(key);
    if (item.channel === 'sms' && item.key !== item.key.toUpperCase()) {
      err(`${path}.key`, 'SMS sender keys must be uppercase');
    }
  });

  (pack.lexicons as unknown[]).forEach((item, i) => {
    const path = `lexicons[${i}]`;
    if (!isRecord(item)) return err(path, 'must be an object');
    if (!isLanguage(item.language)) err(`${path}.language`, 'must be a BCP 47 language tag');
    if (!oneOf(item.class, LEXICON_CLASSES)) err(`${path}.class`, 'unknown lexicon class');
    if (!Array.isArray(item.phrases) || item.phrases.length === 0) {
      err(`${path}.phrases`, 'must be a non-empty array');
    } else {
      item.phrases.forEach((phrase, j) => {
        if (!nonEmptyString(phrase) || phrase.trim() !== phrase) {
          err(`${path}.phrases[${j}]`, 'must be a trimmed non-empty string');
        }
      });
    }
  });

  uniqueIds(pack.templates as unknown[], 'templates', err, (item, path) => {
    if (!institutionIds.has(String(item.institutionId))) err(`${path}.institutionId`, 'unknown institution');
    if (!isPositiveInt(item.version)) err(`${path}.version`, 'must be a positive integer');
    if (!isLanguage(item.language)) err(`${path}.language`, 'must be a BCP 47 language tag');
    if (!nonEmptyString(item.skeleton)) return err(`${path}.skeleton`, 'must be a non-empty string');
    const placeholders = [...item.skeleton.matchAll(/<([A-Z]+)>/g)].map((m) => m[1]);
    placeholders.forEach((p) => {
      if (!oneOf(p, TEMPLATE_PLACEHOLDERS)) err(`${path}.skeleton`, `unknown placeholder <${p}>`);
    });
    if (!Array.isArray(item.fields) || item.fields.length !== placeholders.length) {
      err(`${path}.fields`, `must list one role per placeholder (${placeholders.length})`);
    } else if (!item.fields.includes('amount')) {
      err(`${path}.fields`, 'must contain an amount');
    }
    if (!oneOf(item.direction, ['DEBIT', 'CREDIT'])) err(`${path}.direction`, 'must be DEBIT or CREDIT');
    if (!oneOf(item.transactionType, TRANSACTION_TYPES)) err(`${path}.transactionType`, 'unknown type');
    if (item.subtype !== undefined && !oneOf(item.subtype, TRANSACTION_SUBTYPES)) err(`${path}.subtype`, 'unknown subtype');
    if (item.paymentMethod !== undefined && !oneOf(item.paymentMethod, PAYMENT_METHODS)) {
      err(`${path}.paymentMethod`, 'unknown payment method');
    }
    if (item.dateOrder !== undefined && !oneOf(item.dateOrder, ['DMY', 'MDY', 'YMD'])) {
      err(`${path}.dateOrder`, 'must be DMY, MDY or YMD');
    }
  });

  const taxonomyCodes = uniqueIds(pack.taxonomy as unknown[], 'taxonomy', err, (item, path) => {
    requireString(item, 'name', path, err);
  }, 'code');
  (pack.taxonomy as Record<string, unknown>[]).forEach((item, i) => {
    if (isRecord(item) && item.parent !== undefined && !taxonomyCodes.has(String(item.parent))) {
      err(`taxonomy[${i}].parent`, 'unknown parent code');
    }
  });

  const merchantIds = uniqueIds(pack.merchants as unknown[], 'merchants', err, (item, path) => {
    requireString(item, 'name', path, err);
    if (!(item.country === null || isCountry(item.country))) err(`${path}.country`, 'must be null or ISO alpha-2');
    if (!taxonomyCodes.has(String(item.taxonomyCode))) err(`${path}.taxonomyCode`, 'unknown taxonomy code');
    if (item.mcc !== undefined && !/^\d{4}$/.test(String(item.mcc))) err(`${path}.mcc`, 'must be 4 digits');
    if (item.wikidataId !== undefined && !/^Q\d+$/.test(String(item.wikidataId))) {
      err(`${path}.wikidataId`, 'must look like Q123');
    }
  });

  const aliasKeys = new Set<string>();
  (pack.merchantAliases as unknown[]).forEach((item, i) => {
    const path = `merchantAliases[${i}]`;
    if (!isRecord(item)) return err(path, 'must be an object');
    if (!merchantIds.has(String(item.merchantId))) err(`${path}.merchantId`, 'unknown merchant');
    if (!nonEmptyString(item.alias) || item.alias !== item.alias.toLowerCase()) {
      err(`${path}.alias`, 'must be a non-empty lowercase normalized key');
    }
    if (item.country !== undefined && !isCountry(item.country)) err(`${path}.country`, 'must be ISO alpha-2');
    const key = `${String(item.alias)}|${String(item.country ?? '*')}`;
    if (aliasKeys.has(key)) err(`${path}.alias`, `duplicate alias ${String(item.alias)}`);
    aliasKeys.add(key);
  });

  const currencyCodes = new Set<string>();
  (pack.currencies as unknown[]).forEach((item, i) => {
    const path = `currencies[${i}]`;
    if (!isRecord(item)) return err(path, 'must be an object');
    const code = String(item.code);
    if (!isSupportedCurrency(code) || code !== code.toUpperCase()) {
      return err(`${path}.code`, 'must be an uppercase ISO 4217 code');
    }
    if (currencyCodes.has(code)) err(`${path}.code`, `duplicate currency ${code}`);
    currencyCodes.add(code);
    if (item.minorUnits !== minorUnits(code)) err(`${path}.minorUnits`, `must be ${minorUnits(code)} for ${code}`);
    if (!Array.isArray(item.symbols) || !item.symbols.every(nonEmptyString)) err(`${path}.symbols`, 'must be strings');
    if (!oneOf(item.decimalSeparator, ['.', ','])) err(`${path}.decimalSeparator`, 'must be . or ,');
    if (!oneOf(item.groupSeparator, [',', '.', ' ', "'", ''])) err(`${path}.groupSeparator`, 'unsupported');
    if (item.decimalSeparator === item.groupSeparator) err(`${path}.groupSeparator`, 'must differ from decimal separator');
    if (!oneOf(item.grouping, ['standard', 'indian'])) err(`${path}.grouping`, 'must be standard or indian');
  });

  uniqueIds(pack.paymentRails as unknown[], 'paymentRails', err, (item, path) => {
    requireString(item, 'name', path, err);
    if (!oneOf(item.paymentMethod, PAYMENT_METHODS)) err(`${path}.paymentMethod`, 'unknown payment method');
    if (!Array.isArray(item.keywords) || item.keywords.length === 0 || !item.keywords.every(nonEmptyString)) {
      err(`${path}.keywords`, 'must be a non-empty array of strings');
    }
    if (item.countries !== undefined && (!Array.isArray(item.countries) || !item.countries.every(isCountry))) {
      err(`${path}.countries`, 'must be ISO alpha-2 codes');
    }
  });

  (pack.mcc as unknown[]).forEach((item, i) => {
    const path = `mcc[${i}]`;
    if (!isRecord(item)) return err(path, 'must be an object');
    if (!/^\d{4}$/.test(String(item.mcc))) err(`${path}.mcc`, 'must be 4 digits');
    if (!taxonomyCodes.has(String(item.taxonomyCode))) err(`${path}.taxonomyCode`, 'unknown taxonomy code');
  });

  (pack.killSwitches as unknown[]).forEach((item, i) => {
    const path = `killSwitches[${i}]`;
    if (!isRecord(item)) return err(path, 'must be an object');
    if (!oneOf(item.scope, ['institution', 'template', 'country', 'pack', 'app_version'])) err(`${path}.scope`, 'unknown scope');
    if (!nonEmptyString(item.key)) err(`${path}.key`, 'must be a non-empty string');
    if (!oneOf(item.action, ['disable_auto_create', 'disable_detection'])) err(`${path}.action`, 'unknown action');
  });

  return errors;
}

type ErrFn = (path: string, message: string) => void;

function uniqueIds(
  items: unknown[],
  section: string,
  err: ErrFn,
  check: (item: Record<string, unknown>, path: string) => void,
  idField = 'id',
): Set<string> {
  const ids = new Set<string>();
  items.forEach((item, i) => {
    const path = `${section}[${i}]`;
    if (!isRecord(item)) return err(path, 'must be an object');
    const id = item[idField];
    if (!nonEmptyString(id)) {
      err(`${path}.${idField}`, 'must be a non-empty string');
    } else if (ids.has(id)) {
      err(`${path}.${idField}`, `duplicate ${idField} ${id}`);
    } else {
      ids.add(id);
    }
    check(item, path);
  });
  return ids;
}

function requireString(item: Record<string, unknown>, field: string, path: string, err: ErrFn): void {
  if (!nonEmptyString(item[field])) err(`${path}.${field}`, 'must be a non-empty string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function isPositiveInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isCountry(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Z]{2}$/.test(value);
}

function isLanguage(value: unknown): boolean {
  return typeof value === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value);
}

function isSemver(value: unknown): boolean {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Z.-]+)?$/i.test(value);
}

function isIsoDateTime(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}
