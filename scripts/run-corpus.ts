/**
 * Golden corpus runner (task T0.3).
 *
 *   npm run corpus                      validate every case; run the pipeline once it exists
 *   npm run corpus -- --update-baseline record the currently passing case ids
 *
 * Fails the build when a case is malformed, or when a case listed in corpus/baseline.json
 * (previously passing) now fails. New failing cases are reported but don't fail CI until they
 * pass once and enter the baseline, so the corpus can hold expectations ahead of the code.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { compareCorpusResult, validateCorpusCase } from '../src/corpus/evaluate';
import type { CorpusActual, CorpusCase } from '../src/corpus/types';
import type { KnowledgePack } from '../src/pack/types';

type CorpusRunner = (testCase: CorpusCase, pack: KnowledgePack) => CorpusActual;

/** Wired to the real pipeline in task T3.1. Until then the runner only validates the corpus. */
const runner = null as CorpusRunner | null;

const ROOT = join(import.meta.dirname, '..');
const CORPUS_DIR = join(ROOT, 'corpus');
const BASELINE_FILE = join(CORPUS_DIR, 'baseline.json');
const PACK_DIR = join(ROOT, 'packs', 'sample');

function listJsonFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listJsonFiles(full);
    return name.endsWith('.json') && full !== BASELINE_FILE ? [full] : [];
  });
}

function loadPack(country: string): KnowledgePack | null {
  try {
    return JSON.parse(readFileSync(join(PACK_DIR, `${country}.pack.json`), 'utf8')) as KnowledgePack;
  } catch {
    return null;
  }
}

const errors: string[] = [];
const cases: CorpusCase[] = [];
const seen = new Set<string>();

for (const file of listJsonFiles(CORPUS_DIR)) {
  const rel = relative(ROOT, file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    errors.push(`${rel}: invalid JSON (${(error as Error).message})`);
    continue;
  }
  if (!Array.isArray(parsed)) {
    errors.push(`${rel}: must contain an array of cases`);
    continue;
  }
  const expectedInstitution = rel.split('/').pop()!.replace(/\.json$/, '');
  parsed.forEach((item, index) => {
    const label = `${rel}[${index}]`;
    const problems = validateCorpusCase(item, label);
    errors.push(...problems);
    if (problems.length > 0) return;
    const testCase = item as CorpusCase;
    if (seen.has(testCase.id)) errors.push(`${label}: duplicate id ${testCase.id}`);
    seen.add(testCase.id);
    if (testCase.institution !== expectedInstitution) {
      errors.push(`${label}: institution ${testCase.institution} must match file name ${expectedInstitution}`);
    }
    const [country] = testCase.id.split('.');
    if (country?.toUpperCase() !== testCase.country) errors.push(`${label}: id prefix must match country`);
    if (!rel.startsWith(`corpus/${testCase.country}/`)) errors.push(`${label}: file must live under corpus/${testCase.country}/`);
    cases.push(testCase);
  });
}

// Every known institution referenced by the corpus must exist in that country's pack.
const packs = new Map<string, KnowledgePack | null>();
for (const testCase of cases) {
  if (testCase.institution === 'unknown') continue;
  if (!packs.has(testCase.country)) packs.set(testCase.country, loadPack(testCase.country));
  const pack = packs.get(testCase.country);
  if (!pack) {
    errors.push(`${testCase.id}: no sample pack for ${testCase.country}`);
  } else if (!pack.institutions.some((institution) => institution.id === testCase.institution)) {
    errors.push(`${testCase.id}: institution ${testCase.institution} is not in the ${testCase.country} pack`);
  }
}

if (errors.length > 0) {
  console.error(`Corpus validation failed (${errors.length} problem${errors.length === 1 ? '' : 's'}):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

const byProvenance = cases.reduce<Record<string, number>>((acc, testCase) => {
  acc[testCase.provenance] = (acc[testCase.provenance] ?? 0) + 1;
  return acc;
}, {});
console.log(`Corpus: ${cases.length} valid cases (${Object.entries(byProvenance).map(([k, v]) => `${k} ${v}`).join(', ')}).`);

if (!runner) {
  console.log('Pipeline not implemented yet (task T3.1): cases validated, none executed.');
  process.exit(0);
}

const baseline = new Set<string>(
  (JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as { passing: string[] }).passing,
);
const passing: string[] = [];
const regressions: string[] = [];
const newFailures: string[] = [];

for (const testCase of cases) {
  const pack = packs.get(testCase.country) ?? loadPack(testCase.country);
  if (!pack) continue;
  let mismatches;
  try {
    mismatches = compareCorpusResult(testCase.expected, runner(testCase, pack));
  } catch (error) {
    mismatches = [{ field: 'terminal' as const, expected: testCase.expected.terminal, actual: `threw: ${(error as Error).message}` }];
  }
  if (mismatches.length === 0) {
    passing.push(testCase.id);
    continue;
  }
  const detail = mismatches.map((m) => `${m.field}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.actual)}`).join('; ');
  (baseline.has(testCase.id) ? regressions : newFailures).push(`${testCase.id} — ${detail}`);
}

console.log(`Passing ${passing.length}/${cases.length}.`);
if (newFailures.length > 0) {
  console.log(`Not yet passing (${newFailures.length}):`);
  for (const line of newFailures) console.log(`  - ${line}`);
}
if (process.argv.includes('--update-baseline')) {
  writeFileSync(BASELINE_FILE, `${JSON.stringify({ passing: passing.sort() }, null, 2)}\n`);
  console.log(`Baseline updated: ${passing.length} passing cases.`);
}
if (regressions.length > 0) {
  console.error(`Regressions (${regressions.length}) — these passed before:`);
  for (const line of regressions) console.error(`  - ${line}`);
  process.exit(1);
}
