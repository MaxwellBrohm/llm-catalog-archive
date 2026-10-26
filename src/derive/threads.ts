/**
 * Events to threads. Pure: no git, no fs, no clock.
 *
 * A THREAD IS THE PRODUCT, and this is the file that makes it one. The product
 * spec's section 4 states it as a schema decision: a story is a persistent
 * entity that accretes events over time, not a dated post, so a codename leak
 * in August, the launch in October and the price change in December are one
 * thread. The change pages under changes/ stay exactly where they
 * are; they are the evidence layer this sits on top of.
 *
 * QUIET DAYS ARE THE POINT. A day with no new events still has live threads
 * worth reading, which is the whole reason the publication is organised this
 * way rather than as a reverse-chronological feed of diffs.
 *
 * IT IS OVER THE WHOLE FEED, not over events alone, and that is the schema
 * decision the product spec's section 4 states in one sentence: "a codename
 * leak in August, the launch in October and the price change in December are
 * one thread". A threads layer built over events only would have filed the
 * launch and the price change together and left the leak on a separate page,
 * which is the dated-post model the spec rejects wearing a thread's clothes.
 * Leak items attach through src/derive/feed.ts's entitiesForLeak, which holds
 * rather than guesses: a codename attaches to nothing, because deciding whose
 * codename it is IS the leaks desk's whole failure mode.
 *
 * One item lands in as many threads as it has entities, which is deliberate:
 * a price change on `anthropic/claude-opus-5` is an event in that model's
 * thread AND in Anthropic's, and duplicating a link is cheaper than making a
 * reader guess which of the two we filed it under. An event with no entities
 * lands in no thread at all and is returned separately as held.
 */

import { createHash } from 'node:crypto';
import { entitySlug, type Entity } from './entities.js';
import type { FeedItem } from './feed.js';
import type { Stamp } from '../site/record.js';

export type Thread = {
  entity: Entity;
  /**
   * The permalink segment. Unique across a build and stable as the archive
   * grows; assignSlugs below says how both are guaranteed.
   */
  slug: string;
  /** Newest first, by the timestamp the page shows. */
  events: FeedItem[];
  /** The oldest event on the thread. When the archive first saw this entity. */
  firstSeen: Stamp | null;
  /** The newest event on the thread. */
  lastActivity: Stamp | null;
};

export type ThreadSet = {
  /** Most recently active first. */
  threads: Thread[];
  /** Events that attached to nothing, newest first. Never silently dropped. */
  held: FeedItem[];
};

/**
 * Milliseconds for an event's own stamp, lowest possible when it has none.
 *
 * -Infinity rather than null so the comparators below need no null arm, and
 * comparing the two keys for equality first is what keeps -Infinity minus
 * -Infinity, which is NaN, out of a subtraction. Same shape as
 * sortByStampDesc in src/site/record.ts, and for the same reason.
 */
function key(event: FeedItem): number {
  if (event.stamp === null) return -Infinity;
  const ms = Date.parse(event.stamp.iso);
  return Number.isNaN(ms) ? -Infinity : ms;
}

function newestFirst(events: FeedItem[]): FeedItem[] {
  return [...events].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka === kb ? 0 : kb - ka;
  });
}

/**
 * The stamp of the oldest and the newest event that has one.
 *
 * Read off the SORTED list rather than recomputed, so the dates a thread page
 * prints are the dates of the first and last rows a reader can see on it. A
 * thread whose events all lack a sidecar reports null for both, which the
 * renderer prints rather than hiding.
 */
function span(sorted: FeedItem[]): { firstSeen: Stamp | null; lastActivity: Stamp | null } {
  const stamped = sorted.filter((e) => e.stamp !== null);
  const newest = stamped[0];
  const oldest = stamped[stamped.length - 1];
  return {
    firstSeen: oldest === undefined ? null : oldest.stamp,
    lastActivity: newest === undefined ? null : newest.stamp,
  };
}

/**
 * When the archive first saw an entity, as a sort key: earlier is more senior.
 *
 * An entity with no datable event sorts AFTER every entity that has one. The
 * archive cannot say when it arrived, and letting it outrank an entity whose
 * first capture is on record would let an undated newcomer take a permalink a
 * dated thread has been published under.
 */
function seniority(firstSeen: Stamp | null): number {
  if (firstSeen === null) return Infinity;
  const ms = Date.parse(firstSeen.iso);
  return Number.isNaN(ms) ? Infinity : ms;
}

/**
 * The first eight hex digits of the SHA-256 of an entity id.
 *
 * A function of the id alone, so the suffix it produces does not depend on how
 * many other entities share the fold or on the order they arrived in, and a
 * reader can recompute it: `printf %s '<id>' | shasum -a 256`.
 */
function idDigest(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 8);
}

/**
 * The slug an entity is published under, given the slugs already taken.
 *
 * Its plain fold when that is free, which is every entity that collides with
 * nothing and therefore every permalink the site published before collisions
 * were handled at all. Otherwise the fold with the id's digest appended.
 *
 * The numbered arm is for a digest-suffixed slug that is ITSELF taken, which
 * needs some other entity id to fold to exactly `<fold>-<those eight digits>`.
 * Catalogue ids are third-party strings, so that is improbable rather than
 * impossible, and a build that can be broken by somebody else's naming is the
 * failure this function exists to remove. The loop is bounded on purpose: it
 * offers `taken.size + 1` distinct candidates against at most `taken.size`
 * taken ones, so one is always free, and a bound means no edit to the loop
 * condition can turn it into a loop that never ends.
 */
function freeSlug(entity: Entity, taken: ReadonlySet<string>): string {
  const plain = entitySlug(entity);
  if (!taken.has(plain)) return plain;
  const tagged = `${plain}-${idDigest(entity.id)}`;
  if (!taken.has(tagged)) return tagged;
  for (let n = 2; n <= taken.size + 2; n++) {
    const numbered = `${tagged}-${n}`;
    if (!taken.has(numbered)) return numbered;
  }
  throw new Error(`no free slug for ${entity.id}: ${taken.size} slugs taken`);
}

/**
 * Every entity's permalink slug: unique within a build, and stable as the
 * archive grows.
 *
 * WHY THIS IS NOT JUST entitySlug. The fold is lossy, so two distinct entities
 * can share one, and in the capture stamped 2026-10-20 two pairs did: Mistral
 * moved its `studio/audio/speech_to_text` and `studio/audio/text_to_speech`
 * docs under `deprecated/` and published new `speech-to-text` and
 * `text-to-speech` sections beside them. Each pair folds to one slug, and
 * every deploy from 2026-10-21 refused to build. This used to throw on exactly
 * that, on the reasoning that a build which stops is recoverable and a page
 * which lies is not. Both halves were true, but the stop was not recoverable
 * by anything short of a code change, because the colliding ids are a third
 * party's to choose and the archive never forgets one.
 *
 * WHO KEEPS THE PLAIN SLUG. The entity the archive saw FIRST, by the oldest
 * dated event on its thread (the "First event in the archive" its page
 * prints), with the entity id breaking a tie. Every other entity that folds to
 * the same string gets the digest suffix from freeSlug. Slugs are handed out
 * oldest entity first, so an entity's slug depends only on entities that
 * arrived before it, and one that arrives in a later capture cannot move a
 * permalink that is already published. That is the property that matters: a
 * thread page's address is a permalink, and the site has no way to tell the
 * readers it already sent there that it moved.
 *
 * WHAT IT RESTS ON, and where it stops holding. First, the archive being
 * append-only (R7): no capture is ever rewritten, so the oldest event on a
 * thread can only stay where it is. Second, the deriving code staying put.
 * Events are derived afresh from the whole history on every build, so a
 * change to an extractor that finds an entity in captures it used to pass
 * over can date that entity earlier than one already published under the same
 * fold. That entity then takes the plain slug and the published one moves to
 * its suffix. Only an assignment pinned outside the derivation, in a committed
 * ledger the build checks against, would rule that out. This does not keep
 * one, because the case needs a colliding fold and an extractor change to
 * coincide, and each page of a collision links the other (foldmates in
 * src/site/render.ts), so a reader sent to the moved address is one link from
 * the thread they wanted.
 *
 * The one ordering it can get wrong without any code change is two entities
 * first captured closer together than a cached response's Age, because a stamp
 * is origin_date, the response's date minus that Age, and this archive has
 * stored a capture whose origin was 40 hours before the commit that stored it.
 * The entity that lost the plain slug then would have held it for less than
 * that gap.
 */
function assignSlugs(entries: readonly { entity: Entity; firstSeen: Stamp | null }[]): Map<string, string> {
  const order = [...entries].sort((a, b) => {
    const ka = seniority(a.firstSeen);
    const kb = seniority(b.firstSeen);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.entity.id < b.entity.id ? -1 : a.entity.id > b.entity.id ? 1 : 0;
  });
  const taken = new Set<string>();
  const out = new Map<string, string>();
  for (const { entity } of order) {
    const slug = freeSlug(entity, taken);
    taken.add(slug);
    out.set(entity.id, slug);
  }
  return out;
}

/**
 * Group events into threads.
 *
 * Every thread gets a distinct slug, from assignSlugs. Two distinct entities
 * whose ids fold to one string no longer stop the build: the one the archive
 * saw first keeps the address it has always had, and the newcomer is published
 * under the same fold with a suffix.
 */
export function buildThreads(events: FeedItem[]): ThreadSet {
  const byId = new Map<string, { entity: Entity; events: FeedItem[] }>();
  const held: FeedItem[] = [];

  for (const event of events) {
    if (event.entities.length === 0) {
      held.push(event);
      continue;
    }
    for (const entity of event.entities) {
      const bucket = byId.get(entity.id);
      if (bucket === undefined) byId.set(entity.id, { entity, events: [event] });
      else bucket.events.push(event);
    }
  }

  const grouped = [...byId.values()].map(({ entity, events: bucket }) => {
    const sorted = newestFirst(bucket);
    return { entity, events: sorted, ...span(sorted) };
  });
  const slugs = assignSlugs(grouped);
  const threads: Thread[] = grouped.map((t) => ({
    entity: t.entity,
    slug: slugs.get(t.entity.id)!,
    events: t.events,
    firstSeen: t.firstSeen,
    lastActivity: t.lastActivity,
  }));

  // Most recently active first, and ties broken by entity id so the generated
  // directory is byte-stable across runs over the same archive. Without the
  // tie-break, a Map insertion order that shifts by one commit rewrites every
  // index page for no change anyone made.
  threads.sort((a, b) => {
    const ka = a.lastActivity === null ? -Infinity : Date.parse(a.lastActivity.iso);
    const kb = b.lastActivity === null ? -Infinity : Date.parse(b.lastActivity.iso);
    const na = Number.isNaN(ka) ? -Infinity : ka;
    const nb = Number.isNaN(kb) ? -Infinity : kb;
    if (na !== nb) return nb - na;
    return a.entity.id < b.entity.id ? -1 : a.entity.id > b.entity.id ? 1 : 0;
  });

  return { threads, held: newestFirst(held) };
}

/** Threads of one kind, in the order buildThreads produced them. */
export function threadsOfKind(threads: Thread[], kind: Entity['kind']): Thread[] {
  return threads.filter((t) => t.entity.kind === kind);
}

/**
 * Entity id to the slug its thread is published under.
 *
 * EVERY LINK TO A THREAD GOES THROUGH THIS, never through entitySlug. The fold
 * is only the plain slug, and the published one is assignSlugs's. A chip, a
 * tape row or an API record that refolded an id for itself would send a reader
 * to the OTHER entity's page whenever its own entity is the newcomer in a
 * collision, which is the lie the old refusal to build existed to prevent.
 */
export type SlugIndex = ReadonlyMap<string, string>;

export function slugIndex(set: ThreadSet): SlugIndex {
  return new Map(set.threads.map((t) => [t.entity.id, t.slug]));
}

/**
 * The slug of an entity's thread, looked up rather than refolded.
 *
 * The plain fold is the answer only for an entity the index holds no thread
 * for. A build never asks that: every entity on every item in the feed has a
 * thread, and every page is rendered against the threads built from that same
 * feed. It is what a page rendered against a partial set of threads links to,
 * which is a unit test's fixture, and outside a collision it is the same string
 * anyway.
 */
export function threadSlug(index: SlugIndex, entity: Entity): string {
  return index.get(entity.id) ?? entitySlug(entity);
}
