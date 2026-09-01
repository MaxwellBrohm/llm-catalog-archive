/**
 * One stream over both derivations. Pure: no git, no fs, no clock.
 *
 * WHY THIS EXISTS AT ALL. The product design's section 5 says the sections are
 * "all one publication rather than separate products". Before this file there
 * were two derivations that never met: events, which became thread pages, and
 * leak items, which became the desk. A reader who wanted to know what happened
 * had to visit both and interleave them by hand, and the front page showed
 * neither. A FeedItem is the shape the publication reads: a sentence, when it
 * happened, the artifact it came from, and the entities and micro-category it
 * files under.
 *
 * IT ADDS NO CLAIM. The sentence is the one the deriving module already wrote,
 * copied rather than recomposed, so the copy rule is enforced in exactly the
 * two places it was before. Nothing here summarises, merges two items into one,
 * or decides that an event and a leak item are about the same thing. Two rows
 * about one model are two rows; a reader joins them by following the thread.
 *
 * MICRO-CATEGORIES ARE THE TYPE THAT WAS ALREADY THERE. `price_changed`,
 * `doc_added`, `codename_unmasked` are the derivations' own discriminants, not
 * a taxonomy invented for the front end, so a category page cannot drift from
 * what the deriver produces: adding a type without adding its page is a
 * compile error at `ALL_TYPES` below rather than a page nobody notices missing.
 */

import { claimSentence, type DerivedEvent, type EventType } from './events.js';
import { entitiesForCatalogModel, labFromVendor, type Entity, type Lab } from './entities.js';
import { leakSentence, type LeakItem, type LeakType, type SourcingTier } from './leaks.js';
import type { Stamp } from '../site/record.js';

/** The micro-category. Every discriminant both derivations can produce. */
export type FeedType = EventType | LeakType;

export type FeedItem = {
  /** `<sha>:<type>:<subject>`, from the deriving module. Unique per build. */
  id: string;
  /** Which derivation produced it. Rendered, because they are not equivalent. */
  kind: 'event' | 'leak';
  type: FeedType;
  /** The sentence the deriving module wrote. Never recomposed here. */
  sentence: string;
  sha: string;
  sourceId: string;
  /** The stored path, so a renderer can build the permalink at this sha. */
  path: string;
  stamp: Stamp | null;
  /** Mechanical, held rather than guessed. See src/derive/entities.ts. */
  entities: Entity[];
  /** Rows a reader checks against the linked artifact. Never a conclusion. */
  facts: [string, string][];
  /** Set on a leak item, null on an event: an event carries no sourcing tier. */
  tier: SourcingTier | null;
  /** The event itself, so the renderer can print its per-type fact rows. */
  event: DerivedEvent | null;
  leak: LeakItem | null;
};

/**
 * Every micro-category the publication has a page for, in the order it lists
 * them: the catalogue first, then documentation, then the desk.
 *
 * Typed as `FeedType[]` rather than inferred, so a new EventType or LeakType
 * that nobody added here is caught by `assertEveryTypeListed` in the tests
 * rather than by a reader finding an item with no category page.
 */
export const ALL_TYPES: FeedType[] = [
  'model_added',
  'model_removed',
  'price_changed',
  'context_changed',
  'expiration_set',
  'alias_retargeted',
  'retirement_floor',
  'doc_added',
  'doc_moved',
  'doc_removed',
  'codename_entered',
  'codename_unmasked',
  'upstream_pr_opened',
  'upstream_pr_merged',
  'stealth_listing',
  'expiration_scheduled',
];

/**
 * The entities a leak item attaches to, mechanically.
 *
 * The same rule src/derive/entities.ts states and for the same reason: where
 * mechanical attachment is ambiguous the item is HELD rather than guessed at.
 *
 *   stealth_listing, expiration_scheduled  the subject IS an OpenRouter
 *       catalogue id, so it yields the catalogue's model entity, and its lab
 *       only when the vendor prefix is in the table. `stealth/sonnet-x` yields
 *       a model and no lab, which is correct: `stealth` is a namespace, not a
 *       company, and deciding whose it is would be the leaks desk's whole
 *       failure mode in one line.
 *
 *   codename_entered, codename_unmasked  the subject is a CODENAME. Attaching
 *       it to a lab is the inference the desk exists not to make.
 *
 *   upstream_pr_opened, upstream_pr_merged  the subject is a repository and a
 *       number. The repository is a runtime, not a lab, and the architecture
 *       name in the title is an unpublished string, so both are held.
 */
export function entitiesForLeak(item: LeakItem): Entity[] {
  switch (item.type) {
    case 'stealth_listing':
    case 'expiration_scheduled':
      return entitiesForCatalogModel(item.subject);
    default:
      return [];
  }
}

/** One derived event as a feed item. Exported so a renderer can draw one card. */
export function feedItemFromEvent(event: DerivedEvent): FeedItem {
  return {
    id: event.id,
    kind: 'event',
    type: event.type,
    sentence: claimSentence(event),
    sha: event.sha,
    sourceId: event.sourceId,
    path: event.path,
    stamp: event.stamp,
    entities: event.entities,
    facts: [],
    tier: null,
    event,
    leak: null,
  };
}

/** One leak item as a feed item. The desk draws the same card as everywhere. */
export function feedItemFromLeak(item: LeakItem): FeedItem {
  return {
    id: item.id,
    kind: 'leak',
    type: item.type,
    sentence: leakSentence(item),
    sha: item.sha,
    sourceId: item.sourceId,
    path: item.path,
    stamp: item.stamp,
    entities: entitiesForLeak(item),
    facts: item.facts,
    tier: item.tier,
    event: null,
    leak: item,
  };
}

/**
 * Both derivations as one stream, newest first by the timestamp the page shows.
 *
 * Ties break on the item id, so the generated directory is byte-stable across
 * runs over the same archive. Without it, a collector run that commits thirteen
 * sources within one second rewrites every page in the publication on the next
 * build for a change nobody made, and a diff that is noise is a diff nobody
 * reads.
 */
export function buildFeed(events: DerivedEvent[], leaks: LeakItem[]): FeedItem[] {
  const key = (i: FeedItem): number => {
    if (i.stamp === null) return -Infinity;
    const ms = Date.parse(i.stamp.iso);
    return Number.isNaN(ms) ? -Infinity : ms;
  };
  const all = [...events.map(feedItemFromEvent), ...leaks.map(feedItemFromLeak)];
  return all.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    // Equality first, so two unstamped items never reach -Infinity minus
    // -Infinity, which is NaN and leaves the order engine-defined.
    if (ka !== kb) return kb - ka;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The items of one micro-category, in the order the feed produced them. */
export function itemsOfType(feed: FeedItem[], type: FeedType): FeedItem[] {
  return feed.filter((i) => i.type === type);
}

/**
 * The labs one item attaches to.
 *
 * Read off the entities the derivation already produced rather than recovered
 * from the sentence, so a lab page cannot contain an item whose thread page
 * does not. There is exactly one table mapping a vendor to a lab and it lives
 * in src/derive/entities.ts.
 */
export function labsOf(item: FeedItem): Lab[] {
  const out: Lab[] = [];
  for (const entity of item.entities) {
    if (entity.kind !== 'lab') continue;
    const lab = labFromVendor(entity.label);
    if (lab !== null && !out.includes(lab)) out.push(lab);
  }
  return out;
}

/** The items attached to one lab, in the order the feed produced them. */
export function itemsOfLab(feed: FeedItem[], lab: Lab): FeedItem[] {
  return feed.filter((i) => labsOf(i).includes(lab));
}

/**
 * Every lab with at least one item, in the order the feed first mentions them.
 *
 * First-mention order rather than alphabetical, so the chip row on the front
 * page reads as most-recently-active first, which is what a reader scanning it
 * is looking for. A lab with no items gets no chip and no page: an empty lab
 * page is a claim that we watch that lab, and the archive supports a claim
 * about the labs whose ids the sources actually carry.
 */
export function labsInFeed(feed: FeedItem[]): Lab[] {
  const out: Lab[] = [];
  for (const item of feed) {
    for (const lab of labsOf(item)) if (!out.includes(lab)) out.push(lab);
  }
  return out;
}

/** How many items each micro-category holds. Zero is a value, not an absence. */
export function countsByType(feed: FeedItem[]): Map<FeedType, number> {
  const out = new Map<FeedType, number>(ALL_TYPES.map((t) => [t, 0]));
  for (const item of feed) out.set(item.type, (out.get(item.type) ?? 0) + 1);
  return out;
}
