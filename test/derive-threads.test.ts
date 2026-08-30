import { describe, it, expect } from 'vitest';
import { buildThreads, threadsOfKind } from '../src/derive/threads.js';
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

describe('buildThreads', () => {
  it('opens one thread per entity an event names', () => {
    expect(buildThreads([event()]).threads.map((t) => t.entity.id)).toEqual([
      'lab/anthropic',
      'model/openrouter:anthropic/claude-opus-5',
    ]);
  });

  // The same event on both threads is the point of the model: a price change on
  // a model is an event in that model's story and in its lab's, and duplicating
  // a link is cheaper than making a reader guess which one we filed it under.
  it('puts one event on every thread it names', () => {
    const set = buildThreads([event()]);
    expect(set.threads.map((t) => t.events.length)).toEqual([1, 1]);
  });

  it('accretes two events onto the one thread they share', () => {
    const set = buildThreads([
      event({ id: 'a' }),
      event({ id: 'b', stamp: stamp('2026-08-29T08:00:00.000Z') }),
    ]);
    expect(set.threads[0]?.events.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('orders a thread newest first by the timestamp the page shows', () => {
    const set = buildThreads([
      event({ id: 'old', stamp: stamp('2026-08-26T08:00:00.000Z') }),
      event({ id: 'new', stamp: stamp('2026-08-30T08:00:00.000Z') }),
      event({ id: 'mid', stamp: stamp('2026-08-28T08:00:00.000Z') }),
    ]);
    expect(set.threads[0]?.events.map((e) => e.id)).toEqual(['new', 'mid', 'old']);
  });

  it('reports the oldest event on the thread as its first seen', () => {
    const set = buildThreads([
      event({ id: 'old', stamp: stamp('2026-08-26T08:00:00.000Z') }),
      event({ id: 'new', stamp: stamp('2026-08-30T08:00:00.000Z') }),
    ]);
    expect(set.threads[0]?.firstSeen?.iso).toBe('2026-08-26T08:00:00.000Z');
  });

  it('reports the newest event on the thread as its last activity', () => {
    const set = buildThreads([
      event({ id: 'old', stamp: stamp('2026-08-26T08:00:00.000Z') }),
      event({ id: 'new', stamp: stamp('2026-08-30T08:00:00.000Z') }),
    ]);
    expect(set.threads[0]?.lastActivity?.iso).toBe('2026-08-30T08:00:00.000Z');
  });

  it('reports null on both ends when no event on the thread carries a stamp', () => {
    const set = buildThreads([event({ stamp: null })]);
    expect([set.threads[0]?.firstSeen, set.threads[0]?.lastActivity]).toEqual([null, null]);
  });

  it('reads first seen past an unstamped event rather than reporting null', () => {
    const set = buildThreads([
      event({ id: 'stamped', stamp: stamp('2026-08-26T08:00:00.000Z') }),
      event({ id: 'unstamped', stamp: null }),
    ]);
    expect(set.threads[0]?.firstSeen?.iso).toBe('2026-08-26T08:00:00.000Z');
  });

  it('orders threads by last activity, most recent first', () => {
    const other: Entity = { kind: 'lab', id: 'lab/openai', label: 'openai' };
    const set = buildThreads([
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
    const set = buildThreads([
      event({ id: 'a', entities: [zed] }),
      event({ id: 'b', entities: [LAB] }),
    ]);
    expect(set.threads.map((t) => t.entity.id)).toEqual(['lab/anthropic', 'lab/zai']);
  });

  it('gives every thread the slug its entity folds to', () => {
    expect(buildThreads([event()]).threads.map((t) => t.slug)).toEqual([
      'lab-anthropic',
      'model-openrouter-anthropic-claude-opus-5',
    ]);
  });

  // entitySlug is lossy, and the failure it would otherwise produce is one
  // entity's page served under another entity's permalink, committed to a
  // history that is never rewritten.
  it('refuses to build when two distinct entities fold to one slug', () => {
    const a: Entity = { kind: 'lab', id: 'lab/a-b', label: 'x' };
    const b: Entity = { kind: 'lab', id: 'lab/a/b', label: 'y' };
    expect(() => buildThreads([event({ entities: [a] }), event({ entities: [b] })])).toThrow(
      'thread slug collision',
    );
  });

  it('builds without complaint when one entity appears on many events', () => {
    expect(buildThreads([event({ id: 'a' }), event({ id: 'b' })]).threads).toHaveLength(2);
  });
});

describe('held events', () => {
  it('opens no thread for an event that names no entity', () => {
    expect(buildThreads([event({ entities: [] })]).threads).toEqual([]);
  });

  it('keeps an event that names no entity rather than dropping it', () => {
    expect(buildThreads([event({ entities: [], id: 'orphan' })]).held.map((e) => e.id)).toEqual([
      'orphan',
    ]);
  });

  it('orders held events newest first, as a thread orders its own', () => {
    const set = buildThreads([
      event({ id: 'old', entities: [], stamp: stamp('2026-08-26T08:00:00.000Z') }),
      event({ id: 'new', entities: [], stamp: stamp('2026-08-30T08:00:00.000Z') }),
    ]);
    expect(set.held.map((e) => e.id)).toEqual(['new', 'old']);
  });

  it('holds nothing when every event named an entity', () => {
    expect(buildThreads([event()]).held).toEqual([]);
  });
});

describe('threadsOfKind', () => {
  it('returns only the threads of the kind asked for', () => {
    const set = buildThreads([event()]);
    expect(threadsOfKind(set.threads, 'lab').map((t) => t.entity.id)).toEqual(['lab/anthropic']);
  });

  it('returns an empty list for a kind no thread carries', () => {
    const set = buildThreads([event()]);
    expect(threadsOfKind(set.threads, 'api-surface')).toEqual([]);
  });
});

describe('an event with no usable timestamp', () => {
  // Sorting it FIRST would put an event the archive cannot date at the top of a
  // thread, above events it can, which reads as the newest thing that happened.
  it('sorts last within its thread', () => {
    const set = buildThreads([
      event({ id: 'unstamped', stamp: null }),
      event({ id: 'stamped', stamp: stamp('2026-08-26T08:00:00.000Z') }),
    ]);
    expect(set.threads[0]?.events.map((e) => e.id)).toEqual(['stamped', 'unstamped']);
  });

  it('sorts last even when it was supplied first', () => {
    const set = buildThreads([
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
    const set = buildThreads([
      event({ id: 'a', entities: [openai], stamp: stamp('2026-08-30T08:00:00.000Z') }),
      event({ id: 'b', entities: [LAB], stamp: null }),
      event({ id: 'c', entities: [zai], stamp: stamp('2026-08-26T08:00:00.000Z') }),
    ]);
    expect(set.threads.map((t) => t.entity.id)).toEqual(['lab/openai', 'lab/zai', 'lab/anthropic']);
  });

  it('sorts a thread with no datable activity behind one that has some', () => {
    const other: Entity = { kind: 'lab', id: 'lab/openai', label: 'openai' };
    const set = buildThreads([
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
    expect(buildThreads([event({ entities: [a] }), event({ entities: [b] })]).threads).toHaveLength(2);
  });

  it('builds without throwing when one entity appears on two events', () => {
    const a: Entity = { kind: 'lab', id: 'lab/anthropic', label: 'x' };
    expect(
      buildThreads([event({ id: 'x', entities: [a] }), event({ id: 'y', entities: [a] })]).threads,
    ).toHaveLength(1);
  });
});
