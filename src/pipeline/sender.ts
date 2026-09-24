import type { MessageSource } from '../types/message';
import type { CompiledPack } from './compile';

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
