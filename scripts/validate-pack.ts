/**
 * Validates a knowledge pack file: JSON Schema, cross-references, and (for signed packs) the
 * signature against the trusted keys in packs/trusted-keys.json.
 *
 *   npm run pack:validate                      the signed sample pack
 *   tsx scripts/validate-pack.ts <file.json>   any pack or signed pack
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { validateKnowledgePack } from '../src/pack/validate';
import { fromBase64, verifyKnowledgePack } from '../src/pack/signing';

const ROOT = join(import.meta.dirname, '..');
const file = process.argv[2];
if (!file) {
  console.error('Usage: tsx scripts/validate-pack.ts <pack.json>');
  process.exit(2);
}

const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
const schema = JSON.parse(readFileSync(join(ROOT, 'schema', 'knowledge-pack.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats.default(ajv);
const validateSchema = ajv.compile(schema);

let failed = false;
if (!validateSchema(data)) {
  failed = true;
  console.error('JSON Schema errors:');
  for (const error of validateSchema.errors ?? []) console.error(`  - ${error.instancePath || '/'} ${error.message}`);
}

const isSigned = typeof data === 'object' && data !== null && 'signature' in data;
const payload = isSigned ? (data as unknown as { payload: unknown }).payload : data;
const problems = validateKnowledgePack(payload);
if (problems.length > 0) {
  failed = true;
  console.error('Pack validation errors:');
  for (const problem of problems) console.error(`  - ${problem}`);
}

if (isSigned && !failed) {
  const trusted = JSON.parse(readFileSync(join(ROOT, 'packs', 'trusted-keys.json'), 'utf8')) as Record<string, string>;
  const keys = Object.fromEntries(Object.entries(trusted).map(([id, b64]) => [id, fromBase64(b64)]));
  try {
    verifyKnowledgePack(data, keys);
  } catch (error) {
    failed = true;
    console.error(`Signature: ${(error as Error).message}`);
  }
}

if (failed) process.exit(1);
console.log(`${file}: valid${isSigned ? ' and signature verified' : ''}.`);
