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
 * One event lands in as many threads as it has entities, which is deliberate:
 * a price change on `anthropic/claude-opus-5` is an event in that model's
 * thread AND in Anthropic's, and duplicating a link is cheaper than making a
 * reader guess which of the two we filed it under. An event with no entities
 * lands in no thread at all and is returned separately as held.
 */

import { entitySlug, type Entity } from './entities.js';
import type { DerivedEvent } from './events.js';
import type { Stamp } from '../site/record.js';

export type Thread = {
  entity: Entity;
  /** The permalink segment. Unique across a build, enforced below. */
  slug: string;
  /** Newest first, by the timestamp the page shows. */
  events: DerivedEvent[];
  /** The oldest event on the thread. When the archive first saw this entity. */
  firstSeen: Stamp | null;
  /** The newest event on the thread. */
  lastActivity: Stamp | null;
};

export type ThreadSet = {
  /** Most recently active first. */
  threads: Thread[];
  /** Events that attached to nothing, newest first. Never silently dropped. */
  held: DerivedEvent[];
};

/**
 * Milliseconds for an event's own stamp, lowest possible when it has none.
 *
 * -Infinity rather than null so the comparators below need no null arm, and
 * comparing the two keys for equality first is what keeps -Infinity minus
 * -Infinity, which is NaN, out of a subtraction. Same shape as
 * sortByStampDesc in src/site/record.ts, and for the same reason.
 */
function key(event: DerivedEvent): number {
  if (event.stamp === null) return -Infinity;
  const ms = Date.parse(event.stamp.iso);
  return Number.isNaN(ms) ? -Infinity : ms;
}

function newestFirst(events: DerivedEvent[]): DerivedEvent[] {
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
function span(sorted: DerivedEvent[]): { firstSeen: Stamp | null; lastActivity: Stamp | null } {
  const stamped = sorted.filter((e) => e.stamp !== null);
  const newest = stamped[0];
  const oldest = stamped[stamped.length - 1];
  return {
    firstSeen: oldest === undefined ? null : oldest.stamp,
    lastActivity: newest === undefined ? null : newest.stamp,
  };
}

/**
 * Group events into threads.
 *
 * THROWS when two distinct entity ids fold to the same slug. entitySlug is
 * lossy by construction, and the failure it would otherwise produce is one
 * entity's page silently served under another entity's permalink, in a
 * generated directory that is committed to a history R7 forbids rewriting. A
 * build that stops is recoverable; a page that lies is not. This is the same
 * refusal src/site/retractions.ts makes about a malformed ledger line.
 */
export function buildThreads(events: DerivedEvent[]): ThreadSet {
  const byId = new Map<string, { entity: Entity; events: DerivedEvent[] }>();
  const held: DerivedEvent[] = [];

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

  const slugs = new Map<string, string>();
  const threads: Thread[] = [];
  for (const { entity, events: bucket } of byId.values()) {
    const slug = entitySlug(entity);
    const taken = slugs.get(slug);
    if (taken !== undefined && taken !== entity.id) {
      throw new Error(`thread slug collision: ${entity.id} and ${taken} both fold to ${slug}`);
    }
    slugs.set(slug, entity.id);
    const sorted = newestFirst(bucket);
    threads.push({ entity, slug, events: sorted, ...span(sorted) });
  }

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
