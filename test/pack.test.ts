import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  fromBase64,
  generateSigningKeyPair,
  PackVerificationError,
  signKnowledgePack,
  toBase64,
  validateKnowledgePack,
  verifyKnowledgePack,
  type KnowledgePack,
} from '../src';

const ROOT = join(import.meta.dirname, '..');
const readJson = (...parts: string[]) => JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8'));
const samplePack = (): KnowledgePack => readJson('packs', 'sample', 'IN.pack.json');

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats.default(ajv);
const schemaValidate = ajv.compile(readJson('schema', 'knowledge-pack.schema.json'));

describe('canonicalJson', () => {
  it('sorts keys at every level and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
  });

  it('is independent of key order', () => {
    expect(canonicalJson({ x: 1, y: 'é' })).toBe(canonicalJson({ y: 'é', x: 1 }));
  });

  it('rejects values JSON cannot represent', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
  });
});

describe('base64', () => {
  it('round-trips every length', () => {
    for (let length = 0; length < 70; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 255);
      const encoded = toBase64(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
      expect(fromBase64(encoded)).toEqual(bytes);
    }
  });

  it.each(['abc', 'ab=c', '====', 'a!bc', 'A==='])('rejects %j', (value) => {
    expect(() => fromBase64(value)).toThrow(TypeError);
  });
});

describe('sign / verify', () => {
  const { privateKey, publicKey } = generateSigningKeyPair();
  const keys = { k1: publicKey };

  it('verifies a freshly signed pack', () => {
    const signed = signKnowledgePack(samplePack(), privateKey, 'k1');
    expect(verifyKnowledgePack(signed, keys).meta.country).toBe('IN');
  });

  it('survives a JSON round trip with reordered keys', () => {
    const signed = signKnowledgePack(samplePack(), privateKey, 'k1');
    const reordered = JSON.parse(JSON.stringify({ signature: signed.signature, payload: signed.payload }));
    expect(() => verifyKnowledgePack(reordered, keys)).not.toThrow();
  });

  it('rejects tampered contents', () => {
    const signed = signKnowledgePack(samplePack(), privateKey, 'k1');
    signed.payload.merchantAliases.push({ merchantId: 'm.swiggy', alias: 'kirana' });
    expect(() => verifyKnowledgePack(signed, keys)).toThrow(PackVerificationError);
  });

  it('rejects unknown keys, wrong keys and malformed envelopes', () => {
    const signed = signKnowledgePack(samplePack(), privateKey, 'k1');
    expect(() => verifyKnowledgePack(signed, {})).toThrow(/Unknown signing key/);
    expect(() => verifyKnowledgePack(signed, { k1: generateSigningKeyPair().publicKey })).toThrow(PackVerificationError);
    expect(() => verifyKnowledgePack({ ...signed, signature: { ...signed.signature, value: '!!' } }, keys)).toThrow(PackVerificationError);
    expect(() => verifyKnowledgePack(null, keys)).toThrow(PackVerificationError);
  });

  it('refuses to sign an invalid pack', () => {
    const pack = samplePack();
    pack.senders.push({ institutionId: 'in.nope', channel: 'sms', match: 'header', key: 'NOPE' });
    expect(() => signKnowledgePack(pack, privateKey, 'k1')).toThrow(/invalid pack/);
  });

  it('verifies the committed signed sample with the committed test key', () => {
    const trusted = readJson('packs', 'trusted-keys.json') as Record<string, string>;
    const keys = Object.fromEntries(Object.entries(trusted).map(([id, b64]) => [id, fromBase64(b64)]));
    expect(() => verifyKnowledgePack(readJson('packs', 'sample', 'IN.pack.signed.json'), keys)).not.toThrow();
  });
});

describe('validateKnowledgePack', () => {
  it('accepts the sample pack, and so does the JSON Schema', () => {
    expect(validateKnowledgePack(samplePack())).toEqual([]);
    expect(schemaValidate(samplePack())).toBe(true);
  });

  const broken: [string, (p: KnowledgePack) => void, RegExp][] = [
    ['sender → unknown institution', (p) => { p.senders[0]!.institutionId = 'in.nope'; }, /senders\[0\]\.institutionId/],
    ['lowercase SMS header', (p) => { p.senders[0]!.key = 'hdfcbk'; }, /uppercase/],
    ['duplicate institution id', (p) => { p.institutions.push({ ...p.institutions[0]! }); }, /duplicate id/],
    ['template placeholder / field mismatch', (p) => { p.templates[0]!.fields.pop(); }, /one role per placeholder/],
    ['template without amount', (p) => { p.templates[0]!.fields = p.templates[0]!.fields.map(() => 'ignore'); }, /must contain an amount/],
    ['unknown placeholder', (p) => { p.templates[0]!.skeleton += ' <FOO>'; }, /unknown placeholder/],
    ['alias → unknown merchant', (p) => { p.merchantAliases[0]!.merchantId = 'm.nope'; }, /unknown merchant/],
    ['uppercase alias', (p) => { p.merchantAliases[0]!.alias = 'Swiggy'; }, /lowercase/],
    ['merchant → unknown taxonomy', (p) => { p.merchants[0]!.taxonomyCode = 'NOPE'; }, /unknown taxonomy/],
    ['wrong minor units', (p) => { p.currencies[0]!.minorUnits = 3; }, /must be 2 for INR/],
    ['same decimal and group separator', (p) => { p.currencies[0]!.groupSeparator = '.'; }, /must differ/],
    ['bad schema version', (p) => { (p.meta as { schemaVersion: number }).schemaVersion = 2; }, /schemaVersion/],
    ['missing section', (p) => { delete (p as Partial<KnowledgePack>).lexicons; }, /lexicons: must be an array/],
    ['bad kill switch action', (p) => { p.killSwitches.push({ scope: 'institution', key: 'x', action: 'explode' as never }); }, /unknown action/],
  ];

  it.each(broken)('catches: %s', (_label, mutate, pattern) => {
    const pack = samplePack();
    mutate(pack);
    const errors = validateKnowledgePack(pack);
    expect(errors.join('\n')).toMatch(pattern);
  });

  it('schema and validator agree on structural errors', () => {
    const structural: ((p: KnowledgePack) => void)[] = [
      (p) => { (p.meta as { schemaVersion: number }).schemaVersion = 2; },
      (p) => { delete (p as Partial<KnowledgePack>).lexicons; },
      (p) => { p.templates[0]!.fields = p.templates[0]!.fields.map(() => 'ignore'); },
      (p) => { p.killSwitches.push({ scope: 'institution', key: 'x', action: 'explode' as never }); },
      (p) => { p.merchants[0]!.mcc = '12'; },
    ];
    for (const mutate of structural) {
      const pack = samplePack();
      mutate(pack);
      expect(validateKnowledgePack(pack).length).toBeGreaterThan(0);
      expect(schemaValidate(pack)).toBe(false);
    }
  });
});
