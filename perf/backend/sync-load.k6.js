// k6 load test for POST /detected-transactions/sync (plan §3.2, tasks T1.6, T1.7, T9.2).
//
//   BASE_URL=https://staging.example/mobile/api/v1 TOKENS=<jwt1>,<jwt2>,… k6 run perf/backend/sync-load.k6.js
//
// Use at least 80 test users: the per-user limit (task T1.7) is 60 requests/min, and each
// iteration makes 2 requests, so fewer users would measure the rate limiter instead of /sync (20 iterations/s × 2 requests ÷ 80 users = 30 requests/min per user).
//
// Budgets: p95 <= 300 ms for a 100-item batch; 0 5xx; duplicate batches return already_synced.
import http from 'k6/http';
import { check } from 'k6';
import { randomBytes } from 'k6/crypto';

export const options = {
  scenarios: {
    batches: { executor: 'constant-arrival-rate', rate: 20, timeUnit: '1s', duration: '2m', preAllocatedVUs: 40 },
  },
  thresholds: {
    'http_req_duration{kind:batch100}': ['p(95)<300'],
    'http_req_failed': ['rate<0.001'],
  },
};

const BASE_URL = __ENV.BASE_URL;
const TOKENS = (__ENV.TOKENS || '').split(',').filter(Boolean);
if (TOKENS.length === 0) throw new Error('Set TOKENS to a comma-separated list of test-user JWTs');

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

function item(i) {
  return {
    clientId: `load-${__VU}-${__ITER}-${i}`,
    amount: `${(i % 997) + 1}.00`,
    currency: 'INR',
    direction: 'DEBIT',
    transactionType: 'expense',
    subtype: null,
    paymentMethod: 'upi',
    institutionId: 'in.hdfc_bank',
    accountTail: '1234',
    referenceNumber: null,
    merchantName: 'Load Test Merchant',
    merchantId: null,
    taxonomyCode: null,
    categoryId: null,
    categorySource: null,
    financialAccountId: null,
    transactionDate: '2026-09-23',
    receivedAt: '2026-09-23T10:00:00+05:30',
    evidence: {
      templateMatched: false, institutionVerified: true, amountRoleUnique: true, directionUnambiguous: true,
      merchantKnown: false, dateExtracted: true, referencePresent: false, merchantFuzzy: false,
    },
    confidenceTier: 'medium',
    dedupFingerprint: `v2_${hex(randomBytes(32))}`,
    source: 'android_sms',
  };
}

export default function () {
  const TOKEN = TOKENS[(__VU - 1) % TOKENS.length];
  const items = Array.from({ length: 100 }, (_, i) => item(i));
  const params = {
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'Idempotency-Key': hex(randomBytes(16)) },
    tags: { kind: 'batch100' },
  };
  const first = http.post(`${BASE_URL}/detected-transactions/sync`, JSON.stringify({ items }), params);
  check(first, { 'batch accepted': (r) => r.status === 201 || r.status === 200 });

  // Replaying the same items must be idempotent (gap D2): no 5xx, every item already_synced.
  const replay = http.post(`${BASE_URL}/detected-transactions/sync`, JSON.stringify({ items }), {
    headers: { ...params.headers, 'Idempotency-Key': hex(randomBytes(16)) },
    tags: { kind: 'replay' },
  });
  check(replay, {
    'replay not 5xx': (r) => r.status < 500,
    'replay all already_synced': (r) => {
      try {
        return JSON.parse(r.body).data.results.every((x) => x.status === 'already_synced');
      } catch {
        return false;
      }
    },
  });
}
