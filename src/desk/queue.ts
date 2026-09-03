/**
 * The queue the review desk shows: scored, drafted, deduplicated, ranked.
 *
 * A PURE FUNCTION OF (feed, ledger, now). No git, no network, no clock of its
 * own. That is what makes the whole routine testable at all: the interesting
 * behaviour is "does this day produce a post", and that question is only
 * answerable if the day is an argument.
 *
 * MOST DAYS SHOULD PRODUCE NOTHING. A queue that always has something in it is
 * a queue whose floor is too low, and the failure it causes is not a wasted
 * post: it is a feed of forgettable items that teaches the audience the account
 * is noise. `emptyReason` exists so a run that yields nothing can say which
 * gate did it rather than looking like a crash.
 */

import type { FeedItem } from '../derive/feed.js';
import { countsByType, scoreItem, entityKey, POST_FLOOR_BITS, POSTABLE_TYPES, type Score } from './surprise.js';
import { correctedIds } from './ledger.js';
import { recommend, type Recommendation } from './route.js';
import { lastPostedByEntity, postedIds, type CorrectionRow, type PostedRow } from './ledger.js';

export type Candidate = {
  readonly item: FeedItem;
  readonly score: Score;
  /** One venue to press, the reason, and the rest behind it. */
  readonly route: Recommendation;
  readonly entities: readonly string[];
};

export type Queue = {
  readonly candidates: readonly Candidate[];
  /** Counts at each gate, so a silent day is explainable rather than suspicious. */
  readonly funnel: {
    readonly seen: number;
    readonly postableType: number;
    readonly notOnCooldown: number;
    readonly aboveFloor: number;
  };
};

/**
 * What the cooldown counts as "the same story".
 *
 * PREFER THE DERIVED ENTITIES, which are normalized and join a model across the
 * three names its vendor gives it. But some types carry none: a codename that
 * has not been unmasked yet refers to nothing the entity resolver can name, and
 * `entities` is correctly empty. Falling back to nothing would exempt exactly
 * the items most likely to recur day after day, because a codename reappears in
 * every capture until it resolves, and each capture gives it a fresh sha and so
 * a fresh id. The id's subject survives that, so it is the fallback: the same
 * codename is one story no matter how many times it is recaptured.
 */
export function cooldownKeys(item: FeedItem): string[] {
  if (item.entities.length > 0) return item.entities.map(entityKey);
  const subject = item.id.split(':').slice(2).join(':');
  return subject.length > 0 ? [`subject:${item.type}:${subject}`] : [];
}

export function buildQueue(
  feed: readonly FeedItem[],
  posted: readonly PostedRow[],
  now: Date,
  siteUrl: string,
  floorBits: number = POST_FLOOR_BITS,
  limit: number = 5,
  corrections: readonly CorrectionRow[] = [],
  blockedVenues: ReadonlySet<string> = new Set(),
): Queue {
  const counts = countsByType(feed);
  // The cooldown reads the UNCORRECTED rows on purpose: it asks how recently we
  // talked about a subject, and a retracted post still means the desk offered
  // that story lately. Only the hard suppression is corrected, because that is
  // the one a false row makes permanent.
  const lastByEntity = lastPostedByEntity(posted.filter((r) => !correctedIds(corrections).has(r.id)));
  const already = postedIds(posted, corrections);

  let postableType = 0;
  let notOnCooldown = 0;
  const scored: Candidate[] = [];

  for (const item of feed) {
    if (!POSTABLE_TYPES.has(item.type)) continue;
    postableType += 1;

    const keys = cooldownKeys(item);
    const score = scoreItem(item, counts, lastByEntity, now, keys);
    if (score === null) continue; // cooldown
    notOnCooldown += 1;

    if (score.bits < floorBits) continue;

    // A candidate with nowhere left to go is not a candidate. Reachable two
    // ways: a sentence too long for every venue its type routes to, and an item
    // that has already been to all of them.
    const route = recommend(item, siteUrl, already, blockedVenues);
    if (route.primary === null) continue;

    scored.push({ item, score, route, entities: keys });
  }

  scored.sort((a, b) => b.score.bits - a.score.bits || (a.item.id < b.item.id ? -1 : 1));

  // One per entity per run. Without this a capture that retires four models in
  // one family fills the desk with four near-identical posts, and approving all
  // four is exactly the behaviour that gets an account marked as a spammer.
  const seenEntity = new Set<string>();
  const out: Candidate[] = [];
  for (const c of scored) {
    if (c.entities.some((e) => seenEntity.has(e))) continue;
    for (const e of c.entities) seenEntity.add(e);
    out.push(c);
    if (out.length >= limit) break;
  }

  return {
    candidates: out,
    funnel: { seen: feed.length, postableType, notOnCooldown, aboveFloor: scored.length },
  };
}
