import { canonicalJson } from './canonical';
import type { KnowledgePack, PackMeta, PackSignature, SignedKnowledgePack } from './types';
import { PackVerificationError, verifyKnowledgePack, type TrustedKeys } from './signing';

/**
 * Pack deltas (plan T4.3). A delta carries the changed items of each collection plus the full
 * order of item keys in the target pack, and the target pack's own signature. The client applies
 * it to the pack it has and verifies the result with that signature, so a delta needs no separate
 * signing scheme and a wrong or tampered delta is rejected like a bad full pack.
 */

type Collection = Exclude<keyof KnowledgePack, 'meta'>;

const KEYS: { [C in Collection]: (item: KnowledgePack[C][number]) => string } = {
  institutions: (i) => i.id,
  senders: (s) => `${s.channel}|${s.match}|${s.key}|${s.institutionId}`,
  lexicons: (l) => `${l.language}|${l.class}`,
  templates: (t) => t.id,
  merchants: (m) => m.id,
  merchantAliases: (a) => `${a.merchantId}|${a.alias}|${a.country ?? ''}`,
  currencies: (c) => c.code,
  paymentRails: (r) => r.id,
  taxonomy: (t) => t.code,
  mcc: (m) => m.mcc,
  killSwitches: (k) => `${k.scope}|${k.key}|${k.action}`,
};

const COLLECTIONS = Object.keys(KEYS) as Collection[];

export interface CollectionDelta<T> {
  /** Keys removed from the base. */
  remove: string[];
  /** Items that are new or changed, keyed by their key. */
  upsert: Record<string, T>;
  /**
   * Every key of the target, in target order, only when it isn't "base order minus removals,
   * then new items in upsert order" (the usual case, so most deltas omit it).
   */
  order?: string[];
}

export interface KnowledgePackDelta {
  kind: 'delta';
  baseVersion: number;
  meta: PackMeta;
  changes: { [C in Collection]: CollectionDelta<KnowledgePack[C][number]> };
  /** Signature of the full target pack. */
  targetSignature: PackSignature;
}

function impliedOrder(baseKeys: string[], removed: string[], added: string[]): string[] {
  const gone = new Set(removed);
  return [...baseKeys.filter((key) => !gone.has(key)), ...added];
}

function keyOf<C extends Collection>(collection: C, item: KnowledgePack[C][number]): string {
  return (KEYS[collection] as (item: KnowledgePack[C][number]) => string)(item);
}

/** The delta that turns `base` into the signed `target`. */
export function diffPacks(base: KnowledgePack, target: SignedKnowledgePack): KnowledgePackDelta {
  const changes = {} as KnowledgePackDelta['changes'];
  for (const collection of COLLECTIONS) {
    const before = new Map<string, string>();
    for (const item of base[collection] as KnowledgePack[typeof collection][number][]) {
      before.set(keyOf(collection, item), canonicalJson(item));
    }
    const order: string[] = [];
    const upsert: Record<string, unknown> = {};
    for (const item of target.payload[collection] as KnowledgePack[typeof collection][number][]) {
      const key = keyOf(collection, item);
      order.push(key);
      if (before.get(key) !== canonicalJson(item)) upsert[key] = item;
    }
    const kept = new Set(order);
    const remove = [...before.keys()].filter((key) => !kept.has(key));
    const implied = impliedOrder([...before.keys()], remove, order.filter((key) => !before.has(key)));
    const sameOrder = implied.length === order.length && implied.every((key, i) => key === order[i]);
    (changes as Record<string, unknown>)[collection] = sameOrder ? { remove, upsert } : { remove, upsert, order };
  }
  return {
    kind: 'delta',
    baseVersion: base.meta.packVersion,
    meta: { ...target.payload.meta, baseVersion: base.meta.packVersion },
    changes,
    targetSignature: target.signature,
  };
}

/**
 * Applies a delta and verifies the result with the target signature. Throws
 * {@link PackVerificationError} when the base doesn't match or the result doesn't verify, so the
 * caller keeps its current pack (plan T4.4).
 */
export function applyPackDelta(base: KnowledgePack, delta: KnowledgePackDelta, trustedKeys: TrustedKeys): SignedKnowledgePack {
  if (delta.kind !== 'delta') throw new PackVerificationError('Not a pack delta');
  if (delta.baseVersion !== base.meta.packVersion || delta.meta.country !== base.meta.country) {
    throw new PackVerificationError(`Delta is for ${delta.meta.country} v${delta.baseVersion}, not v${base.meta.packVersion}`);
  }
  const meta: PackMeta = { ...delta.meta };
  delete meta.baseVersion;
  const result = { meta } as KnowledgePack;
  for (const collection of COLLECTIONS) {
    const current = new Map<string, unknown>();
    for (const item of base[collection] as KnowledgePack[typeof collection][number][]) current.set(keyOf(collection, item), item);
    const change = delta.changes[collection];
    if (!change) throw new PackVerificationError(`Delta is missing ${collection}`);
    const added = Object.keys(change.upsert).filter((key) => !current.has(key));
    const order = change.order ?? impliedOrder([...current.keys()], change.remove, added);
    const items = order.map((key) => {
      const item = Object.prototype.hasOwnProperty.call(change.upsert, key) ? change.upsert[key] : current.get(key);
      if (item === undefined) throw new PackVerificationError(`Delta references unknown ${collection} item ${key}`);
      return item;
    });
    (result as unknown as Record<string, unknown>)[collection] = items;
  }
  const signed: SignedKnowledgePack = { payload: result, signature: delta.targetSignature };
  verifyKnowledgePack(signed, trustedKeys);
  return signed;
}
