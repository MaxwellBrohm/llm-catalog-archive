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
import { draftFor, draftsFor, PLATFORMS, changeUrl } from '../src/desk/drafts.js';
import { buildQueue, cooldownKeys } from '../src/desk/queue.js';
import { recommend } from '../src/desk/route.js';
import { VENUES, venuesFor, allRoutedVenueIds, ROUTE_TABLE } from '../src/desk/venues.js';
import { ALL_TYPES } from '../src/derive/feed.js';
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
    expect(q.candidates[0]!.route.primary!.venue).toBe('reddit:LocalLLaMA');
    expect(q.candidates[0]!.route.why).toBeTruthy();
  });

  it('falls through to the next venue once the first has had it', () => {
    const one = item({ type: 'model_removed', id: 's:model_removed:a', sentence: 'Short.' });
    const posted: PostedRow[] = [{
      id: 's:model_removed:a', platform: 'reddit', venue: 'reddit:LocalLLaMA', entities: [],
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
    expect(r.primary!.venue).toBe('reddit:LocalLLaMA');
    expect(r.why).toContain('codename');
    expect(r.blocked).toBeNull();
  });

  /**
   * A subreddit is the address, not a preference. Reddit's bare /submit lands a
   * person on a chooser, and the choice is the part that decides whether a post
   * survives the hour, so the link must carry the sub.
   */
  it('addresses a Reddit draft at the subreddit, not at reddit.com', () => {
    const r = recommend(item({ type: 'codename_unmasked', id: 'a:codename_unmasked:k', sentence: 'Short.' }), SITE);
    expect(r.primary!.submitUrl).toContain('/r/LocalLLaMA/submit?');
    expect(r.primary!.label).toBe('r/LocalLLaMA');
  });

  /**
   * A migration someone has to perform goes where the people who have to
   * perform it are, ahead of where the most people are. The lab is read off the
   * source id when the event carries no lab entity, which is the usual case for
   * the deprecations and status feeds.
   */
  it('sends an OpenAI retirement to r/OpenAI, not to the generic sub', () => {
    const r = recommend(
      item({ type: 'retirement_floor', id: 'a:retirement_floor:m', sentence: 'Short.', sourceId: 'openai-deprecations' }),
      SITE,
    );
    expect(r.primary!.venue).toBe('reddit:OpenAI');
  });

  it('sends an Anthropic incident to r/ClaudeAI', () => {
    const r = recommend(
      item({ type: 'incident_opened', id: 'a:incident_opened:i', sentence: 'Short.', sourceId: 'claude-status' }),
      SITE,
    );
    expect(r.primary!.venue).toBe('reddit:ClaudeAI');
  });

  /** No known vendor sub must fall through to a real audience, never vanish. */
  it('falls back to a named venue when the lab has no sub of its own', () => {
    const r = recommend(
      item({ type: 'model_removed', id: 'a:model_removed:m', sentence: 'Short.', sourceId: 'groq-llms-full-txt' }),
      SITE,
    );
    expect(r.primary!.venue).toBe('reddit:LocalLLaMA');
  });

  /**
   * HN's 80 character title limit against 150 character sentences is why the
   * routing must fall THROUGH rather than offer a button that cannot be
   * pressed. upstream_pr_merged routes to LocalLLaMA then HN, so a sentence too
   * long for HN still leaves one venue and a recorded shortfall.
   */
  it('drops a venue the sentence cannot fit and keeps going', () => {
    const long = 'x'.repeat(150);
    const r = recommend(item({ type: 'upstream_pr_merged', id: 'a:upstream_pr_merged:p', sentence: long }), SITE);
    expect(r.primary!.venue).toBe('reddit:LocalLLaMA');
    expect(r.shortfalls.map((s) => s.venue)).toEqual(['hn']);
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
  it('treats two subreddits as two places', () => {
    const one = item({ type: 'model_removed', id: 'a:model_removed:m', sentence: 'Short.', sourceId: 'openai-deprecations' });
    const posted = new Set(['a:model_removed:m::reddit:OpenAI']);
    expect(recommend(one, SITE, posted).primary!.venue).toBe('reddit:LocalLLaMA');
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
    expect(pr.why).toContain('inference-engine');
    expect(code.why).toContain('codename');
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

describe('flair: the part of "where" that stops a post going through', () => {
  /**
   * r/LocalLLaMA refuses a submission with no flair set, and "No flair" is not
   * an answer it accepts, which is where the routing actually stopped the first
   * time it met a real subreddit. It cannot be prefilled: Reddit's submit URL
   * takes a flair_id UUID that only an authenticated call can supply, and
   * reddit.com is unreachable from this repository. Naming it is the most the
   * desk can honestly do, so it must at least do that.
   */
  it('names a flair wherever the venue refuses a post without one', () => {
    const r = recommend(item({ type: 'codename_unmasked', id: 'a:codename_unmasked:k', sentence: 'Short.' }), SITE);
    expect(r.needsFlair).toBe(true);
    expect(r.flair).toContain('Discussion');
  });

  /**
   * A preference list, not one value, because the sub's flair set is not
   * visible from here and does change: pick the first that is actually on the
   * form.
   */
  it('offers flairs in preference order', () => {
    const r = recommend(item({ type: 'model_added', id: 'a:model_added:m', sentence: 'Short.', sourceId: 'groq-llms-full-txt' }), SITE);
    expect(r.flair![0]).toBe('New Model');
    expect(r.flair![r.flair!.length - 1]).toBe('Discussion');
  });

  /**
   * Never invent one. A wrong flair is a removed post, and the flair sets of
   * r/OpenAI and r/ClaudeAI have not been seen from here.
   */
  it('says the flair is unknown rather than guessing at a vendor sub', () => {
    const r = recommend(item({ type: 'incident_opened', id: 'a:incident_opened:i', sentence: 'Short.', sourceId: 'claude-status' }), SITE);
    expect(r.primary!.venue).toBe('reddit:ClaudeAI');
    expect(r.needsFlair).toBe(true);
    expect(r.flair).toBeNull();
  });

  it('asks for no flair where the venue has no such concept', () => {
    const r = recommend(item({ type: 'codename_entered', id: 'a:codename_entered:k', sentence: 'Short.' }),
      SITE, new Set(['a:codename_entered:k::reddit:LocalLLaMA']));
    expect(r.primary!.venue).toBe('bluesky');
    expect(r.needsFlair).toBe(false);
  });

  /** Every venue that needs a flair must be reachable by some route. */
  it('marks every subreddit as needing a flair', () => {
    for (const v of Object.values(VENUES)) {
      expect(v.needsFlair, `${v.id}`).toBe(v.platform === 'reddit');
    }
  });
});
