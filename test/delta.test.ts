import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyPackDelta,
  compilePack,
  diffPacks,
  generateSigningKeyPair,
  PackVerificationError,
  processMessage,
  satisfiesRange,
  signKnowledgePack,
  type KnowledgePack,
} from '../src';

const ROOT = join(import.meta.dirname, '..');
const base = JSON.parse(readFileSync(join(ROOT, 'packs/sample/IN.pack.json'), 'utf8')) as KnowledgePack;
const { privateKey, publicKey } = generateSigningKeyPair();
const keys = { k1: publicKey };

function nextVersion(): KnowledgePack {
  const next = structuredClone(base);
  next.meta.packVersion = base.meta.packVersion + 1;
  next.merchants.push({ id: 'm.croma', name: 'Croma', country: 'IN', taxonomyCode: 'GENERAL_MERCHANDISE' });
  next.merchantAliases.push({ merchantId: 'm.croma', alias: 'croma', country: 'IN' });
  next.merchantAliases = next.merchantAliases.filter((a) => a.alias !== 'grofers');
  next.merchants[0]!.name = 'Swiggy Ltd';
  return next;
}

describe('pack deltas (T4.3)', () => {
  it('applying a delta reproduces the signed target exactly', () => {
    const target = signKnowledgePack(nextVersion(), privateKey, 'k1');
    const delta = diffPacks(base, target);
    expect(Object.keys(delta.changes.merchants.upsert)).toEqual(['m.swiggy', 'm.croma']);
    expect(delta.changes.merchantAliases.remove).toEqual(['m.blinkit|grofers|IN']);
    expect(delta.changes.merchantAliases.order).toBeUndefined();
    const applied = applyPackDelta(base, delta, keys);
    expect(applied.payload).toEqual(target.payload);
    expect(JSON.stringify(delta).length).toBeLessThan(JSON.stringify(target).length / 5);
  });

  it('carries the full order when items were reordered', () => {
    const next = nextVersion();
    next.taxonomy.reverse();
    const target = signKnowledgePack(next, privateKey, 'k1');
    const delta = diffPacks(base, target);
    expect(delta.changes.taxonomy.order).toHaveLength(next.taxonomy.length);
    expect(applyPackDelta(base, delta, keys).payload).toEqual(target.payload);
  });

  it('rejects a delta for another base version, or one that was tampered with', () => {
    const target = signKnowledgePack(nextVersion(), privateKey, 'k1');
    const delta = diffPacks(base, target);
    expect(() => applyPackDelta({ ...base, meta: { ...base.meta, packVersion: 99 } }, delta, keys)).toThrow(PackVerificationError);
    const tampered = structuredClone(delta);
    (tampered.changes.merchants.upsert['m.croma'] as { name: string }).name = 'Evil';
    expect(() => applyPackDelta(base, tampered, keys)).toThrow(PackVerificationError);
  });
});

describe('runtime kill switches (T4.6)', () => {
  const pack = compilePack(base);
  const sms = {
    sender: 'VM-HDFCBK',
    body: 'Rs.1,250.00 debited from a/c **1234 on 23-09-26 to VPA swiggy@icici. Avl Bal Rs 20,500.00',
    receivedAt: '2026-09-23T10:00:00+05:30',
    source: 'android_sms' as const,
  };

  it('config switches apply on top of the pack, including app-version ranges', () => {
    expect(processMessage(sms, pack, { userId: 'u' }).terminal).toBe('CREATED');
    expect(
      processMessage(sms, pack, { userId: 'u', killSwitches: [{ scope: 'institution', key: 'in.hdfc_bank', action: 'disable_detection' }] }).reasonCode,
    ).toBe('kill_switch');
    const appSwitch = [{ scope: 'app_version' as const, key: '<1.2.0', action: 'disable_auto_create' as const }];
    expect(processMessage(sms, pack, { userId: 'u', appVersion: '1.1.9', killSwitches: appSwitch }).terminal).toBe('NEEDS_REVIEW');
    expect(processMessage(sms, pack, { userId: 'u', appVersion: '1.2.0', killSwitches: appSwitch }).terminal).toBe('CREATED');
  });

  it.each([
    ['1.4.2', '1.4.2', true],
    ['1.4.2', '<1.5.0', true],
    ['1.5.0', '<1.5.0', false],
    ['1.2.5', '>=1.2.0 <1.3.0', true],
    ['1.3.0', '>=1.2.0 <1.3.0', false],
    ['2.0.0-beta.1', '>=2.0.0', true],
    ['garbage', '<1.0.0', false],
  ])('%s satisfies %s → %s', (version, range, expected) => {
    expect(satisfiesRange(version, range)).toBe(expected);
  });
});
