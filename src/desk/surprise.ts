/**
 * How newsworthy is one item, in bits.
 *
 * THE ARCHIVE GRADES ITS OWN NOVELTY. A catalogue that has recorded four
 * hundred price changes and two model retirements is telling you which of those
 * is news, and it is telling you numerically: the information content of an
 * event of type t is -log2 P(t), so a type that fires once in four hundred
 * carries about 8.6 bits and one that fires every third capture carries 1.6.
 * That is not a metaphor, it is Shannon's definition, and it means the ranking
 * moves on its own as the world changes. When model retirements become routine
 * they stop being news here without anyone editing a weight.
 *
 * WHAT THIS DOES NOT MEASURE, and the reason a human still approves every post:
 * rarity in this archive is a proxy for "not routine", not for "a stranger will
 * care". A source that breaks and emits one malformed event is maximally rare
 * and completely uninteresting. The floor and the type allowlist below cut the
 * obvious cases; the rest is what the approve step is for. Nothing in this file
 * should ever be given the authority to post on its own.
 *
 * EVERY COMPONENT IS IN BITS so they can be added at all. A penalty of "-4"
 * means the item must be sixteen times rarer to survive it, which is a claim
 * you can argue with. A penalty of "-0.3 points" would not be.
 */

import type { FeedItem, FeedType } from '../derive/feed.js';

/**
 * The types a post may be built from.
 *
 * Deliberately narrower than HEADLINE_TYPES in the renderer. A headline earns a
 * slot on a page the reader already chose to open; a post interrupts someone
 * who did not. `post_listed` and `upstream_pr_opened` clear the first bar and
 * not the second: "a company published a blog post" is not worth a stranger's
 * attention even when it is worth a row on our front page.
 */
export const POSTABLE_TYPES: ReadonlySet<FeedType> = new Set<FeedType>([
  'model_added',
  'model_removed',
  'retirement_floor',
  'codename_entered',
  'codename_unmasked',
  'stealth_listing',
  'incident_opened',
  'upstream_pr_merged',
]);

/** Below this, nothing goes to the desk. Most days should produce nothing. */
export const POST_FLOOR_BITS = 4.5;

/** An item about an entity posted within this many days is held. */
export const COOLDOWN_DAYS = 5;

/** News decays. One bit per day means a two-day-old item needs 2x the rarity. */
export const STALENESS_BITS_PER_DAY = 1;

/**
 * Charged when the item cannot be checked against a stored artifact. The whole
 * proposition of this site is that a skeptic can verify the claim, so a post
 * that cannot be verified is not just weaker, it is off-message. Four bits is a
 * factor of sixteen: survivable in principle, and nothing has survived it yet.
 */
export const UNVERIFIABLE_PENALTY_BITS = 4;

export type ScoreComponent = { readonly label: string; readonly bits: number };

export type Score = {
  readonly bits: number;
  /** Every term, so the desk can show WHY and a human can disagree with it. */
  readonly components: readonly ScoreComponent[];
};

/**
 * Laplace-smoothed information content of the item's type over the archive.
 *
 * The +1 / +K is not decoration. Without it a type seen once in a young archive
 * scores as if it were certain never to recur, and the first capture of any new
 * source would top the queue forever. With it, one occurrence in a 400-item
 * archive of 20 types reads as about 7.7 bits rather than 8.6, and the gap
 * closes as evidence accumulates, which is the correct direction.
 */
export function typeBits(type: FeedType, counts: ReadonlyMap<FeedType, number>): number {
  let total = 0;
  for (const n of counts.values()) total += n;
  const kinds = Math.max(counts.size, 1);
  const p = ((counts.get(type) ?? 0) + 1) / (total + kinds);
  return -Math.log2(p);
}

export function countsByType(feed: readonly FeedItem[]): Map<FeedType, number> {
  const counts = new Map<FeedType, number>();
  for (const item of feed) counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
  return counts;
}

/** Whole days from `stamp` to `now`, floored at 0 so a clock skew cannot pay a bonus. */
export function ageDays(iso: string, now: Date): number {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, (now.getTime() - then) / 86_400_000);
}

/**
 * The score, with its working shown.
 *
 * `postedEntities` maps an entity key to the ISO instant it was last posted
 * about. It is read from the append-only ledger, so the cooldown survives a
 * restart, a new machine and a rebuilt working tree: the ledger is the state.
 */
export function scoreItem(
  item: FeedItem,
  counts: ReadonlyMap<FeedType, number>,
  postedEntities: ReadonlyMap<string, string>,
  now: Date,
  keys: readonly string[] = item.entities.map(entityKey),
): Score | null {
  if (!POSTABLE_TYPES.has(item.type)) return null;

  for (const key of keys) {
    const last = postedEntities.get(key);
    if (last !== undefined && ageDays(last, now) < COOLDOWN_DAYS) return null;
  }

  const components: ScoreComponent[] = [];
  const bitsForType = typeBits(item.type, counts);
  components.push({ label: `${item.type} is rare in the archive`, bits: bitsForType });

  if (item.stamp !== null) {
    const days = ageDays(item.stamp.iso, now);
    if (days >= 1) {
      components.push({ label: `${days.toFixed(1)} days old`, bits: -days * STALENESS_BITS_PER_DAY });
    }
  }

  // path is the stored artifact the claim is checked against. Empty means the
  // derivation produced a sentence with nothing behind it, which is a bug
  // upstream, but the scorer must not be the thing that assumes it cannot happen.
  if (item.path.length === 0) {
    components.push({ label: 'no stored artifact to check it against', bits: -UNVERIFIABLE_PENALTY_BITS });
  }

  let bits = 0;
  for (const c of components) bits += c.bits;
  return { bits, components };
}

/** Stable identity for the cooldown. Entities are already normalized upstream. */
export function entityKey(entity: { kind: string; id: string }): string {
  return `${entity.kind}:${entity.id}`;
}
