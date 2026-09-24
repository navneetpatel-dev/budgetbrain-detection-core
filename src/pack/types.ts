import type { PaymentMethod, TransactionSubtype, TransactionType } from '../types/transaction';

/** Bump on breaking changes to the pack structure. Consumers reject packs with a newer major. */
export const PACK_SCHEMA_VERSION = 1;

export type InstitutionType =
  | 'bank'
  | 'card_issuer'
  | 'wallet'
  | 'nbfc'
  | 'payment_app'
  | 'broker'
  | 'credit_union';

export interface PackInstitution {
  /** Stable slug, e.g. `in.hdfc_bank`. Never reused for a different institution. */
  id: string;
  name: string;
  displayName: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  type: InstitutionType;
  bic?: string;
  /** National identifiers, e.g. `{ "ifscPrefix": "HDFC" }`, `{ "routing": "021000021" }`. */
  codes?: Record<string, string>;
  domains?: string[];
  /** Verified institutions can reach the high confidence tier. */
  verified: boolean;
}

export type SenderChannel = 'sms' | 'email' | 'notification';
/**
 * `header`: SMS header after stripping the operator/route prefix (India DLT `XX-HDFCBK` → `HDFCBK`).
 * `exact`: whole sender (short code, email address, Android package name).
 * `domain`: email sender domain.
 */
export type SenderMatch = 'header' | 'exact' | 'domain';

export interface PackSender {
  institutionId: string;
  channel: SenderChannel;
  match: SenderMatch;
  /** Uppercase for `header`/`exact` SMS keys; lowercase for email and package names. */
  key: string;
}

export const LEXICON_CLASSES = [
  'debit_verbs',
  'credit_verbs',
  'refund',
  'reversal',
  'cashback',
  'transfer',
  'self_transfer',
  'bill_payment',
  'failed',
  'otp_markers',
  'promo_markers',
  'non_transaction_notice',
  'future_or_request',
  'balance',
  'limit',
  'safety_footer',
  'account_markers',
  'reference_markers',
] as const;
export type LexiconClass = (typeof LEXICON_CLASSES)[number];

export interface PackLexicon {
  /** BCP 47 language tag, e.g. `en`, `hi`, `pt-BR`. */
  language: string;
  class: LexiconClass;
  /** Phrases matched case-insensitively on Unicode word boundaries. Plain text, not regex. */
  phrases: string[];
}

/** Placeholders a template skeleton may contain. */
export const TEMPLATE_PLACEHOLDERS = [
  'AMT',
  'ACCT',
  'DATE',
  'TIME',
  'REF',
  'VPA',
  'NAME',
  'NUM',
  'TEXT',
] as const;
export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number];

export type TemplateFieldRole =
  | 'amount'
  | 'balance'
  | 'limit'
  | 'date'
  | 'time'
  | 'account'
  | 'reference'
  | 'merchant'
  | 'counterparty'
  | 'ignore';

export interface PackTemplate {
  id: string;
  institutionId: string;
  version: number;
  language: string;
  /**
   * Masked message with `<AMT>`, `<ACCT>` … placeholders; literal text is compared
   * case-insensitively with whitespace collapsed.
   */
  skeleton: string;
  /** Role of each placeholder occurrence, in order of appearance. */
  fields: TemplateFieldRole[];
  direction: 'DEBIT' | 'CREDIT';
  transactionType: TransactionType;
  subtype?: TransactionSubtype;
  paymentMethod?: PaymentMethod;
  /** Date order for `<DATE>` in this template. */
  dateOrder?: 'DMY' | 'MDY' | 'YMD';
}

export interface PackMerchant {
  id: string;
  name: string;
  /** `null` for global brands. */
  country: string | null;
  wikidataId?: string;
  domain?: string;
  taxonomyCode: string;
  mcc?: string;
}

export interface PackMerchantAlias {
  merchantId: string;
  /** Normalized key (see the merchant normalizer, task T3.8). */
  alias: string;
  /** Restrict the alias to one country; omit for global. */
  country?: string;
}

export interface PackCurrency {
  code: string;
  minorUnits: number;
  symbols: string[];
  /** Symbols shared with other currencies (e.g. `$`), resolved by institution country first. */
  ambiguousSymbols?: string[];
  decimalSeparator: '.' | ',';
  groupSeparator: ',' | '.' | ' ' | "'" | '';
  /** `indian` = 12,34,567 lakh grouping. */
  grouping: 'standard' | 'indian';
}

export interface PackPaymentRail {
  id: string;
  name: string;
  paymentMethod: PaymentMethod;
  /** ISO 3166-1 alpha-2 countries where the rail operates; omit for global. */
  countries?: string[];
  keywords: string[];
}

export interface PackTaxonomyNode {
  code: string;
  parent?: string;
  name: string;
}

export interface PackMccMapping {
  mcc: string;
  taxonomyCode: string;
}

export type KillSwitchScope = 'institution' | 'template' | 'country' | 'pack' | 'app_version';
export type KillSwitchAction = 'disable_auto_create' | 'disable_detection';

export interface PackKillSwitch {
  scope: KillSwitchScope;
  /** Institution id, template id, country code, pack version or a semver range for app versions. */
  key: string;
  action: KillSwitchAction;
  reason?: string;
}

export interface PackMeta {
  schemaVersion: number;
  /** Monotonic integer per country. */
  packVersion: number;
  /** ISO 3166-1 alpha-2, or `GLOBAL` for the shared core pack. */
  country: string;
  generatedAt: string;
  /** Lowest core library version that understands this pack (semver). */
  minCoreVersion: string;
  /** Set on delta packs: the version this delta applies to. */
  baseVersion?: number;
}

export interface KnowledgePack {
  meta: PackMeta;
  institutions: PackInstitution[];
  senders: PackSender[];
  lexicons: PackLexicon[];
  templates: PackTemplate[];
  merchants: PackMerchant[];
  merchantAliases: PackMerchantAlias[];
  currencies: PackCurrency[];
  paymentRails: PackPaymentRail[];
  taxonomy: PackTaxonomyNode[];
  mcc: PackMccMapping[];
  killSwitches: PackKillSwitch[];
}

export interface PackSignature {
  alg: 'Ed25519';
  /** Identifies the public key, so keys can be rotated. */
  keyId: string;
  /** Base64 signature over the canonical JSON bytes of `payload`. */
  value: string;
}

export interface SignedKnowledgePack {
  payload: KnowledgePack;
  signature: PackSignature;
}
