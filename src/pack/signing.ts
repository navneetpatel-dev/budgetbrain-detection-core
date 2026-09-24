import { ed25519 } from '@noble/curves/ed25519.js';
import { utf8Bytes } from '../utf8';
import { canonicalJson } from './canonical';
import type { KnowledgePack, SignedKnowledgePack } from './types';
import { validateKnowledgePack } from './validate';

export class PackVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackVerificationError';
  }
}

/** Public keys the client trusts, by key id. Ship several to allow rotation. */
export type TrustedKeys = Readonly<Record<string, Uint8Array>>;

/** Signs a pack. Server-side only (pack builder, task T4.3); the private key never ships to clients. */
export function signKnowledgePack(
  pack: KnowledgePack,
  privateKey: Uint8Array,
  keyId: string,
): SignedKnowledgePack {
  const errors = validateKnowledgePack(pack);
  if (errors.length > 0) {
    throw new PackVerificationError(`Refusing to sign an invalid pack: ${errors.slice(0, 5).join('; ')}`);
  }
  const signature = ed25519.sign(utf8Bytes(canonicalJson(pack)), privateKey);
  return {
    payload: pack,
    signature: { alg: 'Ed25519', keyId, value: toBase64(signature) },
  };
}

/**
 * Verifies the signature and structure of a downloaded pack and returns its payload.
 * Throws {@link PackVerificationError} on any problem, so callers keep their last good pack (task T4.4).
 */
export function verifyKnowledgePack(signed: unknown, trustedKeys: TrustedKeys): KnowledgePack {
  if (!isRecord(signed) || !isRecord(signed.signature) || !isRecord(signed.payload)) {
    throw new PackVerificationError('Not a signed knowledge pack');
  }
  const { alg, keyId, value } = signed.signature;
  if (alg !== 'Ed25519' || typeof keyId !== 'string' || typeof value !== 'string') {
    throw new PackVerificationError('Unsupported or malformed signature');
  }
  const publicKey = trustedKeys[keyId];
  if (!publicKey) {
    throw new PackVerificationError(`Unknown signing key: ${keyId}`);
  }
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = fromBase64(value);
  } catch {
    throw new PackVerificationError('Signature is not valid base64');
  }
  const message = utf8Bytes(canonicalJson(signed.payload));
  let valid = false;
  try {
    valid = ed25519.verify(signatureBytes, message, publicKey);
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new PackVerificationError('Signature does not match pack contents');
  }
  const errors = validateKnowledgePack(signed.payload);
  if (errors.length > 0) {
    throw new PackVerificationError(`Pack failed validation: ${errors.slice(0, 5).join('; ')}`);
  }
  return signed.payload as unknown as KnowledgePack;
}

export function generateSigningKeyPair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = ed25519.utils.randomSecretKey();
  return { privateKey, publicKey: ed25519.getPublicKey(privateKey) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_PATTERN = /^(?:[A-Z0-9+/]{4})*(?:[A-Z0-9+/]{2}==|[A-Z0-9+/]{3}=)?$/i;

// Hand-rolled so the package has no dependency on Buffer (Node) or atob/btoa (not on every Hermes build).
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const triple = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += BASE64_ALPHABET[(triple >> 18) & 63];
    out += BASE64_ALPHABET[(triple >> 12) & 63];
    out += b1 === undefined ? '=' : BASE64_ALPHABET[(triple >> 6) & 63];
    out += b2 === undefined ? '=' : BASE64_ALPHABET[triple & 63];
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '');
  if (!BASE64_PATTERN.test(clean)) {
    throw new TypeError('Invalid base64');
  }
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (BASE64_ALPHABET.indexOf(clean.charAt(i)) << 18) |
      (BASE64_ALPHABET.indexOf(clean.charAt(i + 1)) << 12) |
      ((BASE64_ALPHABET.indexOf(clean.charAt(i + 2)) & 63) << 6) |
      (BASE64_ALPHABET.indexOf(clean.charAt(i + 3)) & 63);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}
