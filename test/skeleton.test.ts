import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KnowledgePack, PackTemplate } from '../src/pack/types';
import { TEMPLATE_PLACEHOLDERS } from '../src/pack/types';
import { buildSkeleton, compilePack } from '../src/pipeline';

const ROOT = join(import.meta.dirname, '..');
const rawPack = JSON.parse(readFileSync(join(ROOT, 'packs/sample/IN.pack.json'), 'utf8')) as KnowledgePack;
const pack = compilePack(rawPack);
const sms = (body: string, sender = 'VM-HDFCBK') => ({ sender, body, source: 'android_sms' as const });

const UPI = 'Rs.1,250.00 debited from a/c **1234 on 23-09-26 to VPA swiggy@icici Ref 425612345678. Avl Bal Rs 20,500.00';
const CARD = 'INR 4,999.00 spent on HDFC Bank Card xx1111 at CROMA RETAIL on 2026-09-20 11:42:05. Ref 123456789012. Not you? Call 18002586161';
const CREDIT = 'Rs 15,000.00 credited to A/c XX9876 on 22-Sep-26 by NEFT from RAHUL SHARMA. Info: rent for flat 4B';

describe('message skeletons (T7.4)', () => {
  it('keeps the shape of a message and masks everything personal', () => {
    const upi = buildSkeleton(sms(UPI), pack)!;
    expect(upi.skeleton).toBe('Rs.<AMT> debited from a/c <ACCT> on <DATE> to VPA <VPA> Ref <REF>. Avl Bal Rs <AMT>');
    expect(upi).toMatchObject({ institutionId: 'in.hdfc_bank', senderKey: 'HDFCBK' });
    expect(upi.hash).toMatch(/^[0-9a-f]{64}$/);

    expect(buildSkeleton(sms(CARD), pack)!.skeleton).toBe(
      'INR <AMT> spent on HDFC Bank Card <ACCT> at <NAME> on <DATE> <TIME>. Ref <REF>. Not you? Call <REF>'
    );
    expect(buildSkeleton(sms(CREDIT), pack)!.skeleton).toBe(
      'Rs <AMT> credited to A/c <ACCT> on <DATE> by NEFT from <NAME>. Info: <NAME> for <NAME> <NUM>'
    );
  });

  it('leaks no digits, names or addresses, and uses only template placeholders', () => {
    const allowed = new Set<string>(TEMPLATE_PLACEHOLDERS);
    for (const body of [UPI, CARD, CREDIT, 'Paid Rs 99 to priya.s@okaxis. Details: https://bank.example/t/8812 or mail help@bank.example']) {
      const { skeleton } = buildSkeleton(sms(body), pack)!;
      expect(skeleton, body).not.toMatch(/\d/);
      for (const secret of ['swiggy', 'croma', 'rahul', 'sharma', 'rent', 'flat', 'priya', 'example', 'http', 'help@']) {
        expect(skeleton.toLowerCase(), body).not.toContain(secret);
      }
      for (const [, name] of skeleton.matchAll(/<([A-Z]+)>/g)) expect(allowed.has(name!), `${name} in ${skeleton}`).toBe(true);
    }
  });

  it('gives the same hash to the same shape with different values, and a new hash to a new shape', () => {
    const a = buildSkeleton(sms(UPI), pack)!;
    const b = buildSkeleton(sms(UPI.replace('1,250.00', '75.50').replace('swiggy@icici', 'zomato@hdfcbank').replace('**1234', '**9999')), pack)!;
    const c = buildSkeleton(sms(UPI.replace('debited from', 'withdrawn from')), pack)!;
    expect(b.hash).toBe(a.hash);
    expect(c.hash).not.toBe(a.hash);
  });

  it('is publishable: the skeleton, used as a template, matches the message it came from', () => {
    for (const body of [UPI, CARD, CREDIT]) {
      const { skeleton, institutionId } = buildSkeleton(sms(body), pack)!;
      const fields = [...skeleton.matchAll(/<([A-Z]+)>/g)].map(() => 'ignore' as const);
      const template: PackTemplate = {
        id: 't.learned',
        institutionId: institutionId!,
        version: 1,
        language: 'en',
        skeleton,
        fields,
        direction: 'DEBIT',
        transactionType: 'expense',
      };
      const compiled = compilePack({ ...rawPack, templates: [template] });
      const regex = compiled.templatesByInstitution.get(institutionId!)!.find((t) => t.template.id === 't.learned')!.regex;
      expect(regex.test(body), skeleton).toBe(true);
    }
  });

  it('returns null for an empty message', () => {
    expect(buildSkeleton(sms('   '), pack)).toBeNull();
  });
});
