/**
 * Signs a knowledge pack.
 *
 *   PACK_SIGNING_KEY=<base64 32-byte Ed25519 secret> PACK_KEY_ID=prod-2026-09 \
 *     tsx scripts/sign-pack.ts <pack.json> <out.signed.json>
 *
 *   tsx scripts/sign-pack.ts --sample   re-signs the sample pack with the TEST-ONLY key
 *   tsx scripts/sign-pack.ts --new-key  prints a fresh key pair (store the secret in a secret manager)
 *
 * Production signing happens in the backend pack builder (task T4.3); this script exists for
 * local work and for the sample pack used in tests.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromBase64, generateSigningKeyPair, signKnowledgePack, toBase64 } from '../src/pack/signing';
import type { KnowledgePack } from '../src/pack/types';

const ROOT = join(import.meta.dirname, '..');
const args = process.argv.slice(2);

if (args.includes('--new-key')) {
  const { privateKey, publicKey } = generateSigningKeyPair();
  console.log(JSON.stringify({ secretKey: toBase64(privateKey), publicKey: toBase64(publicKey) }, null, 2));
  process.exit(0);
}

let input: string;
let output: string;
let secret: Uint8Array;
let keyId: string;

if (args.includes('--sample')) {
  const testKey = JSON.parse(readFileSync(join(ROOT, 'packs', 'sample', 'TEST-ONLY-signing-key.json'), 'utf8')) as {
    keyId: string;
    secretKey: string;
  };
  input = join(ROOT, 'packs', 'sample', 'IN.pack.json');
  output = join(ROOT, 'packs', 'sample', 'IN.pack.signed.json');
  secret = fromBase64(testKey.secretKey);
  keyId = testKey.keyId;
} else {
  const [inFile, outFile] = args;
  const envKey = process.env.PACK_SIGNING_KEY;
  const envKeyId = process.env.PACK_KEY_ID;
  if (!inFile || !outFile || !envKey || !envKeyId) {
    console.error('Usage: PACK_SIGNING_KEY=… PACK_KEY_ID=… tsx scripts/sign-pack.ts <pack.json> <out.json>');
    process.exit(2);
  }
  input = inFile;
  output = outFile;
  secret = fromBase64(envKey);
  keyId = envKeyId;
}

const pack = JSON.parse(readFileSync(input, 'utf8')) as KnowledgePack;
const signed = signKnowledgePack(pack, secret, keyId);
writeFileSync(output, `${JSON.stringify(signed, null, 2)}\n`);
console.log(`Signed ${input} with key ${keyId} → ${output}`);
