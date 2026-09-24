# @budgetbrain/detection-core

The transaction detection pipeline shared by BudgetBrain **mobile** (live SMS and notifications), **backend** (email, imports, pasted text, server-side checks) and **web** (paste and import preview). One implementation, so the apps never disagree about what a message means.

It is pure TypeScript with **no runtime dependencies**: the audited `@noble` crypto code is bundled into the build. The same code runs on Hermes (React Native), Node 20+ and browsers.

Background: `TRANSACTION_DETECTION_GAP_ANALYSIS.md` and `TRANSACTION_DETECTION_IMPLEMENTATION_PLAN.md` in `budgetbrain-mobile`.

## Install

```bash
npm install github:navneetpatel-dev/budgetbrain-detection-core#v0.1.0
```

Pin a tag. `npm install` runs `prepare`, which builds `dist/`.

## What's in 0.1.0 (Phase 0)

| Module | Import | Purpose |
|---|---|---|
| Types | `@budgetbrain/detection-core` | `NormalizedMessage`, `DetectedCandidate`, `SyncItemPayload`, `DetectionEvidence`, lifecycle states and reason codes |
| Money | `parseDecimalToMinor`, `formatMinorToDecimal`, `parseMoney`, `minorUnits` | Integer minor units. Decimal strings on the wire, never floats. ISO 4217 minor-unit table |
| Fingerprint | `computeFingerprint` | Duplicate identity v2 (SHA-256). Deliberately excludes type and merchant |
| Knowledge packs | `validateKnowledgePack`, `signKnowledgePack`, `verifyKnowledgePack`, `canonicalJson` | Pack format, Ed25519 signing over canonical JSON, and structural plus cross-reference validation |
| Corpus | `@budgetbrain/detection-core/corpus` | Golden-corpus case types, validator and result comparison |
| Bench | `@budgetbrain/detection-core/bench` | Micro-benchmark harness that runs on Node and Hermes |

The parser itself (eligibility, tokenizer, classifier, merchant resolver, confidence) arrives in Phase 3.

## Knowledge packs

A pack is signed, versioned data that drives detection: institutions, sender ids, lexicons, templates, merchants, aliases, currencies, payment rails, taxonomy, MCC map and kill switches.

- The format is `src/pack/types.ts`, with a matching JSON Schema at `schema/knowledge-pack.schema.json`.
- `validateKnowledgePack()` also checks cross-references the schema can't express, e.g. every sender points at a real institution and every template has one field role per placeholder.
- Signatures are Ed25519 over the canonical JSON of `payload`, so key order and formatting don't matter. A `keyId` allows key rotation.
- `packs/sample/IN.pack.json` is a small sample India pack. It is signed with `packs/sample/TEST-ONLY-signing-key.json`, which is **public on purpose and must never sign a production pack**. Production packs are built and signed by the backend (plan task T4.3), and the private key lives in a secret manager.

```bash
npm run pack:validate                    # schema + cross-references + signature of the sample
npx tsx scripts/sign-pack.ts --sample    # re-sign the sample after editing it
npx tsx scripts/sign-pack.ts --new-key   # generate a key pair
```

## Golden corpus

`corpus/<COUNTRY>/<institution>.json` holds anonymized messages with the **correct** expected result. It includes all 13 sample messages from gap-analysis §4.

- Only the fields a case sets under `expected` are compared.
- A case may carry `context`, e.g. the user's own account tails, which transfer detection needs.
- `npm run corpus` validates every case. Once the pipeline exists (task T3.1) it runs them. CI fails when a case listed in `corpus/baseline.json` stops passing; `--update-baseline` records newly passing cases.

To add real messages, anonymize them first:

```bash
npx tsx scripts/anonymize-message.ts --sender VM-HDFCBK --institution in.hdfc_bank \
  --received 2026-09-23T10:00:00+05:30 --body "<message>"
```

This replaces account tails, references, phone numbers, VPAs and emails, and flags possible personal names for you to replace by hand.

## Performance

- `npm run bench` prints a Markdown table.
- `MOBILE_ENGINES_DIR=<mobile repo>/src/features/transaction-detection/engines npm run bench` also measures the current mobile engines for comparison.
- `perf/android/` has a Perfetto config and script for measuring a background (headless) detection run on an emulator.
- `perf/backend/sync-load.k6.js` load-tests `/detected-transactions/sync`.

Budgets are in plan §3.

## Development

```bash
npm ci
npm run check   # typecheck, lint (incl. regex backtracking checks), tests, build, corpus, pack
```
