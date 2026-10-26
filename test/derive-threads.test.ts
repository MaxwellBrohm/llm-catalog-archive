import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { buildThreads, slugIndex, threadSlug, threadsOfKind, type ThreadSet } from '../src/derive/threads.js';
import { buildFeed, type FeedItem } from '../src/derive/feed.js';
import type { DerivedEvent } from '../src/derive/events.js';
import type { Entity } from '../src/derive/entities.js';
import type { Stamp } from '../src/site/record.js';

const SHA = 'a69a068319de9dc9a7ab1049b411a562a026e7d5';

const MODEL: Entity = {
  kind: 'model',
  id: 'model/openrouter:anthropic/claude-opus-5',
  label: 'anthropic/claude-opus-5',
};
const LAB: Entity = { kind: 'lab', id: 'lab/anthropic', label: 'anthropic' };

const stamp = (iso: string): Stamp => ({ iso, kind: 'origin' });

function event(over: Partial<DerivedEvent> = {}): DerivedEvent {
  return {
    id: `${SHA}:model_added:anthropic/claude-opus-5`,
    type: 'model_added',
    sha: SHA,
    sourceId: 'openrouter-models',
    path: 'raw/openrouter-models/response.json',
    stamp: stamp('2026-08-28T08:00:00.000Z'),
    entities: [MODEL, LAB],
    held: false,
    modelId: 'anthropic/claude-opus-5',
    created: 1787752741,
    precisionSeconds: 4500,
    ...over,
  } as DerivedEvent;
}

/**
 * Threads are built over the FEED, not over events alone, because the product
 * spec files a codename leak, a launch and a price change on one thread. These
 * cases are all about grouping and ordering, which is a property of an item's
 * entities and stamp, so they go through buildFeed with no leak items rather
 * than constructing FeedItems by hand: the wrapping is then the real one and
 * cannot drift from what the generator does.
 */
const threadsOf = (events: DerivedEvent[]): ReturnType<typeof buildThreads> =>
  buildThreads(buildFeed(events, []));

describe('buildThreads', () => {
  it('opens one thread per entity an event names', () => {
    expect(threadsOf([event()]).threads.map((t) => t.entity.id)).toEqual([
      'lab/anthropic',
      'model/openrouter:anthropic/claude-opus-5',
    ]);
  });

  // The same event on both threads is the point of the model: a price change on
  // a model is an event in that model's story and in its lab's, and duplicating
  // a link is cheaper than making a reader guess which one we filed it under.
  it('puts one event on every thread it names', () => {
    const set = threadsOf([event()]);
    expect(set.threads.map((t) => t.events.length)).toEqual([1, 1]);
  });

  it('accretes two events onto the one thread they share', () => {
    const set = threadsOf([
      event({ id: 'a' }),
      event({ id: 'b', stamp: stamp('2026-08-29T08:00:00.000Z') }),
    ]);
    expect(set.threads[0]?.events.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('orders a thread newest first by the timestamp the page shows', () => {
    const set = threadsOf([
      event({ id: 'old', stamp: stamp('2026-08-26T08:00:00.000Z') }),
      event({ id: 'new', stamp: stamp('2026-08-30T08:00:00.000Z') }),
      event({ id: 'mid', stamp: stamp('2026-08-28T08:00:00.000Z') }),
    ]);
    expect(set.threads[0]?.events.map((e) => e.id)).toEqual(['new', 'mid', 'old']);
  });

  it('reports the oldest event on the thread as its first seen', () => {
    const set = threadsOf([
      event({ id: 'old', stamp: stamp('2026-08-26T08:00:00.000Z') }),
      event({ id: 'new', stamp: stamp('2026-08-30T08:00:00.000Z') }),
    ]);
    expect(set.threads[0]?.firstSeen?.iso).toBe('2026-08-26T08:00:00.000Z');
  });

  it('reports the newest event on the thread as its last activity', () => {
    const set = threadsOf([
      event({ id: 'old', stamp: stamp('2026-08-26T08:00:00.000Z') }),
      event({ id: 'new', stamp: stamp('2026-08-30T08:00:00.000Z') }),
    ]);
    expect(set.threads[0]?.lastActivity?.iso).toBe('2026-08-30T08:00:00.000Z');
  });

  it('reports null on both ends when no event on the thread carries a stamp', () => {
    const set = threadsOf([event({ stamp: null })]);
    expect([set.threads[0]?.firstSeen, set.threads[0]?.lastActivity]).toEqual([null, null]);
  });

  it('reads first seen past an unstamped event rather than reporting null', () => {
    const set = threadsOf([
      event({ id: 'stamped', stamp: stamp('2026-08-26T08:00:00.000Z') }),
      event({ id: 'unstamped', stamp: null }),
    ]);
    expect(set.threads[0]?.firstSeen?.iso).toBe('2026-08-26T08:00:00.000Z');
  });

  it('orders threads by last activity, most recent first', () => {
    const other: Entity = { kind: 'lab', id: 'lab/openai', label: 'openai' };
    const set = threadsOf([
      event({ id: 'a', entities: [LAB], stamp: stamp('2026-08-26T08:00:00.000Z') }),
      event({ id: 'b', entities: [other], stamp: stamp('2026-08-30T08:00:00.000Z') }),
    ]);
    expect(set.threads.map((t) => t.entity.id)).toEqual(['lab/openai', 'lab/anthropic']);
  });

  // Without the tie-break, a Map insertion order that shifts by one commit
  // rewrites every index page in a directory that is committed to a history R7
  // forbids rewriting.
  it('breaks a last-activity tie by entity id so the generated pages are stable', () => {
    const zed: Entity = { kind: 'lab', id: 'lab/zai', label: 'zai' };
    const set = threadsOf([
      event({ id: 'a', entities: [zed] }),
      event({ id: 'b', entities: [LAB] }),
    ]);
    expect(set.threads.map((t) => t.entity.id)).toEqual(['lab/anthropic', 'lab/zai']);
  });

  it('gives every thread the slug its entity folds to', () => {
    expect(threadsOf([event()]).threads.map((t) => t.slug)).toEqual([
      'lab-anthropic',
      'model-openrouter-anthropic-claude-opus-5',
    ]);
  });

  // entitySlug is lossy. This used to throw, and from 2026-10-21 it stopped
  // every deploy; the cases under 'two entities that fold to one slug' below
  // pin what it does instead.
  it('builds when two distinct entities fold to one slug, one thread each', () => {
    const a: Entity = { kind: 'lab', id: 'lab/a-b', label: 'x' };
    const b: Entity = { kind: 'lab', id: 'lab/a/b', label: 'y' };
    const set = threadsOf([event({ entities: [a] }), event({ entities: [b] })]);
    expect(set.threads.map((t) => t.entity.id).sort()).toEqual(['lab/a-b', 'lab/a/b']);
  });

  it('builds without complaint when one entity appears on many events', () => {
    expect(threadsOf([event({ id: 'a' }), event({ id: 'b' })]).threads).toHaveLength(2);
  });
});

describe('held events', () => {
  it('opens no thread for an event that names no entity', () => {
    expect(threadsOf([event({ entities: [] })]).threads).toEqual([]);
  });

  it('keeps an event that names no entity rather than dropping it', () => {
    expect(threadsOf([event({ entities: [], id: 'orphan' })]).held.map((e) => e.id)).toEqual([
      'orphan',
    ]);
  });

  it('orders held events newest first, as a thread orders its own', () => {
    const set = threadsOf([
      event({ id: 'old', entities: [], stamp: stamp('2026-08-26T08:00:00.000Z') }),
      event({ id: 'new', entities: [], stamp: stamp('2026-08-30T08:00:00.000Z') }),
    ]);
    expect(set.held.map((e) => e.id)).toEqual(['new', 'old']);
  });

  it('holds nothing when every event named an entity', () => {
    expect(threadsOf([event()]).held).toEqual([]);
  });
});

describe('threadsOfKind', () => {
  it('returns only the threads of the kind asked for', () => {
    const set = threadsOf([event()]);
    expect(threadsOfKind(set.threads, 'lab').map((t) => t.entity.id)).toEqual(['lab/anthropic']);
  });

  it('returns an empty list for a kind no thread carries', () => {
    const set = threadsOf([event()]);
    expect(threadsOfKind(set.threads, 'api-surface')).toEqual([]);
  });
});

describe('an event with no usable timestamp', () => {
  // Sorting it FIRST would put an event the archive cannot date at the top of a
  // thread, above events it can, which reads as the newest thing that happened.
  it('sorts last within its thread', () => {
    const set = threadsOf([
      event({ id: 'unstamped', stamp: null }),
      event({ id: 'stamped', stamp: stamp('2026-08-26T08:00:00.000Z') }),
    ]);
    expect(set.threads[0]?.events.map((e) => e.id)).toEqual(['stamped', 'unstamped']);
  });

  it('sorts last even when it was supplied first', () => {
    const set = threadsOf([
      event({ id: 'unparseable', stamp: { iso: 'not a date', kind: 'origin' } }),
      event({ id: 'stamped', stamp: stamp('2026-08-26T08:00:00.000Z') }),
    ]);
    expect(set.threads[0]?.events.map((e) => e.id)).toEqual(['stamped', 'unparseable']);
  });

  // Three threads, not two. A comparator whose null arm is wrong on one side
  // only is invisible across a two element sort, because the engine calls it
  // once and may call it in either order.
  it('sorts a thread with no datable activity behind two that have some', () => {
    const openai: Entity = { kind: 'lab', id: 'lab/openai', label: 'openai' };
    const zai: Entity = { kind: 'lab', id: 'lab/zai', label: 'zai' };
    const set = threadsOf([
      event({ id: 'a', entities: [openai], stamp: stamp('2026-08-30T08:00:00.000Z') }),
      event({ id: 'b', entities: [LAB], stamp: null }),
      event({ id: 'c', entities: [zai], stamp: stamp('2026-08-26T08:00:00.000Z') }),
    ]);
    expect(set.threads.map((t) => t.entity.id)).toEqual(['lab/openai', 'lab/zai', 'lab/anthropic']);
  });

  it('sorts a thread with no datable activity behind one that has some', () => {
    const other: Entity = { kind: 'lab', id: 'lab/openai', label: 'openai' };
    const set = threadsOf([
      event({ id: 'a', entities: [LAB], stamp: null }),
      event({ id: 'b', entities: [other], stamp: stamp('2026-08-30T08:00:00.000Z') }),
    ]);
    expect(set.threads.map((t) => t.entity.id)).toEqual(['lab/openai', 'lab/anthropic']);
  });
});

describe('the slug collision guard', () => {
  it('builds without throwing when every entity folds to its own slug', () => {
    const a: Entity = { kind: 'lab', id: 'lab/anthropic', label: 'x' };
    const b: Entity = { kind: 'lab', id: 'lab/openai', label: 'y' };
    expect(threadsOf([event({ entities: [a] }), event({ entities: [b] })]).threads).toHaveLength(2);
  });

  it('builds without throwing when one entity appears on two events', () => {
    const a: Entity = { kind: 'lab', id: 'lab/anthropic', label: 'x' };
    expect(
      threadsOf([event({ id: 'x', entities: [a] }), event({ id: 'y', entities: [a] })]).threads,
    ).toHaveLength(1);
  });
});

/**
 * THE PAIR THAT STOPPED EVERY DEPLOY FROM 2026-10-21, with the stamps the real
 * archive gives them. Mistral's llms.txt listed `studio/audio/text_to_speech/`
 * pages from the capture stamped 2026-09-24 (a response 40 hours old when
 * the 2026-09-26 run stored it), and the 2026-10-21 run stored a reorganised
 * docs tree that also has `studio/audio/text-to-speech/`. Both sections fold to
 * PLAIN below.
 */
const UNDERSCORE: Entity = {
  kind: 'api-surface',
  id: 'api-surface/docs.mistral.ai/studio/audio/text_to_speech',
  label: 'docs.mistral.ai/studio/audio/text_to_speech',
};
const HYPHEN: Entity = {
  kind: 'api-surface',
  id: 'api-surface/docs.mistral.ai/studio/audio/text-to-speech',
  label: 'docs.mistral.ai/studio/audio/text-to-speech',
};
const PLAIN = 'api-surface-docs-mistral-ai-studio-audio-text-to-speech';
const SEPT = '2026-09-24T12:06:31.000Z';
const OCT = '2026-10-20T19:20:33.000Z';

/** Recomputed here rather than imported, so the suffix is checked against the documented recipe. */
const digest8 = (id: string): string => createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 8);

const slugOf = (set: ThreadSet, entity: Entity): string | undefined =>
  set.threads.find((t) => t.entity.id === entity.id)?.slug;

const onlyOn = (entity: Entity, iso: string | null, id: string = `${entity.id}@${iso}`): DerivedEvent =>
  event({ id, entities: [entity], stamp: iso === null ? null : stamp(iso) });

/**
 * The same items handed to buildThreads in the feed's order AND in reverse.
 *
 * Not threadsOf over reversed EVENTS: buildFeed sorts its output, so reversing
 * its input changes nothing, and a rule that only came out right because of
 * the order buildFeed happens to produce would pass every case built that way.
 */
const bothOrders = (items: DerivedEvent[]): ThreadSet[] => {
  const feed = buildFeed(items, []);
  return [buildThreads(feed), buildThreads([...feed].reverse())];
};

describe('two entities that fold to one slug', () => {
  it('fold to one slug, which is the whole problem', () => {
    // Guards the fixture: if these stopped colliding, every case below would
    // pass for the wrong reason.
    expect(threadsOf([onlyOn(UNDERSCORE, SEPT)]).threads[0]?.slug).toBe(PLAIN);
    expect(threadsOf([onlyOn(HYPHEN, OCT)]).threads[0]?.slug).toBe(PLAIN);
  });

  it('leaves the plain slug with the entity the archive saw first', () => {
    const set = threadsOf([onlyOn(UNDERSCORE, SEPT), onlyOn(HYPHEN, OCT)]);
    expect(slugOf(set, UNDERSCORE)).toBe(PLAIN);
  });

  it('gives the newcomer the plain slug plus the first eight hex digits of its id\'s SHA-256', () => {
    const set = threadsOf([onlyOn(UNDERSCORE, SEPT), onlyOn(HYPHEN, OCT)]);
    expect(slugOf(set, HYPHEN)).toBe(`${PLAIN}-${digest8(HYPHEN.id)}`);
  });

  // The real pair is the case where seniority and id order DISAGREE: `-` sorts
  // before `_`, so a rule that let the id decide would hand the hyphenated
  // newcomer the address the underscore thread has been published under since
  // September.
  it('decides by first seen, not by id, so the newer entity cannot take the older one\'s address', () => {
    const set = threadsOf([onlyOn(HYPHEN, OCT), onlyOn(UNDERSCORE, SEPT)]);
    expect([slugOf(set, UNDERSCORE), slugOf(set, HYPHEN)]).toEqual([PLAIN, `${PLAIN}-${digest8(HYPHEN.id)}`]);
  });

  it('follows first seen the other way too', () => {
    const set = threadsOf([onlyOn(UNDERSCORE, OCT), onlyOn(HYPHEN, SEPT)]);
    expect([slugOf(set, HYPHEN), slugOf(set, UNDERSCORE)]).toEqual([PLAIN, `${PLAIN}-${digest8(UNDERSCORE.id)}`]);
  });

  it('gives the same slugs whatever order the feed lists the items in', () => {
    const [forward, backward] = bothOrders([onlyOn(UNDERSCORE, SEPT), onlyOn(HYPHEN, OCT), onlyOn(UNDERSCORE, OCT, 'u-later')]);
    expect(backward!.threads.map((t) => [t.entity.id, t.slug])).toEqual(
      forward!.threads.map((t) => [t.entity.id, t.slug]),
    );
    expect(slugOf(backward!, UNDERSCORE)).toBe(PLAIN);
  });

  // THE PROPERTY THE WHOLE RULE EXISTS FOR. The underscore thread was published
  // at PLAIN from September until the build stopped; the newcomer arriving
  // must not move it.
  it('never moves a published slug when a colliding newcomer arrives', () => {
    const before = threadsOf([onlyOn(UNDERSCORE, SEPT)]);
    const after = threadsOf([onlyOn(UNDERSCORE, SEPT), onlyOn(HYPHEN, OCT)]);
    expect(slugOf(after, UNDERSCORE)).toBe(slugOf(before, UNDERSCORE));
  });

  // First seen, not last activity. The underscore section was still being
  // written to after the hyphenated one appeared (its pages moved out of it on
  // 2026-10-20), so its NEWEST event is later than the newcomer's only one.
  it('reads seniority off a thread\'s oldest event, not its newest', () => {
    const set = threadsOf([
      onlyOn(UNDERSCORE, SEPT),
      onlyOn(UNDERSCORE, '2026-10-25T00:00:00.000Z', 'u-latest'),
      onlyOn(HYPHEN, OCT),
    ]);
    expect(slugOf(set, UNDERSCORE)).toBe(PLAIN);
  });

  it('breaks a tie in first seen by entity id', () => {
    // `-` (0x2d) sorts before `_` (0x5f).
    for (const set of bothOrders([onlyOn(UNDERSCORE, SEPT), onlyOn(HYPHEN, SEPT)])) {
      expect([slugOf(set, HYPHEN), slugOf(set, UNDERSCORE)]).toEqual([PLAIN, `${PLAIN}-${digest8(UNDERSCORE.id)}`]);
    }
  });

  // An undated entity cannot show it was here first, so it never outranks one
  // that can. Supplied FIRST and with the id that wins a tie, so neither feed
  // order nor the id tie-break can produce the right answer by accident.
  it('ranks an entity with no dated event below one that has a date', () => {
    for (const set of bothOrders([onlyOn(HYPHEN, null), onlyOn(UNDERSCORE, OCT)])) {
      expect([slugOf(set, UNDERSCORE), slugOf(set, HYPHEN)]).toEqual([PLAIN, `${PLAIN}-${digest8(HYPHEN.id)}`]);
    }
  });

  it('ranks an entity whose only stamp does not parse below one that has a date', () => {
    for (const set of bothOrders([
      event({ id: 'bad', entities: [HYPHEN], stamp: { iso: 'not a date', kind: 'origin' } }),
      onlyOn(UNDERSCORE, OCT),
    ])) {
      expect(slugOf(set, UNDERSCORE)).toBe(PLAIN);
    }
  });

  it('breaks a tie between two undated entities by entity id', () => {
    for (const set of bothOrders([onlyOn(UNDERSCORE, null), onlyOn(HYPHEN, null)])) {
      expect([slugOf(set, HYPHEN), slugOf(set, UNDERSCORE)]).toEqual([PLAIN, `${PLAIN}-${digest8(UNDERSCORE.id)}`]);
    }
  });

  it('gives three entities on one fold three distinct slugs, oldest plain', () => {
    const dotted: Entity = { kind: 'api-surface', id: 'api-surface/docs.mistral.ai/studio/audio/text.to.speech', label: 'z' };
    const set = threadsOf([onlyOn(UNDERSCORE, SEPT), onlyOn(HYPHEN, OCT), onlyOn(dotted, '2026-10-22T00:00:00.000Z')]);
    expect([slugOf(set, UNDERSCORE), slugOf(set, HYPHEN), slugOf(set, dotted)]).toEqual([
      PLAIN,
      `${PLAIN}-${digest8(HYPHEN.id)}`,
      `${PLAIN}-${digest8(dotted.id)}`,
    ]);
  });

  // The suffixed slug can itself be taken: catalogue ids are third-party
  // strings, and one that folds to exactly `<plain>-<the digest>` is improbable
  // rather than impossible. Built here on purpose, oldest of the three.
  it('numbers a newcomer whose suffixed slug an older entity already holds', () => {
    const squatter: Entity = {
      kind: 'api-surface',
      id: `api-surface/docs.mistral.ai/studio/audio/text-to-speech/${digest8(HYPHEN.id)}`,
      label: 'q',
    };
    const set = threadsOf([onlyOn(squatter, '2026-09-01T00:00:00.000Z'), onlyOn(UNDERSCORE, SEPT), onlyOn(HYPHEN, OCT)]);
    expect([slugOf(set, squatter), slugOf(set, UNDERSCORE), slugOf(set, HYPHEN)]).toEqual([
      `${PLAIN}-${digest8(HYPHEN.id)}`,
      PLAIN,
      `${PLAIN}-${digest8(HYPHEN.id)}-2`,
    ]);
  });

  it('counts up past every numbered slug that is also taken', () => {
    const tagged = `text-to-speech/${digest8(HYPHEN.id)}`;
    const squat = (suffix: string, iso: string): Entity => ({
      kind: 'api-surface',
      id: `api-surface/docs.mistral.ai/studio/audio/${tagged}${suffix}`,
      label: suffix,
    });
    const set = threadsOf([
      onlyOn(squat('', '1'), '2026-09-01T00:00:00.000Z'),
      onlyOn(squat('/2', '2'), '2026-09-02T00:00:00.000Z'),
      onlyOn(squat('/3', '3'), '2026-09-03T00:00:00.000Z'),
      onlyOn(UNDERSCORE, SEPT),
      onlyOn(HYPHEN, OCT),
    ]);
    expect(slugOf(set, HYPHEN)).toBe(`${PLAIN}-${digest8(HYPHEN.id)}-4`);
  });

  // Every way this repository's ids can spell one fold: separators, runs of
  // them, case, and both ends. Whatever the stamps, no two threads may share a
  // page, and the oldest keeps the plain one.
  it('gives every thread in a dense collision a page of its own', () => {
    const spellings = ['a-b', 'a_b', 'a.b', 'a:b', 'a/b', 'a--b', 'A-B', 'a-B', '-a-b', 'a-b-', 'a b', 'a~b'];
    const items = spellings.map((sp, i) =>
      onlyOn({ kind: 'lab', id: `lab/${sp}`, label: sp }, `2026-09-${String(30 - i).padStart(2, '0')}T00:00:00.000Z`),
    );
    const set = threadsOf(items);
    const slugs = set.threads.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(spellings.length);
    expect(set.threads.find((t) => t.slug === 'lab-a-b')?.entity.id).toBe('lab/a~b');
  });
});

describe('threadSlug', () => {
  const set = threadsOf([onlyOn(UNDERSCORE, SEPT), onlyOn(HYPHEN, OCT)]);

  it('looks the newcomer up rather than refolding its id', () => {
    expect(threadSlug(slugIndex(set), HYPHEN)).toBe(`${PLAIN}-${digest8(HYPHEN.id)}`);
  });

  it('returns the slug the thread itself carries, for every thread', () => {
    const index = slugIndex(set);
    expect(set.threads.map((t) => threadSlug(index, t.entity))).toEqual(set.threads.map((t) => t.slug));
  });

  it('falls back to the plain fold for an entity the index holds no thread for', () => {
    expect(threadSlug(slugIndex(set), LAB)).toBe('lab-anthropic');
  });

  it('indexes nothing for a set with no threads', () => {
    expect(slugIndex({ threads: [], held: [] }).size).toBe(0);
  });
});
