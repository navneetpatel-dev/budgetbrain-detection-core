/**
 * Turns a real bank message into a corpus case skeleton with personal data replaced (task T0.3).
 *
 *   tsx scripts/anonymize-message.ts --sender VM-HDFCBK --institution in.hdfc_bank \
 *     --received 2026-09-23T10:00:00+05:30 --body "Rs.1,250.00 debited from a/c **5678 …"
 *
 * What it replaces automatically:
 *   - account/card masks (XX5678, **5678, ending 5678)   → fake tails, consistently per message
 *   - long digit runs: references, UTR/RRN, phone numbers → random digits of the same length
 *   - VPA local parts (name@okhdfcbank)                   → user1@okhdfcbank (handle kept: it names the PSP)
 *   - email addresses                                     → user1@example.com
 * What it cannot do safely: personal names. The output flags ALL-CAPS words that may be names;
 * replace them by hand before committing. Amounts, dates and merchant brands are kept, because
 * they are what the tests check.
 */
import { randomInt } from 'node:crypto';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const body = arg('body');
const sender = arg('sender');
const institution = arg('institution') ?? 'unknown';
const receivedAt = arg('received') ?? new Date().toISOString();
if (!body || !sender) {
  console.error('Usage: tsx scripts/anonymize-message.ts --sender <id> --institution <pack id> --body "<text>" [--received <iso>]');
  process.exit(2);
}

const tailMap = new Map<string, string>();
const fakeTail = (tail: string) => {
  if (!tailMap.has(tail)) tailMap.set(tail, String(1000 + tailMap.size * 1111).slice(-tail.length));
  return tailMap.get(tail)!;
};
const randomDigits = (length: number) => Array.from({ length }, (_, i) => (i === 0 ? randomInt(1, 10) : randomInt(0, 10))).join('');

let text = body;
text = text.replace(/(?<![\w%+.-])[\w%+.-]+@[\w.-]+\.[a-z]{2,}/gi, 'user1@example.com');
text = text.replace(/\b([\w.-]+)@([a-z][a-z0-9]*)\b/gi, (_m, _local, handle: string) => `user1@${handle}`);
text = text.replace(/(?<![Xx*])([Xx*]+|ending\s+|\bno\.?\s*)(\d{3,4})\b/g, (_m, prefix: string, tail: string) => `${prefix}${fakeTail(tail)}`);
text = text.replace(/(?<![\d.,])\d{8,}(?![\d.,])/g, (run) => randomDigits(run.length));

const possibleNames = [...new Set(text.match(/\b[A-Z]{3,}(?:\s+[A-Z]{2,})*\b/g) ?? [])].filter(
  (word) => !/^(?:INR|USD|UPI|NEFT|IMPS|RTGS|ATM|POS|OTP|SMS|EMI|KYC|VPA|UTR|RRN|REF|HDFC|ICICI|SBI|AXIS|KOTAK|BANK)$/.test(word),
);

const country = institution === 'unknown' ? 'IN' : institution.split('.')[0]!.toUpperCase();
const skeleton = {
  id: `${country.toLowerCase()}.${institution.split('.')[1] ?? 'unknown'}.TODO_slug`,
  provenance: 'field_anonymized',
  country,
  institution,
  language: 'en',
  input: { sender, body: text, receivedAt, source: 'android_sms' },
  expected: { terminal: 'TODO: CREATED | NEEDS_REVIEW | IGNORED' },
  notes: 'TODO',
};

console.log(JSON.stringify(skeleton, null, 2));
if (possibleNames.length > 0) {
  console.error(`\nCheck these for personal names and replace them by hand: ${possibleNames.join(', ')}`);
}
