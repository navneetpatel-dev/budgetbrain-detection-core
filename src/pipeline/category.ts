import type { DetectedCandidate, TransactionType } from '../types/transaction';
import type { CompiledPack } from './compile';
import type { ResolvedMerchant } from './merchant';
import type { UserContext } from './types';

/**
 * Category resolver (plan T3.9): user rule → merchant knowledge base → MCC → context words →
 * Other. Only expenses and refunds get a spending category; income and transfers get none.
 * Category names are never matched by substring (gap C5).
 */

/** Context words → taxonomy code, used only when nothing better is known. English for now. */
const CONTEXT_WORDS: readonly { pattern: RegExp; code: string }[] = [
  { pattern: /\b(?:petrol|diesel|fuel|hpcl|bpcl|indian oil)\b/i, code: 'TRANSPORTATION.GAS' },
  { pattern: /\b(?:electricity|water bill|gas bill|broadband|dth|postpaid|recharge)\b/i, code: 'RENT_AND_UTILITIES' },
  { pattern: /\b(?:restaurant|cafe|food|dining)\b/i, code: 'FOOD_AND_DRINK.RESTAURANT' },
  { pattern: /\b(?:grocery|groceries|supermarket|kirana)\b/i, code: 'FOOD_AND_DRINK.GROCERIES' },
  { pattern: /\b(?:uber|ola|taxi|cab|metro)\b/i, code: 'TRANSPORTATION.TAXIS_AND_RIDE_SHARES' },
];

export interface CategoryResult {
  taxonomyCode: string | null;
  categoryId: string | null;
  categorySource: DetectedCandidate['categorySource'];
}

export function resolveCategory(
  type: TransactionType,
  merchant: ResolvedMerchant,
  text: string,
  pack: CompiledPack,
  ctx: UserContext,
  mcc: string | null = null,
): CategoryResult {
  if (type !== 'expense' && type !== 'refund') return { taxonomyCode: null, categoryId: null, categorySource: null };
  const known = (code: string | null | undefined) => (code && pack.taxonomy.has(code) ? code : null);

  const rule = merchant.key ? ctx.merchantRules?.[merchant.key] : undefined;
  if (rule) return { taxonomyCode: known(rule.taxonomyCode), categoryId: rule.categoryId, categorySource: 'rule' };

  const kb = known(merchant.merchant?.taxonomyCode);
  if (kb) return { taxonomyCode: kb, categoryId: null, categorySource: 'knowledge_base' };

  const fromMcc = known((mcc && pack.mcc.get(mcc)) || null);
  if (fromMcc) return { taxonomyCode: fromMcc, categoryId: null, categorySource: 'mcc' };

  const context = CONTEXT_WORDS.find((entry) => entry.pattern.test(`${text} ${merchant.name ?? ''}`));
  const fromContext = known(context?.code);
  if (fromContext) return { taxonomyCode: fromContext, categoryId: null, categorySource: 'context' };

  return { taxonomyCode: known('OTHER'), categoryId: null, categorySource: 'fallback' };
}

/**
 * Maps a taxonomy code to one of the user's categories by exact, case-insensitive name: the
 * node's own name first, then its parent's. Returns null when neither matches.
 */
export function categoryForTaxonomy(
  code: string | null,
  userCategories: readonly { id: string; name: string }[],
  pack: CompiledPack,
): string | null {
  let current = code;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const node = pack.taxonomy.get(current);
    if (!node) return null;
    const name = node.name.trim().toLowerCase();
    const hit = userCategories.find((category) => category.name.trim().toLowerCase() === name);
    if (hit) return hit.id;
    current = node.parent;
  }
  return null;
}
