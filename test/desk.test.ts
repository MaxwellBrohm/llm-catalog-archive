import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isShallow } from '../src/git.js';
import type { FeedItem, FeedType } from '../src/derive/feed.js';
import {
  typeBits,
  scoreItem,
  ageDays,
  countsByType,
  COOLDOWN_DAYS,
  POSTABLE_TYPES,
} from '../src/desk/surprise.js';
import { draftFor, draftsFor, PLATFORMS, changeUrl, type Draft } from '../src/desk/drafts.js';
import { hnTitle } from '../src/desk/titles.js';
import { ALERT_FLOOR_BITS, ALERT_MEMORY, alertable, nextAlertState, parseAlertState, type AlertState } from '../src/desk/alert.js';
import type { Candidate } from '../src/desk/queue.js';
import { arenaRows } from '../src/predicate.js';
import { arenaCodenameMap, ARENA_CODENAME_FLOOR, isCodenameReveal, leaksFromChange, leakSentence } from '../src/derive/leaks.js';
import { buildQueue, cooldownKeys, HN_PER_DAY } from '../src/desk/queue.js';
import { recommend } from '../src/desk/route.js';
import { VENUES, venuesFor, allRoutedVenueIds, ROUTE_TABLE, blockedVenueIds } from '../src/desk/venues.js';
import { ALL_TYPES } from '../src/derive/feed.js';
import {
  lastPostedByEntity, parsePosted, postedIds, parseCorrections, correctedIds, type PostedRow,
} from '../src/desk/ledger.js';

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
    expect(out).toEqual({ platform: 'hn', venue: 'hn', need: 100, limit: 80 });
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

  /**
   * The desk hands back a decision, not a menu, so the assertion is about which
   * ONE venue leads. A model_removed with no known vendor sub falls through to
   * r/LocalLLaMA, which is the route's own named fallback.
   */
  it('offers one venue, not every platform', () => {
    const one = item({ type: 'model_removed', id: 's:model_removed:a', sentence: 'Short.' });
    const q = buildQueue([one], [], new Date('2026-09-02T00:00:00.000Z'), SITE, 0);
    expect(q.candidates[0]!.route.primary!.venue).toBe('hn');
    expect(q.candidates[0]!.route.why).toBeTruthy();
  });

  it('falls through to the next venue once the first has had it', () => {
    const one = item({ type: 'model_removed', id: 's:model_removed:a', sentence: 'Short.' });
    const posted: PostedRow[] = [{
      id: 's:model_removed:a', platform: 'hn', venue: 'hn', entities: [],
      posted_at: '2020-01-01T00:00:00.000Z', permalink: null, via: 'human',
    }];
    const q = buildQueue([one], posted, new Date('2026-09-02T00:00:00.000Z'), SITE, 0);
    expect(q.candidates[0]!.route.primary!.venue).not.toBe('reddit:LocalLLaMA');
  });

  it('drops a candidate once every routed venue has had it', () => {
    const one = item({ type: 'model_removed', id: 's:model_removed:a', sentence: 'Short.' });
    const posted: PostedRow[] = ['reddit:LocalLLaMA', 'hn', 'bluesky'].map((venue) => ({
      id: 's:model_removed:a', platform: 'reddit' as const, venue, entities: [],
      posted_at: '2020-01-01T00:00:00.000Z', permalink: null, via: 'human',
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

describe('a truncated archive is refused, not scored', () => {
  /**
   * The scorer reads the distribution of event types over the WHOLE history, so
   * a shallow clone does not merely miss old items: it changes the probability
   * of every type and therefore the score of every candidate still present. The
   * first cloud run of the routine scored over 74 changes where the full clone
   * holds 427 and ranked a different candidate first. Nothing about that output
   * looked wrong, which is why the check has to be mechanical.
   */
  it('reports a shallow clone as shallow and a full one as not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-'));
    const full = path.join(dir, 'full');
    const shallow = path.join(dir, 'shallow');
    const run = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'pipe' });

    fs.mkdirSync(full);
    run(['init', '-q', '-b', 'main'], full);
    run(['config', 'user.email', 't@t'], full);
    run(['config', 'user.name', 't'], full);
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(full, 'f.txt'), String(i));
      run(['add', 'f.txt'], full);
      run(['commit', '-q', '-m', `c${i}`], full);
    }
    expect(isShallow(full)).toBe(false);

    run(['clone', '-q', '--depth', '1', 'file://' + full, shallow], dir);
    expect(isShallow(shallow)).toBe(true);

    /* The remedy the error message names must actually clear it. */
    run(['fetch', '-q', '--unshallow'], shallow);
    expect(isShallow(shallow)).toBe(false);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('routing: one place, and the reason', () => {
  /**
   * The point of the whole file. A menu of six platforms is not a
   * recommendation, and the temptation it creates is to press all of them,
   * which is what a community reads as spam and what actually costs an account.
   */
  it('recommends exactly one venue and names why', () => {
    const r = recommend(item({ type: 'codename_unmasked', id: 'a:codename_unmasked:kiana', sentence: 'Short.' }), SITE);
    expect(r.primary!.venue).toBe('hn');
    expect(r.why).toContain('unreleased model');
    expect(r.blocked).toBeNull();
  });

  /**
   * A subreddit is the address, not a preference. Reddit's bare /submit lands a
   * person on a chooser, and the choice is the part that decides whether a post
   * survives the hour, so the link must carry the sub.
   */
  /**
   * Reddit is no longer routed, but the drafter still knows how to address a
   * subreddit, and it must keep doing so correctly for the day it comes back:
   * a link to reddit.com/submit lands on a generic form that asks which
   * community, which is not one tap.
   */
  it('addresses a Reddit draft at the subreddit, not at reddit.com', () => {
    const v = VENUES['reddit:LocalLLaMA']!;
    const d = draftFor(item({ type: 'codename_unmasked', id: 'a:codename_unmasked:k', sentence: 'Short.' }),
      PLATFORMS.find((p) => p.id === 'reddit')!, SITE, v.id, v.label, v.sub);
    expect('need' in d).toBe(false);
    expect((d as Draft).submitUrl).toContain('/r/LocalLLaMA/submit?');
    expect((d as Draft).label).toBe('r/LocalLLaMA');
  });

  /**
   * A migration someone has to perform goes where the people who have to
   * perform it are, ahead of where the most people are. The lab is read off the
   * source id when the event carries no lab entity, which is the usual case for
   * the deprecations and status feeds.
   */
  it('sends a dated retirement to Hacker News first', () => {
    const r = recommend(
      item({ type: 'retirement_floor', id: 'a:retirement_floor:m', sentence: 'Short.', sourceId: 'openai-deprecations' }),
      SITE,
    );
    expect(r.primary!.venue).toBe('hn');
  });

  /**
   * An outage is NOT Hacker News material: it matters to the people whose
   * builds are failing right now and to almost nobody else, and a front page
   * of status-page reposts is what gets a domain flagged there. Bluesky only.
   */
  it('keeps an incident off Hacker News', () => {
    const r = recommend(
      item({ type: 'incident_opened', id: 'a:incident_opened:i', sentence: 'Short.', sourceId: 'claude-status' }),
      SITE,
    );
    expect(r.primary!.venue).toBe('bluesky');
    expect([r.primary, ...r.others].map((d) => d!.venue)).not.toContain('hn');
  });

  /** No known vendor sub must fall through to a real audience, never vanish. */
  it('routes a source with no lab of its own the same as any other', () => {
    const r = recommend(
      item({ type: 'model_removed', id: 'a:model_removed:m', sentence: 'Short.', sourceId: 'groq-llms-full-txt' }),
      SITE,
    );
    expect(r.primary!.venue).toBe('hn');
  });

  /**
   * HN's 80 character title limit against 150 character sentences is why the
   * routing must fall THROUGH rather than offer a button that cannot be
   * pressed. upstream_pr_merged routes to LocalLLaMA then HN, so a sentence too
   * long for HN still leaves one venue and a recorded shortfall.
   */
  it('drops a venue the sentence cannot fit and keeps going', () => {
    const long = 'x'.repeat(150);
    /* No facts, so no template can be composed either: HN is a shortfall,
       and upstream_pr_merged routes nowhere else, so nothing is offered. */
    const r = recommend(item({ type: 'upstream_pr_merged', id: 'a:upstream_pr_merged:p', sentence: long }), SITE);
    expect(r.primary).toBeNull();
    expect(r.shortfalls.map((s) => s.venue)).toEqual(['hn']);
    /* Add the facts a real one carries and HN becomes reachable through the template. */
    const real = recommend(item({ type: 'upstream_pr_merged', id: 'a:upstream_pr_merged:p', sentence: long, kind: 'leak',
      facts: [['repository', 'vllm-project/vllm'], ['architecture named in the title', 'Foo-9']] } as never), SITE);
    expect(real.primary!.venue).toBe('hn');
    expect(real.primary!.titleBy).toBe('template');
  });

  it('says which gate emptied the route rather than returning a bare null', () => {
    const r = recommend(item({ type: 'price_changed', id: 'a:price_changed:m', sentence: 'Short.' }), SITE);
    expect(r.primary).toBeNull();
    expect(r.blocked).toContain('no venue is routed');
  });

  it('reports being posted out rather than looking like a routing failure', () => {
    const one = item({ type: 'codename_entered', id: 'a:codename_entered:k', sentence: 'Short.' });
    const posted = new Set(['a:codename_entered:k::reddit:LocalLLaMA', 'a:codename_entered:k::bluesky']);
    const r = recommend(one, SITE, posted);
    expect(r.primary).toBeNull();
    expect(r.blocked).toBe('already posted everywhere it was routed');
  });

  /**
   * The venue key is the whole reason the ledger gained a venue field. Keyed on
   * platform, one post to r/OpenAI would retire r/LocalLLaMA too.
   */
  it('treats two venues as two places, keyed on venue and not platform', () => {
    const one = item({ type: 'model_removed', id: 'a:model_removed:m', sentence: 'Short.', sourceId: 'openai-deprecations' });
    /* A row keyed on a venue this item does not route to must not count. */
    const elsewhere = new Set(['a:model_removed:m::reddit:OpenAI']);
    expect(recommend(one, SITE, elsewhere).primary!.venue).toBe('hn');
    /* A row on the venue it does route to sends it on to the next one. */
    const here = new Set(['a:model_removed:m::hn']);
    expect(recommend(one, SITE, here).primary!.venue).toBe('bluesky');
  });

  /** A row written before venues existed must not start claiming a subreddit. */
  it('reads a venue-less ledger row as the bare platform it was', () => {
    const rows: PostedRow[] = [{
      id: 'x', platform: 'reddit', entities: [], posted_at: '2026-01-01T00:00:00.000Z', permalink: null, via: 'human',
    }];
    const ids = postedIds(rows);
    expect(ids.has('x::reddit')).toBe(true);
    expect(ids.has('x::reddit:LocalLLaMA')).toBe(false);
  });

  /**
   * CHECKS THE TABLE, NOT THE OUTPUT, and that distinction is the whole test.
   * The first version walked venuesFor's results, which could never fail:
   * venuesFor skipped an id it could not resolve, so the filter hid the bug
   * from the only test looking for it, and a route pointing at
   * `reddit:DoesNotExist` stayed green through 42 tests. venuesFor now throws,
   * and this reads the ids straight out of the routing table.
   */
  it('routes only to venues that exist', () => {
    for (const id of allRoutedVenueIds()) {
      expect(VENUES[id], `route names ${id}, which is not in VENUES`).toBeDefined();
    }
  });

  it('gives every venue a label and a stated fit', () => {
    for (const v of Object.values(VENUES)) {
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.fit.length).toBeGreaterThan(0);
      expect(v.id).toBeTruthy();
    }
  });

  /** Positive control: the check above must actually fire on a bad id. */
  it('refuses a route naming a venue that does not exist', () => {
    const table = ROUTE_TABLE as unknown as Record<string, readonly { id: string; why: string }[]>;
    const saved = table['codename_entered'];
    try {
      table['codename_entered'] = [{ id: 'reddit:DoesNotExist', why: 'nowhere' }];
      expect(() => venuesFor(item({ type: 'codename_entered', id: 'a:codename_entered:k' })))
        .toThrow(/not a venue in VENUES/);
    } finally {
      table['codename_entered'] = saved!;
    }
  });

  /**
   * The defect that moved `why` off the venue and onto the pairing: the desk
   * told a reader a merged vLLM pull request mattered because it was "an
   * unreleased model sighting", which was r/LocalLLaMA's own blurb reused for a
   * route it does not describe. Two types sharing a venue must not share a
   * reason.
   */
  it('explains the pairing, not the venue', () => {
    const pr = recommend(item({ type: 'upstream_pr_merged', id: 'a:upstream_pr_merged:p', sentence: 'Short.' }), SITE);
    const code = recommend(item({ type: 'codename_unmasked', id: 'a:codename_unmasked:k', sentence: 'Short.' }), SITE);
    expect(pr.primary!.venue).toBe(code.primary!.venue);
    expect(pr.why).not.toBe(code.why);
    expect(pr.why).toContain('merge');
    expect(code.why).toContain('unreleased model');
  });

  it('states a reason for every routed step', () => {
    for (const [type, steps] of Object.entries(ROUTE_TABLE)) {
      for (const step of steps) {
        expect(step.why.length, `${type} -> ${step.id} has no reason`).toBeGreaterThan(20);
      }
    }
  });

  /**
   * `others` is the fallback list, so it must not repeat the button already
   * shown. A mutation duplicating the whole menu into it stayed green.
   */
  it('keeps the primary out of the alternatives', () => {
    const r = recommend(item({ type: 'codename_unmasked', id: 'a:codename_unmasked:k', sentence: 'Short.' }), SITE);
    expect(r.others.length).toBeGreaterThan(0);
    expect(r.others.map((d) => d.venue)).not.toContain(r.primary!.venue);
  });

  /** r/MachineLearning removes this material. Sending it there earns a strike. */
  it('never routes to a venue that would remove the post', () => {
    const ids = Object.keys(VENUES).join(' ');
    expect(ids).not.toContain('MachineLearning');
  });
});

describe('flair: kept on the venue table for the day Reddit comes back', () => {
  /**
   * Reddit is retired from routing, so no recommendation carries a flair any
   * more and the three tests that asserted one through recommend() went with
   * it. What still has to hold is the data: every subreddit in the table is
   * marked as refusing a post without a flair, because that is the fact that
   * stopped the first real post, and it will be just as true on the day the
   * account has enough standing to post there again.
   */
  it('marks every subreddit as needing a flair, and nothing else', () => {
    for (const v of Object.values(VENUES)) {
      expect(v.needsFlair, v.id).toBe(v.platform === 'reddit');
    }
  });

  it('asks for no flair where the venue has no such concept', () => {
    const r = recommend(item({ type: 'codename_entered', id: 'a:codename_entered:k', sentence: 'Short.' }), SITE);
    expect(r.primary!.venue).toBe('bluesky');
    expect(r.needsFlair).toBe(false);
    expect(r.flair).toBeNull();
  });
});

describe('a correction actually retracts the claim', () => {
  const one = item({ type: 'model_removed', id: 's:model_removed:a', sentence: 'Short.' });
  const posted: PostedRow[] = [{
    id: 's:model_removed:a', platform: 'hn', venue: 'hn', entities: [],
    posted_at: '2026-09-01T00:00:00.000Z', permalink: null, via: 'human',
  }];
  const correction = [{ ledger: 'meta/posted.jsonl', concerns: 's:model_removed:a' }];
  /* The fixture's stamp, so staleness charges nothing and the floor is the
     only gate under test. A day later and the item drops under floor 0 on its
     own, which reads as "the correction did nothing" and is not that at all. */
  const now = new Date('2026-09-02T00:00:00.000Z');

  /**
   * THE WHOLE INCIDENT IN ONE TEST. Two rows claimed posts that never happened,
   * both were corrected the append-only way this archive requires, and the
   * queue kept suppressing those items regardless, because the code deciding
   * what to offer read the claim and never the correction. Being wrong had made
   * the rows permanent.
   */
  it('offers an item again once its posting claim is corrected', () => {
    const suppressed = buildQueue([one], posted, now, SITE, 0);
    expect(suppressed.candidates[0]!.route.primary!.venue).not.toBe('hn');

    const restored = buildQueue([one], posted, now, SITE, 0, 5, correction);
    expect(restored.candidates[0]!.route.primary!.venue).toBe('hn');
  });

  /** A correction about a different ledger must not touch posting. */
  it('ignores a correction aimed at another ledger', () => {
    const elsewhere = [{ ledger: 'meta/leaks-ledger.jsonl', concerns: 's:model_removed:a' }];
    const q = buildQueue([one], posted, now, SITE, 0, 5, elsewhere);
    expect(q.candidates[0]!.route.primary!.venue).not.toBe('hn');
  });

  it('leaves an uncorrected item suppressed', () => {
    const other = [{ ledger: 'meta/posted.jsonl', concerns: 'a-different-item' }];
    const q = buildQueue([one], posted, now, SITE, 0, 5, other);
    expect(q.candidates[0]!.route.primary!.venue).not.toBe('hn');
  });

  it('reads the corrections file this repository actually ships', () => {
    const rows = parseCorrections(fs.readFileSync(path.resolve('meta/corrections.jsonl'), 'utf8'));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.ledger).toBeTruthy();
    /* Both of today's corrections concern the posting ledger. */
    expect(correctedIds(rows).size).toBe(rows.filter((r) => r.ledger === 'meta/posted.jsonl').length);
  });
});

describe('a venue this account cannot post to is not offered', () => {
  const blocked = new Set(['hn']);

  /**
   * The first real post this desk produced was removed within seconds by
   * automod, for the account being under r/LocalLLaMA's five comment karma
   * minimum. Continuing to offer that button does not merely waste the item: it
   * teaches that subreddit's spam tooling that diffwire.dev arrives from an
   * account which cannot post.
   */
  it('falls through to the next venue rather than offering a locked one', () => {
    const one = item({ type: 'codename_unmasked', id: 'a:codename_unmasked:k', sentence: 'Short.' });
    expect(recommend(one, SITE).primary!.venue).toBe('hn');
    expect(recommend(one, SITE, new Set(), blocked).primary!.venue).toBe('bluesky');
  });

  it('keeps a locked venue out of the alternatives too', () => {
    const one = item({ type: 'codename_unmasked', id: 'a:codename_unmasked:k', sentence: 'Short.' });
    const r = recommend(one, SITE, new Set(), blocked);
    expect([r.primary!.venue, ...r.others.map((o) => o.venue)]).not.toContain('hn');
  });

  /**
   * The honest outcome, and the one worth surfacing rather than hiding: with
   * r/LocalLLaMA locked, a merged inference-engine pull request routes only to
   * Hacker News, whose 80 character title limit its sentence cannot meet. The
   * highest-scoring item in the archive has nowhere to go, and the desk says so
   * instead of quietly dropping it.
   */
  it('distinguishes "locked out" from "nothing routed"', () => {
    const pr = item({ type: 'upstream_pr_merged', id: 'a:upstream_pr_merged:p', sentence: 'x'.repeat(150) });
    const r = recommend(pr, SITE, new Set(), blocked);
    expect(r.primary).toBeNull();
    /* Its only venue is locked, so the message names the venue and the cause. */
    expect(r.blocked).toContain('Hacker News');
    expect(r.blocked).toContain('cannot post');

    const nothing = recommend(item({ type: 'price_changed', id: 'a:price_changed:m', sentence: 'Short.' }), SITE);
    expect(nothing.blocked).toContain('no venue is routed');
  });

  it('reads the access file this repository ships', () => {
    const access = JSON.parse(fs.readFileSync(path.resolve('meta/venue-access.json'), 'utf8'));
    const ids = blockedVenueIds(access);
    expect(ids.has('reddit:LocalLLaMA')).toBe(true);
    /* Every blocked id must be a real venue, or it silently blocks nothing. */
    for (const id of ids) expect(VENUES[id], `${id} is not a venue`).toBeDefined();
    /* And every entry must say what would clear it, so it can be deleted. */
    for (const id of ids) {
      expect(access.blocked[id].why, id).toBeTruthy();
      expect(access.blocked[id].clears_when, id).toBeTruthy();
    }
  });

  it('blocks nothing when there is no access file', () => {
    expect(blockedVenueIds(null).size).toBe(0);
  });
});

describe('a title composed from the event, never from a rewrite', () => {
  const leak = (type: FeedType, facts: [string, string][], over: Partial<FeedItem> = {}) =>
    item({ type, id: `s:${type}:x`, kind: 'leak', facts, sentence: 'x'.repeat(150), ...over } as never);

  it('composes the codename resolution from its two facts', () => {
    const t = hnTitle(leak('codename_unmasked', [['publicName', 'kiana'], ['displayName before', 'kiana'], ['displayName after', 'qwen3.8-max-0902']]));
    expect(t).toEqual({ text: 'Arena codename "kiana" resolves to qwen3.8-max-0902', by: 'template' });
  });

  it('composes the merged pull request from repository and architecture', () => {
    const t = hnTitle(leak('upstream_pr_merged', [['repository', 'vllm-project/vllm'], ['architecture named in the title', 'DeepSeek-V4-Flash-Vision-Exp']]));
    expect(t!.text).toBe('vllm merges DeepSeek-V4-Flash-Vision-Exp support');
  });

  /**
   * THE COPY RULE, AS A PROPERTY. Every word of a composed title is either a
   * value copied from the item, or a connective word from the closed vocabulary
   * below. Nothing else is permitted, and the vocabulary is the complete list
   * of words the templates may supply, so adding a template that paraphrases
   * ("DeepSeek V4" for "DeepSeek-V4-Flash-Vision-Exp") or that quietly editorialises
   * ("major", "surprise") breaks the suite by name.
   *
   * THE FIRST VERSION OF THIS TEST WAS VACUOUS. It checked only tokens that
   * contained a digit, a dash or a slash, on the theory that those were the
   * "value-bearing" ones, and so it would have passed a title that inserted
   * any plain word at all. It was caught when a catalogue name was added to a
   * template and the test stayed green when it should have gone red. The
   * closed-vocabulary form cannot have that hole: an unlisted word fails.
   */
  const TEMPLATE_WORDS = new Set([
    /* connectives */ 'to', 'on', 'in', 'the', 'for', 'sets', 'adds', 'added', 'removed',
    'from', 'merges', 'support', 'proposed', 'resolves', 'appears', 'listed', 'new',
    'catalogue', 'codename', 'leaderboard', 'status', 'retirement', 'unannounced', 'model',
    /* the arena's own name, from the source id arena-leaderboard */ 'arena', 'arena.ai',
    /* catalogue names: each is the vendor's name for itself, mapped from OUR source id */
    'openrouter', 'groq', 'together', 'mistral', 'xai', 'openai', 'anthropic', 'perplexity',
  ]);

  it('puts nothing in a title that is not in the item or the template vocabulary', () => {
    const cases: FeedItem[] = [
      leak('codename_unmasked', [['publicName', 'kiana'], ['displayName after', 'qwen3.8-max-0902']]),
      leak('codename_entered', [['publicName', 'korin']]),
      leak('upstream_pr_merged', [['repository', 'vllm-project/vllm'], ['architecture named in the title', 'Bailing V3 VL']]),
      leak('upstream_pr_opened', [['repository', 'vllm-project/vllm'], ['architecture named in the title', 'Foo-2']]),
      leak('stealth_listing', [['catalog id', 'stealth/union-alpha']], { sourceId: 'openrouter-models' }),
      item({ type: 'model_added', id: 's:model_added:m', sourceId: 'groq-llms-full-txt', sentence: 'x'.repeat(150),
        event: { type: 'model_added', modelId: 'llama-9-70b', created: null, precisionSeconds: 0 } as never }),
      item({ type: 'model_removed', id: 's:model_removed:m', sourceId: 'unmapped-source', sentence: 'x'.repeat(150),
        event: { type: 'model_removed', modelId: 'llama-9-70b', lastSeen: null } as never }),
      item({ type: 'retirement_floor', id: 's:retirement_floor:m', sentence: 'x'.repeat(150),
        event: { type: 'retirement_floor', provider: 'openai', model: 'gpt-4o', floorDate: '2026-12-01', floorText: '' } as never }),
      item({ type: 'incident_opened', id: 's:incident_opened:i', sentence: 'x'.repeat(150),
        event: { type: 'incident_opened', provider: 'openai', title: 'Elevated errors', url: 'https://x', published: null } as never }),
    ];
    for (const c of cases) {
      const t = hnTitle(c);
      expect(t, c.type).not.toBeNull();
      const pool = [
        ...c.facts.map(([, v]) => v),
        c.sourceId,
        ...Object.values((c.event ?? {}) as Record<string, unknown>).filter((v): v is string => typeof v === 'string'),
      ].join('\n');
      /* Quoted spans are one value each; everything else splits on spaces. */
      const spans = t!.text.match(/"[^"]+"|\S+/g) ?? [];
      for (const span of spans) {
        const bare = span.replace(/^"|"$/g, '').replace(/[.,:]$/, '');
        const inItem = pool.includes(bare);
        const inVocab = TEMPLATE_WORDS.has(bare.toLowerCase());
        expect(inItem || inVocab, `${c.type}: "${bare}" is neither in the item nor in the template vocabulary`).toBe(true);
      }
    }
  });

  /** The catalogue name is a mapping from OUR id to the vendor's name; an id it does not know is left as-is, never guessed. */
  it('leaves an unmapped source id alone rather than inventing a name', () => {
    const t = hnTitle(item({ type: 'model_removed', id: 's:model_removed:m', sourceId: 'unmapped-source', sentence: 'x'.repeat(150),
      event: { type: 'model_removed', modelId: 'm-1', lastSeen: null } as never }));
    expect(t!.text).toContain('unmapped-source');
  });

  /** The 10.1-bit case, exactly as it happened, must now reach Hacker News. */
  it('composes the first stealth listing to fit, where the raw source id did not', () => {
    const t = hnTitle(leak('stealth_listing', [['catalog id', 'stealth/union-alpha']], { sourceId: 'openrouter-models' }));
    expect(t).toEqual({ text: 'Unannounced model "stealth/union-alpha" listed on OpenRouter', by: 'template' });
    expect(t!.text.length).toBeLessThanOrEqual(80);
  });

  it('refuses rather than truncates when the filled template is too long', () => {
    const t = hnTitle(leak('upstream_pr_merged', [['repository', 'vllm-project/vllm'], ['architecture named in the title', 'A'.repeat(90)]]));
    expect(t).toBeNull();
  });

  it('refuses when a required fact is missing', () => {
    expect(hnTitle(leak('codename_unmasked', [['publicName', 'kiana']]))).toBeNull();
    expect(hnTitle(leak('codename_unmasked', [['publicName', 'k'], ['displayName after', 'absent']]))).toBeNull();
  });

  it('has no template for archive telemetry', () => {
    expect(hnTitle(item({ type: 'price_changed' as FeedType, id: 's:price_changed:m' }))).toBeNull();
  });

  /** The drafter prefers the sentence when it fits, and says so. */
  it('keeps the sentence as the title when it fits, marked as such', () => {
    const d = draftFor(item({ type: 'codename_unmasked', id: 'a:codename_unmasked:k', sentence: 'Short.' }), PLATFORMS.find((p) => p.id === 'hn')!, SITE, 'hn');
    expect('need' in d).toBe(false);
    expect((d as Draft).title).toBe('Short.');
    expect((d as Draft).titleBy).toBe('sentence');
  });

  it('falls back to the composed title only when the sentence overflows, marked as such', () => {
    const d = draftFor(leak('codename_unmasked', [['publicName', 'kiana'], ['displayName after', 'qwen3.8-max-0902']]), PLATFORMS.find((p) => p.id === 'hn')!, SITE, 'hn');
    expect('need' in d).toBe(false);
    expect((d as Draft).title).toBe('Arena codename "kiana" resolves to qwen3.8-max-0902');
    expect((d as Draft).titleBy).toBe('template');
    expect((d as Draft).submitUrl).toContain(encodeURIComponent('Arena codename "kiana" resolves to qwen3.8-max-0902'));
  });

  it('still asks a person when neither the sentence nor a template fits', () => {
    const d = draftFor(leak('codename_unmasked', [['publicName', 'k'.repeat(60)], ['displayName after', 'v'.repeat(60)]]), PLATFORMS.find((p) => p.id === 'hn')!, SITE, 'hn');
    expect('need' in d).toBe(true);
  });
});

describe('reddit is retired and HN is capped', () => {
  it('routes no type to any subreddit', () => {
    for (const type of Object.keys(ROUTE_TABLE)) {
      for (const v of venuesFor(item({ type: type as FeedType, id: `s:${type}:x`, sourceId: 'claude-status' }))) {
        expect(v.id, `${type} still routes to ${v.id}`).not.toMatch(/^reddit:/);
      }
    }
  });

  /**
   * Three HN-worthy items, the two best keep the HN button, the third is sent
   * on to the next venue on its route. In score order, so the cap always spends
   * itself on the most surprising items.
   */
  it('lets only the two highest-scoring candidates keep Hacker News', () => {
    const three = [
      leakItem('a', 'r1', 'qwen-1'), leakItem('b', 'r2', 'qwen-2'), leakItem('c', 'r3', 'qwen-3'),
    ];
    const q = buildQueue(three, [], new Date('2026-09-02T00:00:00.000Z'), SITE, 0);
    const venues = q.candidates.map((c) => c.route.primary?.venue);
    expect(venues.filter((v) => v === 'hn')).toHaveLength(HN_PER_DAY);
    expect(venues[2]).toBe('bluesky');
  });

  function leakItem(sfx: string, name: string, to: string): FeedItem {
    return item({ type: 'codename_unmasked', id: `s${sfx}:codename_unmasked:${name}`, kind: 'leak',
      sentence: 'x'.repeat(150), facts: [['publicName', name], ['displayName after', to]] } as never);
  }
});

describe('arena moved to a React Server Components payload', () => {
  /**
   * WHAT HAPPENED. arena.ai stopped embedding the leaderboard as a 5.2 MB
   * payload keyed on `publicName` and began streaming a 773 KB RSC payload
   * keyed on `modelKey`. The predicate always read both spellings and kept
   * working. `arenaCodenameMap` read `publicName` alone, so it went to zero,
   * the collapse guard correctly refused every comparison rather than
   * reporting a thousand false entries, and the leaks desk went quiet for two
   * days while 44 live reveals sat unread in the payload.
   *
   * The fixture is a real slice of the live page, not a hand-written shape.
   */
  const rsc = fs.readFileSync(path.resolve('test/fixtures/arena-rsc-slice.html'), 'utf8');

  /**
   * The rule is chosen PER CAPTURE. Derivations are recomputed from history on
   * every build, so switching globally would re-read every stored capture of
   * the old shape with the new rule and silently change what this site has
   * already published about past changes: that body's map goes 86 -> 664.
   */
  it('still reads an old-shape capture exactly as it always did', () => {
    const old = String.raw`{\"publicName\":\"cold_brew\",\"displayName\":\"muse-video\"}` +
      String.raw`{\"modelKey\":\"gpt-5\",\"modelDisplayName\":\"GPT-5\"}`;
    const m = arenaCodenameMap(old);
    expect(m.get('cold_brew')).toBe('muse-video');
    expect(m.has('gpt-5'), 'a leaderboard row must not be filed as a picker pair').toBe(false);
  });

  it('reads rows the old publicName-only keying could not see', () => {
    expect(arenaRows(rsc, 'publicName')).toHaveLength(0);
    expect(arenaRows(rsc).length).toBeGreaterThan(100);
  });

  it('builds a codename map from the new keying', () => {
    expect(arenaCodenameMap(rsc).size).toBeGreaterThan(100);
  });

  /**
   * The floor has to sit UNDER the healthy live value or the guard can never
   * pass, which is an outage with a comment rather than a guard. It also has to
   * sit far above the 1 record a picker collapse produces.
   */
  it('keeps a floor the healthy payload can clear', () => {
    expect(ARENA_CODENAME_FLOOR).toBeLessThan(360);
    expect(ARENA_CODENAME_FLOOR).toBeGreaterThan(100);
  });

  it('refuses a collapsed payload', () => {
    expect(arenaCodenameMap('{"modelKey":"only-one","displayName":"Only One"}').size)
      .toBeLessThan(ARENA_CODENAME_FLOOR);
  });

  /**
   * The contenders/ prefix the new payload adds must NOT manufacture reveals:
   * isLabelVariant matches on a shared identity token, and the prefixed key
   * shares its base name with the display string.
   */
  it('does not read the contenders/ prefix as a reveal', () => {
    expect(isCodenameReveal('contenders/inkling-small', 'Inkling Small')).toBe(false);
    expect(isCodenameReveal('contenders/mistral-medium-3.5-v2-agent', 'Mistral Medium 3.5')).toBe(false);
  });

  /** And a genuine reveal in the new payload still reads as one. */
  it('still finds a real reveal in the new shape', () => {
    expect(isCodenameReveal('kivine-wxzc-agent', 'Kimi K3 (Max)')).toBe(true);
    expect(isCodenameReveal('paisley-n9x0', 'Qwen3.8 Max')).toBe(true);
  });
});

describe('the interrupt path beside the digest', () => {
  /**
   * WHY THIS EXISTS, measured rather than felt. The first stealth listing this
   * archive ever recorded was captured 2026-09-16 15:06 UTC, eighteen minutes
   * before the first person posted it to Hacker News, and the desk showed it
   * twenty-one hours later. The collection layer was ahead of the world and the
   * distribution layer gave the lead away. A digest is right for a price
   * change; it is wrong for the one kind of item this site exists to break.
   */
  const cand = (bits: number, id: string): Candidate =>
    ({ item: item({ type: 'stealth_listing', id, sentence: 'Short.' }), score: { bits, components: [] },
       route: { primary: null, why: null, flair: null, needsFlair: false, others: [], shortfalls: [], blocked: null },
       entities: [] }) as unknown as Candidate;

  const none: AlertState = { alerted: [] };

  it('stays silent for an ordinary day', () => {
    expect(alertable([cand(5.9, 'a'), cand(4.8, 'b')], none)).toEqual([]);
  });

  it('fires for an item far enough above the floor', () => {
    expect(alertable([cand(10.11, 'a'), cand(5.9, 'b')], none).map((c) => c.item.id)).toEqual(['a']);
  });

  /** Exactly at the floor counts, or the number means something other than it says. */
  it('treats the floor as inclusive', () => {
    expect(alertable([cand(ALERT_FLOOR_BITS, 'a')], none)).toHaveLength(1);
    expect(alertable([cand(ALERT_FLOOR_BITS - 0.01, 'a')], none)).toHaveLength(0);
  });

  /** The property that stops it becoming a second digest. */
  it('never wakes anyone twice for the same item', () => {
    const sent = nextAlertState(none, alertable([cand(10, 'a')], none));
    expect(sent.alerted).toEqual(['a']);
    expect(alertable([cand(10, 'a')], sent)).toEqual([]);
  });

  it('still fires for a different item once one has been sent', () => {
    const sent = nextAlertState(none, [cand(10, 'a')]);
    expect(alertable([cand(10, 'a'), cand(9, 'b')], sent).map((c) => c.item.id)).toEqual(['b']);
  });

  /**
   * The state is force-pushed to a branch every two hours, so an unbounded list
   * would grow for ever. The cap is years of history at one or two alerts a
   * week, and forgetting an id that old costs at worst one duplicate mail about
   * a story the staleness penalty has long since pushed under the floor.
   */
  it('keeps the memory bounded, newest kept', () => {
    const many: AlertState = { alerted: Array.from({ length: ALERT_MEMORY + 10 }, (_, i) => `old-${i}`) };
    const next = nextAlertState(many, [cand(10, 'fresh')]);
    expect(next.alerted).toHaveLength(ALERT_MEMORY);
    expect(next.alerted.at(-1)).toBe('fresh');
    expect(next.alerted).not.toContain('old-0');
  });

  it('reads a missing or malformed state as nothing sent, rather than throwing', () => {
    expect(parseAlertState('{}').alerted).toEqual([]);
    expect(parseAlertState('{"alerted":null}').alerted).toEqual([]);
    expect(parseAlertState('{"alerted":["a",7,"b"]}').alerted).toEqual(['a', 'b']);
  });
});

describe('reveals standing in a baseline capture', () => {
  /**
   * THE 51 THAT WOULD HAVE BEEN LOST. When arena changed payload shape the
   * replacement source's first capture was a baseline, and rule 2 bars a
   * baseline from every CHANGE claim. The bytes were archived and nothing was
   * ever published from them.
   *
   * A pairing is not a change claim. "The payload records X beside Y" reads
   * two values out of the vendor's own bytes and asserts nothing about when
   * they were put there, which is the same reasoning src/derive/events.ts
   * already uses to let retirement floors through a baseline.
   */
  /*
   * A DOCUMENT BUILT TO CLEAR THE COLLAPSE FLOOR, because the real fixture
   * slice holds fewer than 250 distinct names and is correctly refused by it.
   * The filler pairs each name with itself, so they count toward the floor and
   * are not reveals, and the three real spellings of one codename are taken
   * verbatim from the live payload so the dedupe is exercised on arena's own
   * shape rather than on an invented one.
   */
  const row = (k: string, d: string) => String.raw`{\"modelKey\":\"${k}\",\"modelDisplayName\":\"${d}\"}`;
  const filler = Array.from({ length: 300 }, (_, i) => row(`filler-${i}`, `filler-${i}`)).join('');
  const rsc = filler +
    row('kivine-wxzc', 'kimi-k3-max') +
    row('kivine-wxzc-agent', 'Kimi K3 (Max)') +
    row('contenders/kivine-wxzc-agent', 'Kimi K3 (Max)') +
    row('paisley-n9x0', 'Qwen3.8 Max') +
    row('contenders/paisley-n9x0', 'Qwen3.8 Max');
  const baseline = {
    kind: 'added', sourceId: 'arena-leaderboard-rsc', path: 'raw/arena-leaderboard-rsc/response.html',
    sha: 'a'.repeat(40), before: null, after: rsc,
    stamp: { iso: '2026-09-26T05:00:00.000Z', kind: 'observed' },
  } as never;

  it('publishes the reveals a baseline holds', () => {
    const items = leaksFromChange(baseline).filter((i) => i.type === 'codename_standing');
    /* Two codenames in five reveal rows: the filler is not a reveal. */
    expect(items.map((i) => i.subject).sort()).toEqual(['kivine-wxzc', 'paisley-n9x0']);
  });

  /** One finding per codename, however many rows the payload spends on it. */
  it('collapses the three spellings of one codename into one item', () => {
    const subjects = leaksFromChange(baseline)
      .filter((i) => i.type === 'codename_standing').map((i) => i.subject);
    expect(new Set(subjects).size).toBe(subjects.length);
    for (const s of subjects) {
      expect(s.startsWith('contenders/'), `${s} kept its prefix`).toBe(false);
      expect(s.endsWith('-agent'), `${s} kept its mode suffix`).toBe(false);
    }
  });

  /**
   * THE SENTENCE MAY NOT CLAIM TIMING. That is the whole basis on which a
   * baseline is allowed to say anything at all, so it is asserted on the words
   * rather than trusted to the comment above the function.
   */
  it('says what the payload records, never that anything changed', () => {
    const item = leaksFromChange(baseline).find((i) => i.type === 'codename_standing')!;
    const sentence = leakSentence(item);
    expect(sentence).toContain('records the modelKey');
    for (const banned of ['changed', 'no longer', 'entered', 'became', 'now ']) {
      expect(sentence.toLowerCase(), `"${banned}" is a timing claim`).not.toContain(banned);
    }
  });

  /** Every value in the sentence is read out of the item's own facts. */
  it('puts nothing in the sentence that is not in the facts', () => {
    const item = leaksFromChange(baseline).find((i) => i.type === 'codename_standing')!;
    const sentence = leakSentence(item);
    expect(sentence).toContain(item.facts.find((f) => f[0] === 'modelKey')![1]);
    expect(sentence).toContain(item.facts.find((f) => f[0] === 'displayName')![1]);
  });

  /** A collapsed baseline has no previous capture to prove it is merely small. */
  it('refuses a baseline below the collapse floor', () => {
    const tiny = { ...(baseline as Record<string, unknown>), after: row('x-1', 'Some Model') } as never;
    expect(leaksFromChange(tiny)).toEqual([]);
  });
});
