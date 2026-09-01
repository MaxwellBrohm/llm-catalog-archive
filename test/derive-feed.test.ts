/**
 * The unified stream. Pure over derived events and leak items, so every case
 * here is asserted from a literal rather than from a fixture repository.
 */

import { describe, it, expect } from 'vitest';
import {
  ALL_TYPES,
  buildFeed,
  countsByType,
  entitiesForLeak,
  feedItemFromEvent,
  feedItemFromLeak,
  itemsOfLab,
  itemsOfType,
  labsInFeed,
  labsOf,
} from '../src/derive/feed.js';
import { claimSentence, type DerivedEvent, type EventType } from '../src/derive/events.js';
import { leakSentence, type LeakItem, type LeakType } from '../src/derive/leaks.js';
import type { Entity } from '../src/derive/entities.js';
import type { Stamp } from '../src/site/record.js';

const SHA = 'a69a068319de9dc9a7ab1049b411a562a026e7d5';
const OTHER = '0e91a0fbf78e6302670dc61a8c28502e418d01a1';
const stamp = (iso: string): Stamp => ({ iso, kind: 'origin' });

const MODEL: Entity = {
  kind: 'model',
  id: 'model/openrouter:anthropic/claude-opus-5',
  label: 'anthropic/claude-opus-5',
};
const LAB: Entity = { kind: 'lab', id: 'lab/anthropic', label: 'anthropic' };

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

function leak(over: Partial<LeakItem> = {}): LeakItem {
  return {
    id: `${SHA}:codename_entered:cold_brew`,
    type: 'codename_entered',
    tier: 'confirmed-artifact',
    sha: SHA,
    sourceId: 'arena-leaderboard',
    path: 'raw/arena-leaderboard/response.html',
    stamp: stamp('2026-08-28T09:00:00.000Z'),
    subject: 'cold_brew',
    facts: [['publicName', 'cold_brew']],
    ...over,
  } as LeakItem;
}

describe('feedItemFromEvent', () => {
  it('copies the sentence the deriving module wrote rather than composing one', () => {
    expect(feedItemFromEvent(event()).sentence).toBe(claimSentence(event()));
  });

  it('marks the item as an event', () => {
    expect(feedItemFromEvent(event()).kind).toBe('event');
  });

  it('carries no sourcing tier, because an event has none to carry', () => {
    expect(feedItemFromEvent(event()).tier).toBe(null);
  });

  it('keeps the event itself, so a renderer can print its per-type fact rows', () => {
    expect(feedItemFromEvent(event()).event?.type).toBe('model_added');
  });

  // An event's own facts are the typed fields the renderer prints per type,
  // not a fact list on the item. A non-empty array here would render a fact
  // table on every event card that the derivation never produced.
  it('carries no fact rows of its own for an event', () => {
    expect(feedItemFromEvent(event()).facts).toEqual([]);
  });

  it('carries the entities the derivation already attached', () => {
    expect(feedItemFromEvent(event()).entities.map((e) => e.id)).toEqual([
      'model/openrouter:anthropic/claude-opus-5',
      'lab/anthropic',
    ]);
  });
});

describe('feedItemFromLeak', () => {
  it('copies the sentence the desk wrote rather than composing one', () => {
    expect(feedItemFromLeak(leak()).sentence).toBe(leakSentence(leak()));
  });

  it('marks the item as a leak', () => {
    expect(feedItemFromLeak(leak()).kind).toBe('leak');
  });

  it('carries the sourcing tier the desk assigned', () => {
    expect(feedItemFromLeak(leak()).tier).toBe('confirmed-artifact');
  });

  it('carries the fact rows a reader checks against the artifact', () => {
    expect(feedItemFromLeak(leak()).facts).toEqual([['publicName', 'cold_brew']]);
  });
});

/**
 * Attachment is deterministic first and judged second, and where it is
 * ambiguous the item is HELD. These are the four holds and the two attachments,
 * one case each, because a leak item that quietly acquired a lab would put a
 * codename on a company's thread, which is the one thing the desk exists not to
 * do.
 */
describe('entitiesForLeak', () => {
  it('reads a stealth listing as the catalogue id it is', () => {
    expect(entitiesForLeak(leak({ type: 'stealth_listing', subject: 'stealth/sonnet-x' })).map((e) => e.id)).toEqual([
      'model/openrouter:stealth/sonnet-x',
    ]);
  });

  it('gives a stealth listing no lab, because stealth is a namespace and not a company', () => {
    expect(
      entitiesForLeak(leak({ type: 'stealth_listing', subject: 'stealth/sonnet-x' })).filter((e) => e.kind === 'lab'),
    ).toEqual([]);
  });

  it('gives a scheduled expiration both the model and the lab its vendor maps to', () => {
    expect(
      entitiesForLeak(leak({ type: 'expiration_scheduled', subject: 'moonshotai/kimi-k2.5' })).map((e) => e.id),
    ).toEqual(['model/openrouter:moonshotai/kimi-k2.5', 'lab/moonshot']);
  });

  it('holds an entering codename, because a codename names no company', () => {
    expect(entitiesForLeak(leak({ type: 'codename_entered', subject: 'cold_brew' }))).toEqual([]);
  });

  it('holds an unmasked codename for the same reason', () => {
    expect(entitiesForLeak(leak({ type: 'codename_unmasked', subject: 'cold_brew' }))).toEqual([]);
  });

  it('holds an opened pull request, whose subject is a repository and a number', () => {
    expect(entitiesForLeak(leak({ type: 'upstream_pr_opened', subject: 'huggingface/transformers#1' }))).toEqual([]);
  });

  it('holds a merged pull request for the same reason', () => {
    expect(entitiesForLeak(leak({ type: 'upstream_pr_merged', subject: 'vllm-project/vllm#2' }))).toEqual([]);
  });
});

describe('buildFeed', () => {
  it('puts the newest stamp first across both derivations', () => {
    const feed = buildFeed([event()], [leak()]);
    expect(feed.map((i) => i.kind)).toEqual(['leak', 'event']);
  });

  // INPUT ORDER IS THE REVERSE OF ID ORDER on purpose. With the two in id
  // order already, a comparator that had lost its tie-break entirely would
  // still produce the expected list, and the assertion would prove nothing.
  it('breaks a stamp tie on the item id rather than on which derivation came first', () => {
    const b = event({ id: 'b', stamp: stamp('2026-08-28T08:00:00.000Z') });
    const a = leak({ id: 'a', stamp: stamp('2026-08-28T08:00:00.000Z') });
    expect(buildFeed([b], [a]).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('breaks a tie between two events the same way', () => {
    const later = event({ id: 'zzz', stamp: stamp('2026-08-28T08:00:00.000Z') });
    const earlier = event({ id: 'aaa', stamp: stamp('2026-08-28T08:00:00.000Z') });
    expect(buildFeed([later, earlier], []).map((i) => i.id)).toEqual(['aaa', 'zzz']);
  });

  // The stamp is a string off a sidecar, so an unparseable one is reachable.
  // It sorts with the stampless rather than ahead of everything.
  it('sorts an item whose stamp does not parse last rather than first', () => {
    const bad = event({ id: 'bad', stamp: { iso: 'not a date at all', kind: 'origin' } });
    const good = event({ id: 'good' });
    expect(buildFeed([bad, good], []).map((i) => i.id)).toEqual(['good', 'bad']);
  });

  it('sorts an item with no stamp last rather than first', () => {
    const feed = buildFeed([event({ id: 'no-stamp', stamp: null }), event({ id: 'stamped' })], []);
    expect(feed.map((i) => i.id)).toEqual(['stamped', 'no-stamp']);
  });

  it('keeps both items when two share a stamp and a type', () => {
    expect(buildFeed([event({ id: 'a' }), event({ id: 'b', sha: OTHER })], [])).toHaveLength(2);
  });

  it('returns nothing at all for two empty derivations', () => {
    expect(buildFeed([], [])).toEqual([]);
  });
});

describe('itemsOfType', () => {
  it('keeps only the items of the type asked for', () => {
    const feed = buildFeed([event()], [leak()]);
    expect(itemsOfType(feed, 'codename_entered').map((i) => i.id)).toEqual([`${SHA}:codename_entered:cold_brew`]);
  });

  it('returns nothing for a type the archive holds none of', () => {
    expect(itemsOfType(buildFeed([event()], []), 'price_changed')).toEqual([]);
  });
});

describe('labsOf and the lab pages it feeds', () => {
  it('reads the lab off the entities the derivation attached', () => {
    expect(labsOf(feedItemFromEvent(event()))).toEqual(['anthropic']);
  });

  it('reads no lab off an item whose entities carry none', () => {
    expect(labsOf(feedItemFromEvent(event({ entities: [MODEL] })))).toEqual([]);
  });

  // Only an entity of kind `lab` names a lab. A model whose label happens to
  // spell a vendor is still a model, and reading the label off it would file a
  // model called `anthropic` under Anthropic on the strength of its name.
  it('reads no lab off a model entity whose label spells one', () => {
    const looksLikeALab: Entity = { kind: 'model', id: 'model/openrouter:x/y', label: 'anthropic' };
    expect(labsOf(feedItemFromEvent(event({ entities: [looksLikeALab] })))).toEqual([]);
  });

  // A lab entity whose label is not in the vendor table yields nothing rather
  // than a null pushed into the list, which would emit a lab page at lab/null.
  it('reads no lab off a lab entity the vendor table does not hold', () => {
    const unknown: Entity = { kind: 'lab', id: 'lab/aion-labs', label: 'aion-labs' };
    expect(labsOf(feedItemFromEvent(event({ entities: [unknown] })))).toEqual([]);
  });

  it('lists a lab once when one item carries two entities naming it', () => {
    const twice: Entity[] = [LAB, { kind: 'lab', id: 'lab/anthropic', label: 'anthropic' }];
    expect(labsOf(feedItemFromEvent(event({ entities: twice })))).toEqual(['anthropic']);
  });

  it('lists two distinct labs on one item in the order its entities carry them', () => {
    const two: Entity[] = [LAB, { kind: 'lab', id: 'lab/moonshot', label: 'moonshot' }];
    expect(labsOf(feedItemFromEvent(event({ entities: two })))).toEqual(['anthropic', 'moonshot']);
  });

  it('lists a lab once even when two items carry it', () => {
    expect(labsInFeed(buildFeed([event({ id: 'a' }), event({ id: 'b' })], []))).toEqual(['anthropic']);
  });

  it('lists labs in the order the feed first mentions them', () => {
    const moonshot = leak({
      id: 'z',
      type: 'expiration_scheduled',
      subject: 'moonshotai/kimi-k2.5',
      stamp: stamp('2026-08-29T00:00:00.000Z'),
      facts: [['expiration_date', '2026-09-30']],
    });
    expect(labsInFeed(buildFeed([event()], [moonshot]))).toEqual(['moonshot', 'anthropic']);
  });

  it('filters the feed down to one lab', () => {
    const feed = buildFeed([event()], [leak()]);
    expect(itemsOfLab(feed, 'anthropic').map((i) => i.kind)).toEqual(['event']);
  });

  it('returns nothing for a lab the archive carries no item of', () => {
    expect(itemsOfLab(buildFeed([event()], []), 'groq')).toEqual([]);
  });
});

describe('countsByType', () => {
  it('counts an item under its own type', () => {
    expect(countsByType(buildFeed([event()], [])).get('model_added')).toBe(1);
  });

  // Zero is a value here, not an absence: the front page prints a chip for
  // every category and a missing key would render a chip with no number.
  it('counts two items of one type as two', () => {
    const feed = buildFeed([event({ id: 'a' }), event({ id: 'b' })], []);
    expect(countsByType(feed).get('model_added')).toBe(2);
  });

  it('counts items of two types separately', () => {
    const feed = buildFeed([event()], [leak()]);
    expect([countsByType(feed).get('model_added'), countsByType(feed).get('codename_entered')]).toEqual([1, 1]);
  });

  it('reports zero for a type the archive holds none of', () => {
    expect(countsByType(buildFeed([event()], [])).get('codename_unmasked')).toBe(0);
  });

  it('has an entry for every declared type on an empty feed', () => {
    expect([...countsByType([]).keys()]).toEqual(ALL_TYPES);
  });
});

/**
 * ALL_TYPES is the list the publication emits a page per, so a type that a
 * derivation can produce and that is missing from it is an item with no
 * category page. These two check the list against the two unions themselves.
 */
describe('ALL_TYPES covers both derivations', () => {
  it('lists every event type', () => {
    const events: EventType[] = [
      'model_added',
      'model_removed',
      'price_changed',
      'context_changed',
      'expiration_set',
      'alias_retargeted',
      'doc_added',
      'doc_removed',
      'retirement_floor',
    ];
    expect(events.filter((t) => !ALL_TYPES.includes(t))).toEqual([]);
  });

  it('lists every leak type', () => {
    const leaks: LeakType[] = [
      'codename_entered',
      'codename_unmasked',
      'upstream_pr_opened',
      'upstream_pr_merged',
      'stealth_listing',
      'expiration_scheduled',
    ];
    expect(leaks.filter((t) => !ALL_TYPES.includes(t))).toEqual([]);
  });

  it('lists no type twice', () => {
    expect(new Set(ALL_TYPES).size).toBe(ALL_TYPES.length);
  });

  it('lists exactly fifteen types', () => {
    expect(ALL_TYPES).toHaveLength(15);
  });
});
