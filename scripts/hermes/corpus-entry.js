/* global print */
// Bundled by scripts/hermes-corpus.mjs and run inside the Hermes CLI: no Node APIs here.
import { compilePack, formatMinorToDecimal, fromBase64, processMessage, verifyKnowledgePack } from '../../dist/index.js';
import pack from '../../packs/sample/IN.pack.json';
import signedPack from '../../packs/sample/IN.pack.signed.json';
import trusted from '../../packs/trusted-keys.json';
import cases from 'virtual:corpus';

const compiled = compilePack(pack);
let pass = 0;
const failures = [];
for (const c of cases) {
  const r = processMessage(c.input, compiled, { userId: 'corpus-user', ...(c.context || {}) });
  const k = r.candidate;
  const actual = { terminal: r.terminal, reasonCode: r.reasonCode, institutionId: r.institutionId };
  if (k) {
    Object.assign(actual, {
      direction: k.direction, transactionType: k.transactionType, subtype: k.subtype,
      amount: formatMinorToDecimal(k.amountMinor, k.currency), currency: k.currency,
      transactionDate: k.transactionDate, accountTail: k.accountTail, referenceNumber: k.referenceNumber,
      merchantKind: k.merchantKind, merchantName: k.merchantName, merchantId: k.merchantId, paymentMethod: k.paymentMethod,
    });
  }
  const bad = Object.keys(c.expected).filter((field) => {
    const want = c.expected[field];
    const got = actual[field] === undefined ? null : actual[field];
    return field === 'merchantName' ? String(want).toLowerCase() !== String(got).toLowerCase() : want !== got;
  });
  if (bad.length) failures.push(c.id + ' ' + bad.map((f) => f + '=' + JSON.stringify(actual[f])).join(' '));
  else pass += 1;
}
const start = Date.now();
const rounds = 20;
for (let i = 0; i < rounds; i += 1) for (const c of cases) processMessage(c.input, compiled, { userId: 'u' });
const perMessage = (Date.now() - start) / (rounds * cases.length);
// Pack signature check on the device runtime (plan T4.4): Ed25519 over the canonical JSON.
const keys = {};
for (const id of Object.keys(trusted)) keys[id] = fromBase64(trusted[id]);
const verifyStart = Date.now();
let verifyError = null;
try {
  verifyKnowledgePack(signedPack, keys);
} catch (error) {
  verifyError = String(error && error.message);
}
const verifyMs = Date.now() - verifyStart;
print(JSON.stringify({ pass, failures, perMessageMs: perMessage, verifyError, verifyMs }));
