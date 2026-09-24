import type { MessageSource } from '../types/message';
import type { CompiledPack } from './compile';
import { MAX_BODY_CHARS, isWordChar } from './text';

export interface ResolvedSender {
  institutionId: string | null;
  /** The institution is in the pack and marked verified; unverified ones cap at the medium tier. */
  verified: boolean;
  /** Normalized key that was looked up (SMS header, email domain or package name). */
  key: string;
}

/**
 * `VM-HDFCBK`, `AD-HDFCBK-S` and `hdfcbk` all become `HDFCBK` (India DLT: a 2-letter
 * operator/route prefix and an optional 1-letter suffix around the 6-character header).
 */
export function normalizeSmsHeader(sender: string): string {
  let value = sender.trim().toUpperCase();
  if (/^[A-Z]{2}-/.test(value)) value = value.slice(3);
  if (/-[A-Z]$/.test(value)) value = value.slice(0, -2);
  return value;
}

/**
 * Sender → institution (plan T3.2). An exact lookup only: headers, whole senders, email domains
 * (with parent domains, so `alerts.hdfcbank.net` matches `hdfcbank.net`). Unknown senders
 * resolve to no institution.
 */
export function resolveSender(sender: string, source: MessageSource, pack: CompiledPack): ResolvedSender {
  const verified = (institutionId: string | null) =>
    institutionId !== null && (pack.institutions.get(institutionId)?.verified ?? false);

  if (source === 'email') {
    const address = sender.trim().toLowerCase();
    const exact = pack.exactSenders.get(address);
    if (exact) return { institutionId: exact, verified: verified(exact), key: address };
    let domain = address.includes('@') ? address.slice(address.lastIndexOf('@') + 1) : address;
    while (domain.includes('.')) {
      const hit = pack.emailDomains.get(domain);
      if (hit) return { institutionId: hit, verified: verified(hit), key: domain };
      domain = domain.slice(domain.indexOf('.') + 1);
    }
    return { institutionId: null, verified: false, key: address };
  }

  if (source === 'notification') {
    const key = sender.trim().toLowerCase();
    const hit = pack.exactSenders.get(key) ?? null;
    return { institutionId: hit, verified: verified(hit), key };
  }

  const header = normalizeSmsHeader(sender);
  const hit = pack.smsHeaders.get(header) ?? pack.exactSenders.get(sender.trim().toLowerCase()) ?? null;
  return { institutionId: hit, verified: verified(hit), key: header };
}

/** A phone number: people (and spoofers) send from these; banks use registered headers. */
const PHONE_NUMBER = /^\+?\d[\d\s-]{5,}$/;
const IFSC = /\b([A-Z]{4})0[A-Z0-9]{6}\b/g;

function containsWord(haystack: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : haystack[at - 1]!;
    const after = haystack[at + needle.length] ?? '';
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = at + 1;
  }
}

/**
 * Second signal for SMS from a sender the pack doesn't know (plan T3.2): the body names exactly
 * one institution, by an IFSC code or a distinctive multi-word name ("HDFC Bank"). Never for a
 * phone-number sender. The institution is returned unverified, so the item is capped at medium
 * confidence and always goes to review, never added automatically.
 */
export function resolveFromContent(
  sender: string,
  body: string,
  source: MessageSource,
  pack: CompiledPack
): ResolvedSender | null {
  if (source !== 'android_sms' && source !== 'pasted_sms') return null;
  if (PHONE_NUMBER.test(sender.trim())) return null;
  const text = body.slice(0, MAX_BODY_CHARS).toUpperCase().replace(/\s+/g, ' ');
  const found = new Set<string>();
  IFSC.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IFSC.exec(text)) !== null) {
    const id = pack.ifscPrefixes.get(m[1]!);
    if (id) found.add(id);
  }
  for (const { needle, institutionId } of pack.contentNames) {
    if (containsWord(text, needle)) found.add(institutionId);
  }
  if (found.size !== 1) return null;
  return { institutionId: [...found][0]!, verified: false, key: normalizeSmsHeader(sender) };
}
