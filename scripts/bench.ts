/**
 * Performance baseline (task T0.5).
 *
 *   npm run bench
 *   MOBILE_ENGINES_DIR=../budgetbrain-mobile/src/features/transaction-detection/engines npm run bench
 *
 * The second form also measures the current (v1) mobile engines over the corpus bodies, so the
 * new pipeline can be compared against today's code on the same machine.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bench, formatBenchTable, type BenchResult } from '../src/bench/harness';
import { computeFingerprint } from '../src/fingerprint/fingerprint';
import { parseDecimalToMinor } from '../src/money/money';
import { canonicalJson } from '../src/pack/canonical';
import { fromBase64, verifyKnowledgePack } from '../src/pack/signing';
import { validateKnowledgePack } from '../src/pack/validate';
import type { CorpusCase } from '../src/corpus/types';
import { compilePack, processMessage } from '../src/pipeline';

const ROOT = join(import.meta.dirname, '..');
const corpusDir = join(ROOT, 'corpus', 'IN');
const cases = readdirSync(corpusDir).flatMap(
  (file) => JSON.parse(readFileSync(join(corpusDir, file), 'utf8')) as CorpusCase[],
);
const bodies = cases.map((c) => c.input);
const signedPack = JSON.parse(readFileSync(join(ROOT, 'packs', 'sample', 'IN.pack.signed.json'), 'utf8'));
const trusted = JSON.parse(readFileSync(join(ROOT, 'packs', 'trusted-keys.json'), 'utf8')) as Record<string, string>;
const keys = Object.fromEntries(Object.entries(trusted).map(([id, b64]) => [id, fromBase64(b64)]));

const results: BenchResult[] = [];

results.push(
  bench('fingerprint v2 (sha256)', cases, (c) =>
    computeFingerprint({
      userId: 'user-1',
      institutionId: c.institution,
      accountTail: '1234',
      amountMinor: 125000,
      currency: 'INR',
      direction: 'DEBIT',
      referenceNumber: null,
      transactionDate: '2026-09-23',
      receivedAt: c.input.receivedAt,
    }),
  ),
);
results.push(bench('parseDecimalToMinor', ['1250.00', '0.5', '125000.75', '12.99'], (v) => parseDecimalToMinor(v, 'INR'), { iterations: 20000 }));
results.push(bench('pack canonicalJson (IN sample)', [signedPack.payload], (p) => canonicalJson(p), { warmup: 20, iterations: 200 }));
results.push(bench('pack validate (IN sample)', [signedPack.payload], (p) => validateKnowledgePack(p), { warmup: 20, iterations: 200 }));
results.push(bench('pack verify signature + validate (IN sample)', [signedPack], (p) => verifyKnowledgePack(p, keys), { warmup: 5, iterations: 50 }));

// Parser v2 hot path (plan T3.14): budget p95 ≤ 1 ms per message in Node.
const compiled = compilePack(signedPack.payload);
results.push(bench('compilePack (IN sample)', [signedPack.payload], (p) => compilePack(p), { warmup: 20, iterations: 200 }));
const pipeline = bench('parser v2 processMessage, full message', bodies, (m) => processMessage(m, compiled, { userId: 'user-1' }), {
  warmup: 500,
  iterations: 5000,
});
results.push(pipeline);
const budgetMs = 1;

const enginesDir = process.env.MOBILE_ENGINES_DIR;
if (enginesDir) {
  const dir = resolve(enginesDir);
  const load = async (name: string) => import(pathToFileURL(join(dir, `${name}.engine.ts`)).href);
  const [eligibility, detector, extractor, classifier, merchant, confidence] = await Promise.all(
    ['eligibility', 'detector', 'extractor', 'classifier', 'merchant', 'confidence'].map(load),
  );
  results.push(
    bench('mobile v1 engines, full message', bodies, (m) => {
      if (!eligibility.isMessageEligible(m.sender, m.body)) return null;
      const signals = detector.detectFinancialMovement(m.body);
      if (!signals.direction) return null;
      const extracted = extractor.extractTransactionDetails(m.body, m.receivedAt);
      const type = classifier.classifyTransactionType(signals.direction, signals, m.body);
      const resolved = merchant.resolveMerchant(extracted.rawMerchantCandidate);
      return confidence.evaluateConfidence(m.sender, extracted.amount, signals.direction, resolved.normalizedMerchant, extracted.referenceNumber, extracted.transactionDate) && type;
    }),
  );
}

console.log(formatBenchTable(results));
console.log(`\nNode ${process.version}, ${process.platform}/${process.arch}, ${bodies.length} corpus messages.`);
if (process.argv.includes('--check') && pipeline.p95Ms > budgetMs) {
  console.error(`parser v2 p95 ${pipeline.p95Ms.toFixed(3)} ms is over the ${budgetMs} ms budget (plan §3.1, T3.14)`);
  process.exit(1);
}
