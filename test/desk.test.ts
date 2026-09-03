import { describe, expect, it } from 'vitest';
import type { FeedItem, FeedType } from '../src/derive/feed.js';
import {
  typeBits,
  scoreItem,
  ageDays,
  countsByType,
  COOLDOWN_DAYS,
  POSTABLE_TYPES,
} from '../src/desk/surprise.js';
import { draftFor, draftsFor, PLATFORMS, changeUrl } from '../src/desk/drafts.js';
import { buildQueue, cooldownKeys } from '../src/desk/queue.js';
import { lastPostedByEntity, parsePosted, postedIds, type PostedRow } from '../src/desk/ledger.js';

const SITE = 'https://diffwire.dev';

function item(over: Partial<FeedItem> & { type: FeedType; id: string }): FeedItem {
  return {
    kind: 'event',
    sentence: 'A sentence.',
    sha: 'a'.repeat(40),
    sourceId: 'src',
    path: 'raw/src/x.json',
    stamp: { iso: '2026-09-02T00:00:00.000Z', kind: 'origin' },
    entities: [],
    facts: [],
    tier: null,
    event: null,
    leak: null,
    ...over,
  } as FeedItem;
}

describe('the scorer measures rarity in bits', () => {
  /**
   * The claim is Shannon's, so it is checked against Shannon's number and not
   * against "bigger than the other one". A type holding 1 of 7 slots under
   * add-one smoothing over 2 kinds is (1+1)/(7+2) = 2/9, which is 2.17 bits.
   * An equality test is what makes the smoothing constant load-bearing: drop
   * the +1 and this reads 2.81, drop the +kinds and it reads 2.00.
   */
  it('is the Laplace-smoothed information content, exactly', () => {
    const counts = new Map<FeedType, number>([
      ['model_added', 6],
      ['model_removed', 1],
    ]);
    expect(typeBits('model_removed', counts)).toBeCloseTo(-Math.log2(2 / 9), 10);
    expect(typeBits('model_added', counts)).toBeCloseTo(-Math.log2(7 / 9), 10);
  });

  it('gives a rarer type strictly more bits than a common one', () => {
    const counts = new Map<FeedType, number>([['model_added', 400], ['model_removed', 2]]);
    expect(typeBits('model_removed', counts)).toBeGreaterThan(typeBits('model_added', counts));
  });

  /**
   * A type absent from the archive must not read as infinitely surprising. It
   * is the case that breaks an unsmoothed -log2(0/n), and it is reachable: a
   * new source's first capture emits types nothing else has produced.
   */
  it('stays finite for a type the archive has never seen', () => {
    const bits = typeBits('model_removed', new Map<FeedType, number>([['model_added', 10]]));
    expect(Number.isFinite(bits)).toBe(true);
  });

  it('counts an empty archive without dividing by zero', () => {
    expect(Number.isFinite(typeBits('model_added', new Map()))).toBe(true);
  });
});

describe('staleness', () => {
  it('charges one bit per whole day', () => {
    const counts = new Map<FeedType, number>([['model_removed', 1]]);
    const two = scoreItem(
      item({ type: 'model_removed', id: 'a:model_removed:m', stamp: { iso: '2026-09-01T00:00:00.000Z', kind: 'origin' } }),
      counts, new Map(), new Date('2026-09-03T00:00:00.000Z'),
    );
    const fresh = scoreItem(
      item({ type: 'model_removed', id: 'a:model_removed:m', stamp: { iso: '2026-09-03T00:00:00.000Z', kind: 'origin' } }),
      counts, new Map(), new Date('2026-09-03T00:00:00.000Z'),
    );
    expect(fresh!.bits - two!.bits).toBeCloseTo(2, 6);
  });

  /** A clock behind the archive must not pay a bonus for a future item. */
  it('never pays for an item stamped in the future', () => {
    expect(ageDays('2026-12-01T00:00:00.000Z', new Date('2026-09-03T00:00:00.000Z'))).toBe(0);
  });

  it('treats an unparseable stamp as no adjustment rather than NaN', () => {
    expect(ageDays('not a date', new Date('2026-09-03T00:00:00.000Z'))).toBe(0);
  });
});

describe('the cooldown', () => {
  const counts = new Map<FeedType, number>([['model_removed', 1]]);
  const subject = item({ type: 'model_removed', id: 'a:model_removed:m', entities: [{ kind: 'model', id: 'gpt-5' } as never] });

  it('holds an item whose entity was posted inside the window', () => {
    const posted = new Map([['model:gpt-5', '2026-09-02T00:00:00.000Z']]);
    expect(scoreItem(subject, counts, posted, new Date('2026-09-03T00:00:00.000Z'))).toBeNull();
  });

  it('releases it once the window has passed', () => {
    const posted = new Map([['model:gpt-5', '2026-09-02T00:00:00.000Z']]);
    const after = new Date(Date.parse('2026-09-02T00:00:00.000Z') + (COOLDOWN_DAYS + 0.1) * 86_400_000);
    expect(scoreItem(subject, counts, posted, after)).not.toBeNull();
  });

  /**
   * The gap this closes. A codename that has not resolved names no entity, so
   * `entities` is legitimately empty, and an empty key list exempts the item
   * from the cooldown entirely. Those are exactly the items that recur: the
   * codename is recaptured every run and each capture mints a new sha, so the
   * id changes while the story does not.
   */
  it('falls back to the id subject when an item names no entity', () => {
    expect(cooldownKeys(item({ type: 'codename_entered', id: 'sha1:codename_entered:kiana' })))
      .toEqual(['subject:codename_entered:kiana']);
    /* Same story, a later capture, a different sha: still one key. */
    expect(cooldownKeys(item({ type: 'codename_entered', id: 'sha2:codename_entered:kiana' })))
      .toEqual(['subject:codename_entered:kiana']);
  });

  it('prefers the derived entities when there are any', () => {
    const keys = cooldownKeys(item({ type: 'model_added', id: 's:model_added:x', entities: [{ kind: 'model', id: 'gpt-5' } as never] }));
    expect(keys).toEqual(['model:gpt-5']);
  });

  /** A subject holding colons must not be cut at the first one. */
  it('keeps a subject that contains colons whole', () => {
    expect(cooldownKeys(item({ type: 'incident_opened', id: 'sha:incident_opened:tag:status.x,2005:Incident/31' })))
      .toEqual(['subject:incident_opened:tag:status.x,2005:Incident/31']);
  });
});

describe('drafts never rewrite a claim', () => {
  /**
   * THE LOAD-BEARING TEST OF THIS WHOLE MODULE. Every other guarantee in the
   * project is about a sentence saying exactly what the stored bytes support,
   * and a post is where that sentence travels furthest from its evidence. So
   * the guarantee here is mechanical and total: a draft either carries the
   * sentence byte for byte or does not exist. There is no length at which
   * cutting is safe, because a prefix can invert a claim ("no models were
   * removed" cut to "no models were") and not merely weaken it.
   */
  it('emits the sentence verbatim or emits nothing at all', () => {
    const long = 'x'.repeat(400);
    for (const spec of PLATFORMS) {
      const out = draftFor(item({ type: 'model_added', id: 'a:model_added:m', sentence: long }), spec, SITE);
      if ('need' in out) {
        expect(out.need).toBeGreaterThan(out.limit);
        continue;
      }
      expect((out.title ?? out.text)!).toContain(long);
    }
  });

  it('reports the shortfall as the real length against the real limit', () => {
    const sentence = 'y'.repeat(100);
    const hn = PLATFORMS.find((p) => p.id === 'hn')!;
    const out = draftFor(item({ type: 'model_added', id: 'a:model_added:m', sentence }), hn, SITE);
    expect(out).toEqual({ platform: 'hn', need: 100, limit: 80 });
  });

  /**
   * The link costs characters on the platforms that carry it in the body, so a
   * sentence that fits the limit on its own can still overflow. The fixture is
   * built to sit in that gap: 200 characters is under Bluesky's 300 and over it
   * once a ~68 character URL and a blank line are added.
   */
  it('counts the link against the body budget, not just the sentence', () => {
    const sentence = 'z'.repeat(240);
    const bsky = PLATFORMS.find((p) => p.id === 'bluesky')!;
    const url = changeUrl(item({ type: 'model_added', id: 'a:model_added:m' }), SITE);
    expect(sentence.length).toBeLessThan(300);
    expect(sentence.length + 2 + url.length).toBeGreaterThan(300);
    const out = draftFor(item({ type: 'model_added', id: 'a:model_added:m', sentence }), bsky, SITE);
    expect('need' in out).toBe(true);
  });

  it('links to the change page, which is where the diff is', () => {
    const sha = 'b'.repeat(40);
    expect(changeUrl(item({ type: 'model_added', id: 'a:model_added:m', sha }), SITE))
      .toBe(`https://diffwire.dev/changes/${sha}.html`);
  });

  it('percent-encodes the sentence into every prefilled submit link', () => {
    const sentence = 'A "quoted" value & a slash/';
    const { drafts } = draftsFor(item({ type: 'model_added', id: 'a:model_added:m', sentence }), SITE);
    for (const d of drafts) {
      if (d.submitUrl === null || d.platform === 'linkedin') continue;
      expect(d.submitUrl).toContain(encodeURIComponent(sentence));
      expect(d.submitUrl).not.toContain('"');
    }
  });
});

describe('the queue', () => {
  const counts = (n: number): FeedItem[] =>
    Array.from({ length: n }, (_, i) => item({ type: 'price_changed' as FeedType, id: `p${i}:price_changed:m${i}` }));

  it('offers nothing when every candidate is below the floor', () => {
    const feed = [...counts(10), item({ type: 'model_added', id: 'a:model_added:m', sentence: 'S.' })];
    const q = buildQueue(feed, [], new Date('2026-09-02T00:00:00.000Z'), SITE, 99);
    expect(q.candidates).toEqual([]);
    expect(q.funnel.aboveFloor).toBe(0);
  });

  it('reports which gate emptied it', () => {
    const q = buildQueue(counts(10), [], new Date('2026-09-02T00:00:00.000Z'), SITE);
    expect(q.funnel).toEqual({ seen: 10, postableType: 0, notOnCooldown: 0, aboveFloor: 0 });
  });

  /**
   * One capture that retires four models in a family produced four near
   * identical drafts, and approving all four is the behaviour that gets an
   * account read as a spammer. The dedupe is per entity, so two genuinely
   * different subjects in one run still both appear.
   */
  it('offers at most one candidate per subject in a single run', () => {
    const feed = [
      item({ type: 'model_removed', id: 's:model_removed:a', entities: [{ kind: 'model', id: 'm' } as never], sentence: 'One.' }),
      item({ type: 'model_removed', id: 's:model_removed:b', entities: [{ kind: 'model', id: 'm' } as never], sentence: 'Two.' }),
      item({ type: 'model_removed', id: 's:model_removed:c', entities: [{ kind: 'model', id: 'other' } as never], sentence: 'Three.' }),
    ];
    const q = buildQueue(feed, [], new Date('2026-09-02T00:00:00.000Z'), SITE, 0);
    expect(q.candidates.map((c) => c.entities[0])).toEqual(['model:m', 'model:other']);
  });

  it('does not re-offer an item to a platform it already went to', () => {
    const one = item({ type: 'model_removed', id: 's:model_removed:a', sentence: 'Short.' });
    const posted: PostedRow[] = PLATFORMS.filter((p) => p.id !== 'hn').map((p) => ({
      id: 's:model_removed:a', platform: p.id, entities: [], posted_at: '2020-01-01T00:00:00.000Z', permalink: null, via: 'human',
    }));
    const q = buildQueue([one], posted, new Date('2026-09-02T00:00:00.000Z'), SITE, 0);
    expect(q.candidates[0]!.drafts.map((d) => d.platform)).toEqual(['hn']);
  });

  it('drops a candidate once every platform has had it', () => {
    const one = item({ type: 'model_removed', id: 's:model_removed:a', sentence: 'Short.' });
    const posted: PostedRow[] = PLATFORMS.map((p) => ({
      id: 's:model_removed:a', platform: p.id, entities: [], posted_at: '2020-01-01T00:00:00.000Z', permalink: null, via: 'human',
    }));
    expect(buildQueue([one], posted, new Date('2026-09-02T00:00:00.000Z'), SITE, 0).candidates).toEqual([]);
  });

  it('ranks by bits, most surprising first', () => {
    const feed = [
      ...Array.from({ length: 40 }, (_, i) => item({ type: 'model_added', id: `x${i}:model_added:m${i}`, sentence: 'Common.' })),
      item({ type: 'model_removed', id: 'r:model_removed:rare', sentence: 'Rare.' }),
    ];
    const q = buildQueue(feed, [], new Date('2026-09-02T00:00:00.000Z'), SITE, 0);
    expect(q.candidates[0]!.item.sentence).toBe('Rare.');
  });

  it('excludes types that are archive telemetry rather than news', () => {
    expect(POSTABLE_TYPES.has('price_changed' as FeedType)).toBe(false);
    expect(POSTABLE_TYPES.has('doc_added' as FeedType)).toBe(false);
    expect(POSTABLE_TYPES.has('model_removed')).toBe(true);
  });
});

describe('the posted ledger is the state', () => {
  const rows: PostedRow[] = [
    { id: 'a', platform: 'hn', entities: ['model:m'], posted_at: '2026-08-01T00:00:00.000Z', permalink: null, via: 'human' },
    { id: 'b', platform: 'bluesky', entities: ['model:m'], posted_at: '2026-09-01T00:00:00.000Z', permalink: 'https://x', via: 'api' },
  ];

  /** Latest, not first: a first-wins fold makes a daily subject look untouched. */
  it('remembers the most recent post about an entity, not the earliest', () => {
    expect(lastPostedByEntity(rows).get('model:m')).toBe('2026-09-01T00:00:00.000Z');
  });

  it('keys the dedupe by item and platform together', () => {
    const ids = postedIds(rows);
    expect(ids.has('a::hn')).toBe(true);
    expect(ids.has('a::bluesky')).toBe(false);
  });

  it('parses the append-only file and tolerates blank lines', () => {
    const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n\n';
    expect(parsePosted(text)).toHaveLength(2);
  });

  it('records whether a human or the routine submitted it', () => {
    expect(parsePosted(JSON.stringify(rows[1]))[0]!.via).toBe('api');
  });
});
