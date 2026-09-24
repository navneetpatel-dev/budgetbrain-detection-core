import { minTier, scoreEvidence } from '../confidence/evidence';
import { computeFingerprint } from '../fingerprint/fingerprint';
import type { NormalizedMessage } from '../types/message';
import type { LifecycleState, ReasonCode } from '../types/lifecycle';
import type {
  ConfidenceTier,
  DetectedCandidate,
  DetectionEvidence,
  Direction,
  FieldReliability,
  PaymentMethod,
  TransactionSubtype,
  TransactionType,
} from '../types/transaction';
import { isAllowedDirectionType } from '../confidence/evidence';
import type { CompiledPack, CompiledTemplate } from './compile';
import { resolveCategory } from './category';
import { NO_MERCHANT, isPersonalVpa, looksLikePerson, resolveMerchantName, type ResolvedMerchant } from './merchant';
import { resolveFromContent, resolveSender } from './sender';
import { satisfiesRange } from './semver';
import { MAX_BODY_CHARS, blank, collapseSpaces, isWordChar, titleCase } from './text';
import { assignRoles, findAccounts, findDates, findMoney, findReference, findVpas, type AccountToken, type MoneyToken } from './tokens';
import type { PipelineResult, RecentTransaction, UserContext } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_DAYS = 400;
const MAX_AMOUNT_MINOR = 1e13;

/** "credit card", "debit card", "credit limit": nouns, not money movement (gap E6). */
const NOUN_PHRASES = /\b(?:credit|debit)\s+(?:card|limit|score|report|note)s?\b/gi;
const COUNTRY_DATE_ORDER: Readonly<Record<string, 'DMY' | 'MDY'>> = { US: 'MDY', PH: 'MDY', CA: 'MDY', FM: 'MDY' };

type Stop = { stage: LifecycleState; reason: ReasonCode };

interface Counterparty {
  raw: string;
  /** Where it came from; decides whether a bare name may be a person. */
  source: 'vpa' | 'template' | 'paren' | 'payee_credited' | 'to' | 'from' | 'by' | 'at' | 'info';
  vpa?: { handle: string; psp: string };
  accountTail?: string;
}

function ignored(stop: Stop, institutionId: string | null): PipelineResult {
  return { terminal: 'IGNORED', stage: stop.stage, reasonCode: stop.reason, institutionId, candidate: null, merchantKind: 'none' };
}

/** Calendar date of the received time as the sender's clock showed it (the offset in the string). */
function receivedDate(receivedAt: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(receivedAt);
  if (m) return m[1]!;
  const d = new Date(receivedAt);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function dayNumber(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / DAY_MS;
}

function dateOrderFor(country: string | null, ctx: UserContext): 'DMY' | 'MDY' {
  if (country) return COUNTRY_DATE_ORDER[country] ?? 'DMY';
  const region = ctx.deviceLocale?.split('-')[1]?.toUpperCase();
  return (region ? COUNTRY_DATE_ORDER[region] : undefined) ?? 'DMY';
}

function killSwitch(pack: CompiledPack, ctx: UserContext, institutionId: string | null, country: string | null, templateId?: string) {
  let detection = false;
  let autoCreate = false;
  const all = ctx.killSwitches ? [...pack.killSwitches, ...ctx.killSwitches] : pack.killSwitches;
  for (const ks of all) {
    const hit =
      (ks.scope === 'institution' && ks.key === institutionId) ||
      (ks.scope === 'country' && ks.key === country) ||
      (ks.scope === 'template' && ks.key === templateId) ||
      (ks.scope === 'pack' && country !== null && String(pack.packVersions[country]) === ks.key) ||
      (ks.scope === 'app_version' && ctx.appVersion !== undefined && satisfiesRange(ctx.appVersion, ks.key));
    if (!hit) continue;
    if (ks.action === 'disable_detection') detection = true;
    else autoCreate = true;
  }
  return { detection, autoCreate };
}

/** Money direction from movement verbs (plan T3.5). */
function direction(text: string, amount: MoneyToken, pack: CompiledPack, accounts: AccountToken[]) {
  const clean = text.replace(NOUN_PHRASES, (m) => ' '.repeat(m.length));
  const debits = pack.lexicon.debit_verbs.findAll(clean);
  const credits = pack.lexicon.credit_verbs.findAll(clean);
  const distance = (m: { start: number; end: number }) =>
    m.end <= amount.start ? amount.start - m.end : m.start >= amount.end ? m.start - amount.end : 0;
  const nearest = (list: { start: number; end: number }[]) =>
    list.reduce((best, m) => (distance(m) < distance(best) ? m : best), list[0]!);

  if (debits.length > 0 && credits.length > 0) {
    const d = nearest(debits);
    const c = nearest(credits);
    const winner: Direction = distance(d) <= distance(c) ? 'DEBIT' : 'CREDIT';
    // "debit/credit adjustment": both verbs side by side, no way to tell.
    const ambiguous = Math.abs(d.start - c.start) < 12;
    return { direction: winner, ambiguous };
  }
  if (debits.length > 0) return { direction: 'DEBIT' as Direction, ambiguous: false };
  if (credits.length > 0) return { direction: 'CREDIT' as Direction, ambiguous: false };
  if (pack.lexicon.refund.test(clean) || pack.lexicon.reversal.test(clean) || pack.lexicon.cashback.test(clean)) {
    return { direction: 'CREDIT' as Direction, ambiguous: false };
  }
  // "Rs 2000 transferred from A/c XX4455 …": money leaves the account named after "from".
  const transfer = pack.lexicon.transfer.find(clean);
  if (transfer) {
    const first = accounts[0];
    const before = first ? clean.slice(Math.max(0, first.start - 20), first.start).toLowerCase() : '';
    if (/\bfrom\b/.test(before)) return { direction: 'DEBIT' as Direction, ambiguous: false };
    if (/\b(?:to|into|in)\b/.test(before)) return { direction: 'CREDIT' as Direction, ambiguous: false };
  }
  return null;
}

/** The user's own account: the masked number after "from" for a debit, after "to/in" for a credit. */
function userAccount(text: string, accounts: AccountToken[], dir: Direction): AccountToken | null {
  if (accounts.length === 0) return null;
  const marker = dir === 'DEBIT' ? /\bfrom\b/i : /\b(?:to|in|into|towards)\b/i;
  let previousEnd = 0;
  for (const account of accounts) {
    const window = text.slice(Math.max(previousEnd, account.start - 40), account.start);
    if (marker.test(window)) return account;
    previousEnd = account.end;
  }
  return accounts[0]!;
}

const NAME_STOP =
  /\s(?:on|via|ref|upi|imps|neft|avl|from|to|using|at|dated|for|with|is|was|has|towards|in|and|a\/c|acct|not)\b|[;,(]|\.(?:\s|$)|$/i;
const RAIL_WORDS = /^(?:upi|neft|imps|rtgs|atm|pos|card|wallet|vpa|ach|sepa|your|the|a|an)$/i;

function cutName(text: string): string {
  const m = NAME_STOP.exec(text);
  return collapseSpaces((m ? text.slice(0, m.index) : text).slice(0, 60));
}

function hasLetters(text: string): boolean {
  return /[A-Z]/i.test(text) || [...text].some((ch) => ch.charCodeAt(0) >= 0xc0 && isWordChar(ch));
}

/** Who the money went to or came from. */
function counterparty(text: string, dir: Direction, accounts: AccountToken[], ctx: UserContext): Counterparty | null {
  const ownVpas = new Set((ctx.ownVpas ?? []).map((v) => v.toLowerCase()));
  const vpa = findVpas(text).find((v) => !ownVpas.has(`${v.handle}@${v.psp}`));
  if (vpa) return { raw: vpa.handle, source: 'vpa', vpa: { handle: vpa.handle, psp: vpa.psp } };

  if (dir === 'DEBIT') {
    const payee = /;\s{0,3}([A-Z][A-Z .]{1,40}?)\s{1,3}credited\b/i.exec(text);
    if (payee) return { raw: payee[1]!, source: 'payee_credited' };
  }
  for (const account of accounts) {
    const paren = /^\s{0,2}\(([^()]{2,40})\)/.exec(text.slice(account.end, account.end + 45));
    if (paren) return { raw: paren[1]!, source: 'paren', accountTail: account.tail };
  }
  const keywords: Counterparty['source'][] = dir === 'DEBIT' ? ['at', 'to', 'info'] : ['from', 'by', 'info'];
  const lower = text.toLowerCase();
  const hits: { at: number; source: Counterparty['source']; length: number }[] = [];
  for (const source of keywords) {
    const word = source === 'info' ? 'info:' : source;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(word, from);
      if (at === -1) break;
      from = at + 1;
      if (isWordChar(lower[at - 1]) || (source !== 'info' && isWordChar(lower[at + word.length]))) continue;
      hits.push({ at, source, length: word.length });
    }
  }
  hits.sort((a, b) => a.at - b.at);
  for (const hit of hits) {
    const after = text.slice(hit.at + hit.length).replace(/^\s{1,3}/, '');
    if (/^(?:vpa|your|a\/c|acct|account|[x*]{1,4}\d)/i.test(after)) continue;
    const name = cutName(after);
    if (!name || !hasLetters(name) || RAIL_WORDS.test(name) || /^\d/.test(name)) continue;
    return { raw: name, source: hit.source };
  }
  return null;
}

function resolveCounterparty(party: Counterparty | null, pack: CompiledPack, country: string | null): ResolvedMerchant {
  if (!party) return NO_MERCHANT;
  const brand = resolveMerchantName(party.raw, pack, country);
  if (brand.kind === 'brand') return brand;
  if (party.vpa) {
    const personal = isPersonalVpa(party.vpa.handle, party.vpa.psp);
    return { ...brand, kind: personal ? 'p2p' : 'raw', name: personal ? party.vpa.handle : titleCase(party.vpa.handle) };
  }
  // A bare name is a person only where banks put payees, never after "at" or "Info:".
  const personSource = party.source === 'template' || party.source === 'paren' || party.source === 'payee_credited';
  const words = collapseSpaces(party.raw).split(' ').length;
  const maybePerson = personSource || ((party.source === 'to' || party.source === 'from') && words >= 2);
  if (maybePerson && looksLikePerson(party.raw)) return { ...brand, kind: 'p2p', name: titleCase(party.raw) };
  return brand;
}

const PAYMENT_PRIORITY: readonly PaymentMethod[] = ['cash', 'upi', 'bank_transfer', 'wallet', 'card', 'other'];

function paymentMethod(text: string, pack: CompiledPack, country: string | null): PaymentMethod | null {
  let best: PaymentMethod | null = null;
  for (const { rail, matcher } of pack.railMatchers) {
    if (rail.countries && country && !rail.countries.includes(country)) continue;
    if (!matcher.test(text)) continue;
    if (best === null || PAYMENT_PRIORITY.indexOf(rail.paymentMethod) < PAYMENT_PRIORITY.indexOf(best)) best = rail.paymentMethod;
  }
  return best;
}

/** Type and subtype (plan T3.7). */
function classify(
  text: string,
  dir: Direction,
  pack: CompiledPack,
  method: PaymentMethod | null,
  party: Counterparty | null,
  merchant: ResolvedMerchant,
  accountTail: string | null,
  otherTails: string[],
  ctx: UserContext,
): { type: TransactionType; subtype: TransactionSubtype | null } {
  const clean = text.replace(NOUN_PHRASES, (m) => m.replace(/\s+/g, '_'));
  const own = new Set(ctx.ownAccountTails ?? []);
  const cardBill = pack.lexicon.bill_payment.test(text) && /\b(?:credit\s+card|card\s+bill)\b/i.test(text);
  const selfTransfer =
    pack.lexicon.self_transfer.test(text) ||
    otherTails.some((tail) => own.has(tail) && tail !== accountTail) ||
    (party?.accountTail !== undefined && own.has(party.accountTail) && party.accountTail !== accountTail) ||
    (party?.vpa !== undefined && (ctx.ownVpas ?? []).map((v) => v.toLowerCase()).includes(`${party.vpa.handle}@${party.vpa.psp}`));
  const walletTopUp = /\bwallet\b/i.test(text) && (pack.lexicon.transfer.test(text) || /\b(?:added|loaded|top-?up)\b/i.test(text));

  if (cardBill) return { type: 'transfer', subtype: 'card_bill' };
  if (dir === 'DEBIT') {
    if (method === 'cash') return { type: 'transfer', subtype: null };
    if (selfTransfer) return { type: 'transfer', subtype: 'self_transfer' };
    if (walletTopUp && /\bto\b[^.]{1,30}\bwallet\b/i.test(text)) return { type: 'transfer', subtype: 'wallet_topup' };
    return { type: 'expense', subtype: merchant.kind === 'p2p' ? 'p2p' : null };
  }
  if (pack.lexicon.reversal.test(clean)) return { type: 'refund', subtype: 'reversal' };
  if (pack.lexicon.cashback.test(clean)) return { type: 'refund', subtype: 'cashback' };
  if (pack.lexicon.refund.test(clean)) return { type: 'refund', subtype: null };
  if (walletTopUp) return { type: 'transfer', subtype: 'wallet_topup' };
  if (selfTransfer) return { type: 'transfer', subtype: 'self_transfer' };
  return { type: 'income', subtype: merchant.kind === 'p2p' ? 'p2p' : null };
}

function matchTemplate(pack: CompiledPack, institutionId: string | null, body: string): { compiled: CompiledTemplate; values: string[] } | null {
  if (!institutionId) return null;
  const text = collapseSpaces(body);
  for (const compiled of pack.templatesByInstitution.get(institutionId) ?? []) {
    const m = compiled.regex.exec(text);
    if (m) return { compiled, values: m.slice(1) as string[] };
  }
  return null;
}

/**
 * Runs one message through the whole pipeline (plan T3.1): sender → eligibility → tokens →
 * roles → template → classification → merchant → category → validation → fingerprint →
 * manual-duplicate check → confidence. Pure: no storage, network or clock beyond the inputs.
 */
export function processMessage(message: NormalizedMessage, pack: CompiledPack, ctx: UserContext): PipelineResult {
  // 1. Sender (T3.2). An unknown SMS sender gets a second chance from the body (bank name or
  // IFSC, unverified: review only); otherwise unknown senders never create anything (gap E2, E5).
  const bySender = resolveSender(message.sender, message.source, pack);
  const sender = bySender.institutionId
    ? bySender
    : (resolveFromContent(message.sender, message.body, message.source, pack) ?? bySender);
  const institutionId = sender.institutionId;
  if (!institutionId) return ignored({ stage: 'INELIGIBLE', reason: 'unknown_sender' }, null);
  const country = pack.institutions.get(institutionId)?.country ?? null;
  const switches = killSwitch(pack, ctx, institutionId, country);
  if (switches.detection) return ignored({ stage: 'INELIGIBLE', reason: 'kill_switch' }, institutionId);
  if (ctx.simSlot != null && message.simSlot !== undefined && message.simSlot !== ctx.simSlot) {
    return ignored({ stage: 'INELIGIBLE', reason: 'sim_filtered' }, institutionId);
  }

  // 2. Eligibility (T3.3): safety footers are removed before looking for OTP wording (gap E1).
  const body = message.body.length > MAX_BODY_CHARS ? message.body.slice(0, MAX_BODY_CHARS) : message.body;
  let text = body;
  for (const footer of pack.lexicon.safety_footer.findAll(body)) text = blank(text, footer.start, footer.end);
  const lx = pack.lexicon;
  if (lx.otp_markers.test(text)) return ignored({ stage: 'INELIGIBLE', reason: 'otp_marker' }, institutionId);
  if (lx.promo_markers.test(text)) return ignored({ stage: 'INELIGIBLE', reason: 'promo_marker' }, institutionId);
  const creditedBack = lx.credit_verbs.test(text.replace(NOUN_PHRASES, (m) => ' '.repeat(m.length))) && (lx.reversal.test(text) || lx.refund.test(text));
  if (lx.failed.test(text) && !creditedBack) return ignored({ stage: 'INELIGIBLE', reason: 'failed_or_declined' }, institutionId);
  if (lx.non_transaction_notice.test(text)) return ignored({ stage: 'INELIGIBLE', reason: 'non_transaction_notice' }, institutionId);
  if (lx.future_or_request.test(text)) return ignored({ stage: 'INELIGIBLE', reason: 'future_or_request' }, institutionId);

  // 3. Tokens and roles (T3.4, T3.5).
  const money = findMoney(text, pack, country);
  if (money.length === 0) return ignored({ stage: 'INELIGIBLE', reason: 'no_money_token' }, institutionId);
  assignRoles(text, money, lx.balance, lx.limit);
  const amounts = money.filter((token) => token.role === 'amount');
  if (amounts.length === 0) return ignored({ stage: 'PARSE_FAILED', reason: 'no_amount' }, institutionId);
  const accounts = findAccounts(text);

  // 4. Template (T3.6): an exact published format beats the generic parser.
  const template = switches.autoCreate ? null : matchTemplate(pack, institutionId, body);
  const templateSwitches = template ? killSwitch(pack, ctx, institutionId, country, template.compiled.template.id) : null;
  const usedTemplate = template && !templateSwitches?.detection ? template : null;

  let amount = amounts[0]!;
  let dirResult: { direction: Direction; ambiguous: boolean } | null;
  let party: Counterparty | null = null;
  let dateText: string | null = null;
  let dateOrder = dateOrderFor(country, ctx);
  let templateRef: string | null = null;
  let templateTail: string | null = null;
  if (usedTemplate) {
    const t = usedTemplate.compiled.template;
    dirResult = { direction: t.direction, ambiguous: false };
    if (t.dateOrder === 'MDY' || t.dateOrder === 'DMY') dateOrder = t.dateOrder;
    let amtIndex = 0;
    const { placeholders, fields } = usedTemplate.compiled;
    for (let i = 0; i < placeholders.length; i += 1) {
      const role = fields[i];
      const value = usedTemplate.values[i] ?? '';
      if (placeholders[i] === 'AMT') {
        if (role === 'amount' && money[amtIndex]) amount = money[amtIndex]!;
        amtIndex += 1;
      }
      if (role === 'date') dateText = value;
      if (role === 'reference') templateRef = value.toUpperCase();
      if (role === 'account') templateTail = value.replace(/\D/g, '').slice(-4) || null;
      if (role === 'merchant' || role === 'counterparty') party = { raw: value, source: role === 'merchant' ? 'at' : 'template' };
    }
  } else {
    dirResult = direction(text, amount, pack, accounts);
  }
  if (!dirResult) return ignored({ stage: 'INELIGIBLE', reason: 'no_movement_wording' }, institutionId);
  const dir = dirResult.direction;
  const multipleAmounts = !usedTemplate && amounts.length > 1;

  // 5. Fields.
  const account = templateTail ? null : userAccount(text, accounts, dir);
  const accountTail = templateTail ?? account?.tail ?? null;
  const otherTails = accounts.filter((a) => a !== account && a.tail !== accountTail).map((a) => a.tail);
  const referenceNumber = templateRef ?? findReference(text, lx.reference_markers);
  const dates = findDates(dateText ?? text, dateOrder);
  const extractedDate = dates[0] ?? null;
  const transactionDate = extractedDate?.date ?? receivedDate(message.receivedAt);
  party ??= counterparty(text, dir, accounts, ctx);
  const method = usedTemplate?.compiled.template.paymentMethod ?? paymentMethod(text, pack, country);
  let merchant = resolveCounterparty(party, pack, country);

  // 6. Classification (T3.7).
  const classified = classify(text, dir, pack, method, party, merchant, accountTail, otherTails, ctx);
  let type = classified.type;
  let subtype = classified.subtype;
  if (usedTemplate) {
    const t = usedTemplate.compiled.template;
    type = t.transactionType;
    subtype = t.subtype ?? (merchant.kind === 'p2p' && (type === 'expense' || type === 'income') ? 'p2p' : null);
  }
  // Transfers have no merchant; cash withdrawals especially (the ATM is not a shop).
  if (type === 'transfer') merchant = NO_MERCHANT;

  if (merchant.key && (ctx.excludedMerchants ?? []).includes(merchant.key)) {
    return ignored({ stage: 'INELIGIBLE', reason: 'excluded_merchant' }, institutionId);
  }
  if (accountTail && (ctx.excludedAccountTails ?? []).includes(accountTail)) {
    return ignored({ stage: 'INELIGIBLE', reason: 'excluded_account' }, institutionId);
  }

  // 7. Validation (T3.13), before any duplicate check.
  const received = receivedDate(message.receivedAt);
  if (amount.amountMinor <= 0 || amount.amountMinor > MAX_AMOUNT_MINOR) return ignored({ stage: 'PARSE_FAILED', reason: 'invalid_amount' }, institutionId);
  if (dayNumber(transactionDate) > dayNumber(received) + 1) return ignored({ stage: 'PARSE_FAILED', reason: 'future_date' }, institutionId);
  if (dayNumber(transactionDate) < dayNumber(received) - MAX_AGE_DAYS) return ignored({ stage: 'PARSE_FAILED', reason: 'invalid_date' }, institutionId);
  if (!isAllowedDirectionType(dir, type)) return ignored({ stage: 'PARSE_FAILED', reason: 'unknown_type' }, institutionId);

  // 8. Category (T3.9).
  const category = resolveCategory(type, merchant, text, pack, ctx);

  // 9. Confidence (T3.10).
  const evidence: DetectionEvidence = {
    templateMatched: usedTemplate !== null,
    ...(usedTemplate ? { templateId: usedTemplate.compiled.template.id } : {}),
    institutionVerified: sender.verified,
    amountRoleUnique: !multipleAmounts,
    directionUnambiguous: !dirResult.ambiguous,
    merchantKnown: merchant.kind === 'brand' && !merchant.fuzzy,
    dateExtracted: extractedDate !== null,
    referencePresent: referenceNumber !== null,
    merchantFuzzy: merchant.fuzzy,
  };
  let tier: ConfidenceTier = scoreEvidence(evidence);
  // Money from a person may be a loan, a repayment or the user's own money: the user decides.
  if (dir === 'CREDIT' && subtype === 'p2p') tier = minTier(tier, 'medium');
  if (switches.autoCreate || templateSwitches?.autoCreate) tier = minTier(tier, 'medium');

  const reliability = {
    amount: (usedTemplate || !multipleAmounts ? 'high' : 'low') as FieldReliability,
    date: (usedTemplate || extractedDate?.certain ? 'high' : extractedDate ? 'medium' : 'low') as FieldReliability,
    direction: (dirResult.ambiguous ? 'low' : 'high') as FieldReliability,
    merchant: (merchant.kind === 'brand' && !merchant.fuzzy ? 'high' : merchant.kind === 'none' ? 'low' : 'medium') as FieldReliability,
  };

  const fingerprint = computeFingerprint({
    userId: ctx.userId,
    institutionId,
    accountTail,
    amountMinor: amount.amountMinor,
    currency: amount.currency,
    direction: dir,
    referenceNumber,
    transactionDate,
    receivedAt: message.receivedAt,
  });

  const candidate: DetectedCandidate = {
    amountMinor: amount.amountMinor,
    currency: amount.currency,
    direction: dir,
    transactionType: type,
    subtype,
    paymentMethod: method,
    institutionId,
    accountTail,
    referenceNumber,
    merchantName: merchant.name,
    merchantId: merchant.merchantId,
    merchantKind: merchant.kind,
    merchantKey: merchant.key,
    taxonomyCode: category.taxonomyCode,
    categoryId: category.categoryId,
    categorySource: category.categorySource,
    transactionDate,
    receivedAt: message.receivedAt,
    confidenceTier: tier,
    reliability,
    evidence,
    source: message.source,
    fingerprint,
  };

  // 10. Links to earlier transactions (T3.7 refund-of, T3.12 manual duplicate).
  const refundOf = type === 'refund' ? findRefundOf(candidate, ctx.recentTransactions ?? []) : null;
  if (refundOf) candidate.refundOfTransactionId = refundOf;
  const manual = findManualDuplicate(candidate, ctx.recentTransactions ?? []);

  let reasonCode: ReasonCode;
  if (multipleAmounts) reasonCode = 'multiple_amounts';
  else if (dirResult.ambiguous) reasonCode = 'ambiguous_direction';
  else if (manual) reasonCode = 'possible_manual_duplicate';
  else reasonCode = tier === 'high' ? 'auto_created' : tier === 'medium' ? 'medium_confidence' : 'low_confidence';
  if (manual) candidate.confidenceTier = minTier(tier, 'medium');

  const created = reasonCode === 'auto_created';
  return {
    terminal: created ? 'CREATED' : 'NEEDS_REVIEW',
    stage: created ? 'CREATED' : 'NEEDS_REVIEW',
    reasonCode,
    institutionId,
    candidate,
    merchantKind: merchant.kind,
  };
}

function findRefundOf(candidate: DetectedCandidate, recent: readonly RecentTransaction[]): string | null {
  const day = dayNumber(candidate.transactionDate);
  const hit = recent.find(
    (t) =>
      t.transactionType === 'expense' &&
      t.amountMinor === candidate.amountMinor &&
      t.currency === candidate.currency &&
      day - dayNumber(t.date) >= 0 &&
      day - dayNumber(t.date) <= 90 &&
      ((candidate.merchantId && t.merchantId === candidate.merchantId) || (candidate.merchantKey && t.merchantKey === candidate.merchantKey)),
  );
  return hit?.id ?? null;
}

/** A manual entry with the same amount, direction and a date within a day (plan T3.12). */
function findManualDuplicate(candidate: DetectedCandidate, recent: readonly RecentTransaction[]): RecentTransaction | null {
  const day = dayNumber(candidate.transactionDate);
  return (
    recent.find(
      (t) =>
        t.source === 'manual' &&
        t.amountMinor === candidate.amountMinor &&
        t.currency === candidate.currency &&
        t.direction === candidate.direction &&
        Math.abs(dayNumber(t.date) - day) <= 1,
    ) ?? null
  );
}

/**
 * Runs a batch (plan T3.1): each message once, repeats of a fingerprint inside the batch become
 * DUPLICATE, and an own-account debit and credit of the same amount within 3 days are paired
 * into one transfer (plan T3.7).
 */
export function processBatch(messages: readonly NormalizedMessage[], pack: CompiledPack, ctx: UserContext): PipelineResult[] {
  const seen = new Set<string>();
  const results = messages.map((message) => {
    let result: PipelineResult;
    try {
      result = processMessage(message, pack, ctx);
    } catch {
      result = ignored({ stage: 'PARSE_FAILED', reason: 'no_amount' }, null);
    }
    const fp = result.candidate?.fingerprint;
    if (fp && seen.has(fp)) return ignored({ stage: 'DUPLICATE', reason: 'duplicate_fingerprint' }, result.institutionId);
    if (fp) seen.add(fp);
    return result;
  });
  pairTransfers(results, ctx);
  return results;
}

function pairTransfers(results: PipelineResult[], ctx: UserContext) {
  const own = new Set(ctx.ownAccountTails ?? []);
  if (own.size < 2) return;
  const legs = results.filter((r) => r.candidate && r.candidate.accountTail && own.has(r.candidate.accountTail));
  for (const debit of legs) {
    const d = debit.candidate!;
    if (d.direction !== 'DEBIT' || d.transferGroupKey) continue;
    const credit = legs.find((r) => {
      const c = r.candidate!;
      return (
        c.direction === 'CREDIT' &&
        !c.transferGroupKey &&
        c.accountTail !== d.accountTail &&
        c.amountMinor === d.amountMinor &&
        c.currency === d.currency &&
        Math.abs(dayNumber(c.transactionDate) - dayNumber(d.transactionDate)) <= 3
      );
    });
    if (!credit) continue;
    for (const leg of [debit, credit]) {
      const c = leg.candidate!;
      c.transactionType = 'transfer';
      c.subtype = 'self_transfer';
      c.transferGroupKey = d.fingerprint;
      c.merchantName = null;
      c.merchantId = null;
      c.merchantKind = 'none';
      c.taxonomyCode = null;
      c.categoryId = null;
      c.categorySource = null;
      leg.merchantKind = 'none';
    }
  }
}

