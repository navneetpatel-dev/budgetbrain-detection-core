// Types shared by every consumer (mobile, backend, web).
export * from './types/message';
export * from './types/transaction';
export * from './types/lifecycle';

// Money: integer minor units, decimal strings on the wire.
export * from './money/currencies';
export * from './money/money';

// Confidence tiers, direction/type rules and balance effect.
export * from './confidence/evidence';

// Duplicate identity.
export * from './fingerprint/fingerprint';

// Knowledge packs.
export * from './pack/types';
export * from './pack/canonical';
export * from './pack/validate';
export {
  PackVerificationError,
  signKnowledgePack,
  verifyKnowledgePack,
  generateSigningKeyPair,
  toBase64,
  fromBase64,
  type TrustedKeys,
} from './pack/signing';
