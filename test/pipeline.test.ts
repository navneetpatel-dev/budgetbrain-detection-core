import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KnowledgePack } from '../src/pack/types';
import type { NormalizedMessage } from '../src/types/message';
import {
  categoryForTaxonomy,
  compilePack,
  findDates,
  findMoney,
  jaroWinkler,
  merchantKey,
  parseAmount,
  processBatch,
  processMessage,
  rawDomain,
  resolveMerchantName,
  resolveFromContent,
  resolveSender,
  type UserContext,
} from '../src/pipeline';

const ROOT = join(import.meta.dirname, '..');
const rawPack = JSON.parse(readFileSync(join(ROOT, 'packs/sample/IN.pack.json'), 'utf8')) as KnowledgePack;
const pack = compilePack(rawPack);
const ctx: UserContext = { userId: 'user-1' };
const RECEIVED = '2026-09-23T10:00:00+05:30';

function sms(body: string, sender = 'VM-HDFCBK', extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return { sender, body, receivedAt: RECEIVED, source: 'android_sms', ...extra };
}

const SWIGGY = 'Rs.1,250.00 debited from a/c **1234 on 23-09-26 to VPA swiggy@icici. Avl Bal Rs 20,500.00';

describe('sender resolver (T3.2)', () => {
  it('resolves DLT headers and rejects unknown senders', () => {
    expect(resolveSender('VM-HDFCBK', 'android_sms', pack)).toMatchObject({ institutionId: 'in.hdfc_bank', verified: true });
    expect(resolveSender('AD-HDFCBK-S', 'android_sms', pack).institutionId).toBe('in.hdfc_bank');
    expect(resolveSender('FINOTE', 'android_sms', pack)).toMatchObject({ institutionId: null, verified: false });
  });

  it('resolves email domains, including subdomains, and notification packages', () => {
    expect(resolveSender('alerts@icicibank.com', 'email', pack).institutionId).toBe('in.icici_bank');
    expect(resolveSender('noreply@alerts.hdfcbank.net', 'email', pack).institutionId).toBe('in.hdfc_bank');
    expect(resolveSender('net.one97.paytm', 'notification', pack).institutionId).toBe('in.paytm_payments_bank');
  });
});

describe('content signal for unknown SMS senders (T3.2)', () => {
  const BODY = 'Rs.1,250.00 debited from your HDFC Bank a/c **1234 on 23-09-26 to VPA swiggy@icici. Ref 425612345678';

  it('recognises one institution named in the body, unverified', () => {
    expect(resolveFromContent('JM-NEWHDR', BODY, 'android_sms', pack)).toMatchObject({ institutionId: 'in.hdfc_bank', verified: false });
    expect(resolveFromContent('', 'IMPS to a/c 1234 IFSC SBIN0001234 of Rs 500 done', 'pasted_sms', pack)).toMatchObject({
      institutionId: 'in.state_bank_of_india',
    });
    expect(resolveFromContent('AX-XYZ', 'Rs 100 credited to your Kotak Mahindra Bank Ltd a/c', 'android_sms', pack)?.institutionId).toBe(
      'in.kotak_mahindra_bank'
    );
  });

  it('refuses phone-number senders, several banks, one-word names, other sources and partial words', () => {
    expect(resolveFromContent('+919876543210', BODY, 'android_sms', pack)).toBeNull();
    expect(resolveFromContent('98765 43210', BODY, 'android_sms', pack)).toBeNull();
    expect(resolveFromContent('JM-NEWHDR', 'Transfer from HDFC Bank to Axis Bank of Rs 500', 'android_sms', pack)).toBeNull();
    expect(resolveFromContent('JM-NEWHDR', 'Rs 500 paid via SBI card', 'android_sms', pack)).toBeNull();
    expect(resolveFromContent('alerts@unknown.com', BODY, 'email', pack)).toBeNull();
    expect(resolveFromContent('JM-NEWHDR', 'Rs 500 at XHDFC BANKS store', 'android_sms', pack)).toBeNull();
  });

  it('sends such a message to review, never adds it automatically', () => {
    const result = processMessage(sms(BODY, 'JM-NEWHDR'), pack, ctx);
    expect(result.institutionId).toBe('in.hdfc_bank');
    expect(result.candidate?.evidence.institutionVerified).toBe(false);
    expect(result.candidate?.confidenceTier).not.toBe('high');
    expect(result.terminal).toBe('NEEDS_REVIEW');
    // A phone number with the same text is still ignored.
    expect(processMessage(sms(BODY, '+919876543210'), pack, ctx)).toMatchObject({ terminal: 'IGNORED', reasonCode: 'unknown_sender' });
  });
});

describe('tokenizer (T3.4)', () => {
  it.each([
    ['1,25,000.00', 'INR', 12500000],
    ['1250.5', 'INR', 125050],
    ['5,00,000', 'INR', 50000000],
    ['1.234,56', 'EUR', 123456],
    ['12.99', 'USD', 1299],
    ['1,000', 'USD', 100000],
    ['5000', 'JPY', 5000],
  ])('parses %s %s', (raw, currency, minor) => {
    expect(parseAmount(raw, currency)).toBe(minor);
  });

  it('detects $, €, £ and ISO codes, and marks balances and limits', () => {
    const tokens = findMoney('Spent $12.99, €5 and £3.50 plus AED 45.00. Avl Bal Rs 1,000. Avl Lmt Rs 5,000', pack, 'IN');
    expect(tokens.map((t) => t.currency)).toEqual(['USD', 'EUR', 'GBP', 'AED', 'INR', 'INR']);
    const all = findMoney('Avl Bal Rs 20,500.00. Rs 1,250.00 debited', pack, 'IN');
    expect(all).toHaveLength(2);
  });

  it('reads dates by the institution country and never shifts them through UTC (gap X1)', () => {
    expect(findDates('On 05/09/26 Ref', 'DMY')[0]?.date).toBe('2026-09-05');
    expect(findDates('On 05/09/26 Ref', 'MDY')[0]?.date).toBe('2026-05-09');
    expect(findDates('on 23-Sep-26;', 'DMY')[0]).toMatchObject({ date: '2026-09-23', certain: true });
    expect(findDates('on Sep 23, 2026 at', 'DMY')[0]?.date).toBe('2026-09-23');
    expect(findDates('on 2026-09-20.', 'MDY')[0]?.date).toBe('2026-09-20');
    expect(findDates('valid till 31-02-26', 'DMY')).toEqual([]);
  });
});

describe('eligibility (T3.3)', () => {
  it('strips safety footers before looking for OTP wording (gap E1)', () => {
    const result = processMessage(sms('Rs 2,500 spent on HDFC Bank Card xx1111 at DMART on 2026-09-20. Never share your OTP/PIN'), pack, ctx);
    expect(result.terminal).toBe('CREATED');
  });

  it('keeps a reversal credit even though it says "failed"', () => {
    const result = processMessage(sms('INR 450.00 credited to A/c XX5678 towards reversal of failed UPI txn. Ref 427812345678', 'VM-AXISBK'), pack, ctx);
    expect(result.candidate).toMatchObject({ transactionType: 'refund', subtype: 'reversal' });
  });

  it('gives every stop a stage and a reason code', () => {
    expect(processMessage(sms('Your OTP is 123456'), pack, ctx)).toMatchObject({ terminal: 'IGNORED', stage: 'INELIGIBLE', reasonCode: 'otp_marker' });
    expect(processMessage(sms('Hello from your bank'), pack, ctx)).toMatchObject({ stage: 'INELIGIBLE', reasonCode: 'no_money_token' });
    expect(processMessage(sms('Avl Bal Rs 500.00 as of today'), pack, ctx)).toMatchObject({ stage: 'PARSE_FAILED', reasonCode: 'no_amount' });
  });
});

describe('roles and direction (T3.5)', () => {
  it('treats "credit card" as a noun, not money coming in', () => {
    const result = processMessage(sms('Rs 999 spent on your Credit Card XX1111 at ZOMATO on 22-09-26'), pack, ctx);
    expect(result.candidate).toMatchObject({ direction: 'DEBIT', transactionType: 'expense' });
  });

  it('sends several amounts to review instead of guessing', () => {
    const result = processMessage(sms('Rs 500 and Rs 300 debited from a/c XX1234 on 23-09-26'), pack, ctx);
    expect(result).toMatchObject({ terminal: 'NEEDS_REVIEW', reasonCode: 'multiple_amounts' });
    expect(result.candidate?.confidenceTier).toBe('low');
  });
});

describe('templates (T3.6)', () => {
  it('a template hit sets templateMatched and its id in the evidence', () => {
    const result = processMessage(
      sms('Sent Rs.500.00 From HDFC Bank A/C *1234 To RAMESH KUMAR On 05/09/26 Ref 425612345678 Not You? Call 18001234567/SMS BLOCK UPI to 7000000001', 'AD-HDFCBK'),
      pack,
      ctx,
    );
    expect(result.candidate?.evidence).toMatchObject({ templateMatched: true, templateId: 'in.hdfc_bank.upi_debit.v1' });
    expect(result.candidate).toMatchObject({ amountMinor: 50000, accountTail: '1234', transactionDate: '2026-09-05', subtype: 'p2p' });
  });
});

describe('classifier (T3.7)', () => {
  it('an own counterparty account makes a self transfer', () => {
    const body = 'Rs 2000 transferred from A/c XX4455 to A/c XX9988 (HDFC Bank). Ref 1234567890';
    expect(processMessage(sms(body, 'JD-SBIINB'), pack, ctx).candidate?.transactionType).not.toBe('transfer');
    expect(processMessage(sms(body, 'JD-SBIINB'), pack, { ...ctx, ownAccountTails: ['4455', '9988'] }).candidate).toMatchObject({
      transactionType: 'transfer',
      subtype: 'self_transfer',
      merchantKind: 'none',
    });
  });

  it('pairs an own debit and credit of the same amount into one transfer', () => {
    const own = { ...ctx, ownAccountTails: ['1234', '5678'] };
    const [debit, credit] = processBatch(
      [
        sms('Rs 5,000.00 debited from a/c XX1234 on 23-09-26. Ref 111122223333'),
        sms('Rs 5,000.00 credited to A/c XX5678 on 24-09-26. Ref 999988887777', 'VM-AXISBK', { receivedAt: '2026-09-24T09:00:00+05:30' }),
      ],
      pack,
      own,
    );
    expect(debit?.candidate?.transactionType).toBe('transfer');
    expect(credit?.candidate?.transactionType).toBe('transfer');
    expect(debit?.candidate?.transferGroupKey).toBe(credit?.candidate?.transferGroupKey);
  });

  it('suggests the original purchase for a refund of the same merchant and amount', () => {
    const result = processMessage(sms('Rs 500 refund credited to your a/c XX1234 from AMAZON'), pack, {
      ...ctx,
      recentTransactions: [
        { id: 'tx-9', amountMinor: 50000, currency: 'INR', direction: 'DEBIT', transactionType: 'expense', date: '2026-09-01', source: 'manual', merchantId: 'm.amazon' },
      ],
    });
    expect(result.candidate?.refundOfTransactionId).toBe('tx-9');
  });
});

describe('merchant resolver (T3.8)', () => {
  it('never turns an unknown shop into a brand (gap M1)', () => {
    expect(resolveMerchantName('local kirana store', pack, 'IN')).toMatchObject({ kind: 'raw', name: 'Local Kirana Store', merchantId: null });
  });

  it('cleans rails, domains, legal suffixes and store numbers', () => {
    expect(merchantKey('UPI-GLOBEX PVT LTD')).toBe('globex');
    expect(resolveMerchantName('NETFLIX.COM', pack, 'IN').merchantId).toBe('m.netflix');
    expect(resolveMerchantName('AMAZON PAY INDIA', pack, 'IN').merchantId).toBe('m.amazon');
    expect(resolveMerchantName('DMART 0423', pack, 'IN').merchantId).toBe('m.dmart');
  });

  it('matches fuzzily only for a close single word, and flags it', () => {
    expect(jaroWinkler('zomato', 'zomatto')).toBeGreaterThan(0.92);
    expect(resolveMerchantName('ZOMATTO', pack, 'IN')).toMatchObject({ merchantId: 'm.zomato', fuzzy: true });
    expect(resolveMerchantName('ZEBRONICS', pack, 'IN').kind).toBe('raw');
  });

  it('never matches fuzzily across brands: different Wikidata ids or domains (T3.8)', () => {
    const merchant = (id: string, name: string, extra: Partial<KnowledgePack['merchants'][number]> = {}) => ({
      id, name, country: 'IN', taxonomyCode: 'GENERAL_MERCHANDISE', ...extra,
    });
    const withMerchants = (merchants: KnowledgePack['merchants'][number][]) =>
      compilePack({
        ...rawPack,
        merchants: [...rawPack.merchants, ...merchants],
        merchantAliases: [...rawPack.merchantAliases, ...merchants.map((m) => ({ merchantId: m.id, alias: m.name.toLowerCase() }))],
      });

    // Two close brands with different Wikidata ids: "kalyani" is as near to either, so neither is guessed.
    const twoBrands = withMerchants([
      merchant('m.kalyana', 'Kalyana', { wikidataId: 'Q900001' }),
      merchant('m.kalyane', 'Kalyane', { wikidataId: 'Q900002' }),
    ]);
    expect(resolveMerchantName('KALYANI', twoBrands, 'IN')).toMatchObject({ kind: 'raw', merchantId: null });

    // Two catalog entries of one brand (same Wikidata id) are not a conflict.
    const oneBrand = withMerchants([
      merchant('m.kalyana', 'Kalyana', { wikidataId: 'Q900001' }),
      merchant('m.kalyana_2', 'Kalyane', { wikidataId: 'Q900001' }),
    ]);
    expect(resolveMerchantName('KALYANI', oneBrand, 'IN')).toMatchObject({ kind: 'brand', fuzzy: true });

    // The sample pack's Flipkart and a new "Flipkarts" are two brands: "FLIPKART5" is close to both.
    const nearFlipkart = withMerchants([merchant('m.flipkarts', 'Flipkarts', { domain: 'flipkarts.com' })]);
    expect(resolveMerchantName('FLIPKART5', nearFlipkart, 'IN')).toMatchObject({ kind: 'raw', merchantId: null });

    // A name carrying its own domain never matches a brand with another domain.
    const withDomain = withMerchants([merchant('m.qwikmarts', 'Qwikmarts', { domain: 'qwikmarts.com' })]);
    expect(resolveMerchantName('QWIKMART5', withDomain, 'IN')).toMatchObject({ merchantId: 'm.qwikmarts', fuzzy: true });
    expect(resolveMerchantName('QWIKMART5.IN', withDomain, 'IN')).toMatchObject({ kind: 'raw', merchantId: null });
    expect(resolveMerchantName('WWW.QWIKMARTS.COM', withDomain, 'IN')).toMatchObject({ merchantId: 'm.qwikmarts', fuzzy: false });
    expect(rawDomain('POS 1234 NETFLIX.COM')).toBe('netflix.com');
    expect(rawDomain('SWIGGY')).toBeNull();
  });

  it('a VPA gives a clean name, not the text around it (gap X4)', () => {
    expect(processMessage(sms(SWIGGY), pack, ctx).candidate).toMatchObject({ merchantName: 'Swiggy', merchantId: 'm.swiggy' });
  });
});

describe('category resolver (T3.9)', () => {
  it('user rule → knowledge base → context → Other; nothing for income and transfers', () => {
    const rule = processMessage(sms(SWIGGY), pack, { ...ctx, merchantRules: { swiggy: { categoryId: 'cat-food' } } });
    expect(rule.candidate).toMatchObject({ categoryId: 'cat-food', categorySource: 'rule' });
    expect(processMessage(sms(SWIGGY), pack, ctx).candidate).toMatchObject({ taxonomyCode: 'FOOD_AND_DRINK.RESTAURANT', categorySource: 'knowledge_base' });
    expect(processMessage(sms('Rs 300 debited from a/c XX1234 at local kirana store on 23-09-26'), pack, ctx).candidate?.categorySource).toBe('context');
    expect(processMessage(sms('Rs 300 debited from a/c XX1234 at BLUE DOOR on 23-09-26'), pack, ctx).candidate).toMatchObject({
      taxonomyCode: 'OTHER',
      categorySource: 'fallback',
    });
    expect(processMessage(sms('Salary of Rs 50,000.00 credited to a/c XX1234 on 23-09-26 by ACME CORP'), pack, ctx).candidate).toMatchObject({
      taxonomyCode: null,
      categorySource: null,
    });
  });

  it('maps a taxonomy code to a user category by exact name, then the parent name', () => {
    expect(categoryForTaxonomy('FOOD_AND_DRINK.RESTAURANT', [{ id: 'c1', name: 'Food' }], pack)).toBe('c1');
    expect(categoryForTaxonomy('FOOD_AND_DRINK.RESTAURANT', [{ id: 'c2', name: 'Food & Drink' }], pack)).toBeNull();
  });
});

describe('confidence (T3.10)', () => {
  it('a message with no date, reference or known merchant is not high (gap F1, gap-doc §4 row 12)', () => {
    const result = processMessage(sms('Rs 1000 added to your Paytm Wallet from HDFC Bank a/c XX1234', 'BZ-PAYTMB'), pack, ctx);
    expect(result.candidate?.confidenceTier).toBe('medium');
    expect(result.candidate?.reliability.date).toBe('low');
  });
});

describe('fingerprint (T3.11)', () => {
  it('is the same for one message arriving as an SMS and as a notification', () => {
    const body = 'Paid Rs 180 to SWIGGY from Paytm Wallet. Txn ID 20260923112233. Updated balance Rs 820';
    const viaSms = processMessage(sms(body, 'BZ-PAYTMB'), pack, ctx);
    const viaNotification = processMessage({ ...sms(body, 'net.one97.paytm'), source: 'notification' }, pack, ctx);
    expect(viaSms.candidate?.fingerprint).toBeDefined();
    expect(viaNotification.candidate?.fingerprint).toBe(viaSms.candidate?.fingerprint);
  });
});

describe('manual duplicate (T3.12) and validation order (T3.13)', () => {
  it('a manual ₹450 on the same day sends the detected ₹450 to review, never drops it', () => {
    const result = processMessage(sms('Rs 450.00 debited from a/c XX1234 on 23-09-26 at CHAI POINT. Ref 123456789012'), pack, {
      ...ctx,
      recentTransactions: [{ id: 'm1', amountMinor: 45000, currency: 'INR', direction: 'DEBIT', transactionType: 'expense', date: '2026-09-23', source: 'manual' }],
    });
    expect(result).toMatchObject({ terminal: 'NEEDS_REVIEW', reasonCode: 'possible_manual_duplicate' });
  });

  it('rejects a future date before any duplicate check', () => {
    const result = processMessage(sms('Rs 450.00 debited from a/c XX1234 on 30-09-26. Ref 123456789012'), pack, {
      ...ctx,
      recentTransactions: [{ id: 'm1', amountMinor: 45000, currency: 'INR', direction: 'DEBIT', transactionType: 'expense', date: '2026-09-30', source: 'manual' }],
    });
    expect(result).toMatchObject({ terminal: 'IGNORED', stage: 'PARSE_FAILED', reasonCode: 'future_date' });
  });

  it('a batch keeps the first copy of a message and marks repeats DUPLICATE', () => {
    const [first, second] = processBatch([sms(SWIGGY), sms(SWIGGY)], pack, ctx);
    expect(first?.terminal).toBe('CREATED');
    expect(second).toMatchObject({ terminal: 'IGNORED', stage: 'DUPLICATE', reasonCode: 'duplicate_fingerprint' });
  });
});

describe('user settings and kill switches', () => {
  it('applies SIM, excluded merchant and excluded account filters', () => {
    expect(processMessage(sms(SWIGGY, 'VM-HDFCBK', { simSlot: 2 }), pack, { ...ctx, simSlot: 1 }).reasonCode).toBe('sim_filtered');
    expect(processMessage(sms(SWIGGY), pack, { ...ctx, excludedMerchants: ['swiggy'] }).reasonCode).toBe('excluded_merchant');
    expect(processMessage(sms(SWIGGY), pack, { ...ctx, excludedAccountTails: ['1234'] }).reasonCode).toBe('excluded_account');
  });

  it('a pack kill switch stops detection or caps auto-create', () => {
    const off = compilePack({ ...rawPack, killSwitches: [{ scope: 'institution', key: 'in.hdfc_bank', action: 'disable_detection' }] });
    expect(processMessage(sms(SWIGGY), off, ctx).reasonCode).toBe('kill_switch');
    const review = compilePack({ ...rawPack, killSwitches: [{ scope: 'country', key: 'IN', action: 'disable_auto_create' }] });
    expect(processMessage(sms(SWIGGY), review, ctx).terminal).toBe('NEEDS_REVIEW');
  });
});

describe('Hermes safety (T3.14)', () => {
  it('pipeline sources use no regex lookbehind or Unicode property escapes', () => {
    const dir = join(ROOT, 'src/pipeline');
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(?:\*|\/\/)/.test(line))
        .join('\n');
      expect(source, file).not.toMatch(/\(\?<[=!]/);
      expect(source, file).not.toMatch(/\\p\{/);
    }
  });
});
