import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { checkHealth, countFeedItems, newestFeedDate, xmlRootElement } from '../src/health.js';
import { loadSources } from '../src/config.js';
import type { Observed } from '../src/types.js';
import type { Source } from '../src/config.js';

const fxBytes = (n: string) => new Uint8Array(fs.readFileSync(`test/fixtures/${n}`));
const fxText = (n: string) => fs.readFileSync(`test/fixtures/${n}`, 'utf8');
const enc = (s: string) => new TextEncoder().encode(s);

function src(over: Partial<Source> = {}): Source {
  return {
    id: 'x',
    url: 'https://example.com/f',
    tier: 'daily',
    status: 'active',
    path: 'raw/x/response.txt',
    contentType: 'text',
    expectedRoot: null,
    invariants: {
      minBytes: 1000,
      requiredKeyPath: null,
      minRecords: null,
      canary: '# Anthropic Developer Documentation',
      sizeBand: [0.5, 2.0],
    },
    freshness: { kind: 'none', maxQuietDays: null },
    predicate: { type: 'bytes' },
    timeoutS: 60,
    retries: 2,
    maxRedirects: 3,
    rateLimit: { maxAutoEventsPerDay: 8 },
    magnitudeGuard: { maxShrinkPct: 25 },
    notes: '',
    ...over,
  } as Source;
}

const obs = (body: Uint8Array, over: Partial<Observed> = {}): Observed => ({
  status: 200,
  body,
  finalUrl: 'https://example.com/f',
  redirectCount: 0,
  headers: {},
  ...over,
});

const NOW = Date.parse('2026-08-27T00:00:00Z');

/**
 * The healthy text fixture with something appended. Every interstitial test
 * below uses this, and `withSuffix('')` is asserted to be `ok`, so the marker
 * is provably the only reason those bodies are rejected.
 */
const withSuffix = (s: string) => enc(fxText('healthy-claude-llms.txt') + s);

/**
 * The fixtures' own premises. Two of these traps arrived as a 15-byte and a
 * 0-byte redirect stub during this task, and every test built on them would
 * have passed while proving nothing.
 */
describe('the fixtures still carry their traps', () => {
  it('the interstitial fixture still contains a cloudflare challenge marker', () => {
    expect(fxText('trap-interstitial.html').includes('__CF$cv$params')).toBe(true);
  });

  it('the cohere trap is still the full body and not a redirect stub', () => {
    expect(fxBytes('trap-cohere-xhtml.xml').byteLength).toBe(1024672);
  });

  it('the anthropic catch-all still returns the identical body for a nonsense path', () => {
    expect(fxText('trap-anthropic-catchall.html')).toBe(fxText('trap-anthropic-404path.html'));
  });

  it('the healthy text fixture does not itself contain a challenge marker', () => {
    expect(fxText('healthy-claude-llms.txt').includes('__CF$cv$params')).toBe(false);
  });
});

describe('checkHealth, a healthy response', () => {
  it('calls a healthy text source carrying its canary ok', () => {
    expect(checkHealth(src(), obs(fxBytes('healthy-claude-llms.txt')), { bytes: 63000 }, NOW).state).toBe('ok');
  });

  it('allows the write', () => {
    expect(checkHealth(src(), obs(fxBytes('healthy-claude-llms.txt')), { bytes: 63000 }, NOW).writeAllowed).toBe(true);
  });

  it('does not count a healthy response as a failure', () => {
    expect(checkHealth(src(), obs(fxBytes('healthy-claude-llms.txt')), { bytes: 63000 }, NOW).countsAsFailure).toBe(
      false,
    );
  });

  it('gives no reason when there is nothing wrong', () => {
    expect(checkHealth(src(), obs(fxBytes('healthy-claude-llms.txt')), { bytes: 63000 }, NOW).reason).toBeNull();
  });
});

describe('checkHealth, the status line', () => {
  it('fails a non-2xx', () => {
    expect(
      checkHealth(src(), obs(fxBytes('healthy-claude-llms.txt'), { status: 503 }), { bytes: 63000 }, NOW).state,
    ).toBe('failed');
  });

  it('refuses the write on a non-2xx', () => {
    expect(
      checkHealth(src(), obs(fxBytes('healthy-claude-llms.txt'), { status: 503 }), { bytes: 63000 }, NOW).writeAllowed,
    ).toBe(false);
  });

  it('counts a non-2xx as a failure', () => {
    expect(
      checkHealth(src(), obs(fxBytes('healthy-claude-llms.txt'), { status: 503 }), { bytes: 63000 }, NOW)
        .countsAsFailure,
    ).toBe(true);
  });

  it('names the status it rejected', () => {
    expect(checkHealth(src(), obs(fxBytes('healthy-claude-llms.txt'), { status: 503 }), { bytes: 63000 }, NOW).reason)
      .toBe('status 503');
  });

  // 3xx reaches here only when the fetch layer hands one up, which it does for
  // a 3xx that carried no Location. A redirect that relocates nowhere is not a
  // snapshot.
  it('fails a 304, which is a 3xx and not a body', () => {
    expect(
      checkHealth(src(), obs(fxBytes('healthy-claude-llms.txt'), { status: 304 }), { bytes: 63000 }, NOW).state,
    ).toBe('failed');
  });

  // Both edges of the 2xx window, because each is held by its own comparison
  // and a suite that only tests 503 and 299 leaves either one deletable.
  it('fails a 1xx, which is an interim response and not a body', () => {
    expect(
      checkHealth(src(), obs(fxBytes('healthy-claude-llms.txt'), { status: 199 }), { bytes: 63000 }, NOW).state,
    ).toBe('failed');
  });

  it('fails a 300, the first status outside the window', () => {
    expect(
      checkHealth(src(), obs(fxBytes('healthy-claude-llms.txt'), { status: 300 }), { bytes: 63000 }, NOW).state,
    ).toBe('failed');
  });

  it('accepts a 204-adjacent 2xx boundary at 299', () => {
    expect(
      checkHealth(src(), obs(fxBytes('healthy-claude-llms.txt'), { status: 299 }), { bytes: 63000 }, NOW).state,
    ).toBe('ok');
  });
});

/**
 * The trap that motivated the whole health section: a challenge page served at
 * 200. Every source below is configured so that the interstitial check is the
 * ONLY check that can reject the body, which is what makes these claims about
 * the denylist rather than about size or canaries.
 */
describe('checkHealth, the interstitial denylist', () => {
  // contentType html so no root or json check applies; the canary is a word
  // the page really contains; minBytes and the first-fetch band cannot fire.
  const neuron = () =>
    src({ contentType: 'html', invariants: { ...src().invariants, minBytes: 100, canary: 'Neuron' } });

  it('refuses to write a challenge page whose every other check passes', () => {
    expect(checkHealth(neuron(), obs(fxBytes('trap-interstitial.html')), { bytes: null }, NOW).writeAllowed).toBe(false);
  });

  it('names the marker it found', () => {
    expect(checkHealth(neuron(), obs(fxBytes('trap-interstitial.html')), { bytes: null }, NOW).reason).toBe(
      'interstitial marker present: __CF$cv$params',
    );
  });

  it('counts a challenge page as a failure', () => {
    expect(checkHealth(neuron(), obs(fxBytes('trap-interstitial.html')), { bytes: null }, NOW).countsAsFailure).toBe(
      true,
    );
  });

  // The challenge page carries the canary the neuron feed would have used, so
  // the canary check alone would have let it through. This is why the denylist
  // is checked independently instead of being folded into the canary.
  it('rejects it even though the body does carry the configured canary', () => {
    expect(fxText('trap-interstitial.html').includes('Neuron')).toBe(true);
  });

  // The base for the five per-marker tests. Without this the marker tests would
  // not prove the marker is what did it.
  it('accepts the carrier body when nothing is appended to it', () => {
    expect(checkHealth(src(), obs(withSuffix('')), { bytes: null }, NOW).state).toBe('ok');
  });

  it('rejects a body carrying __CF$cv$params', () => {
    expect(checkHealth(src(), obs(withSuffix('\n__CF$cv$params\n')), { bytes: null }, NOW).reason).toBe(
      'interstitial marker present: __CF$cv$params',
    );
  });

  it('rejects a body carrying cf-mitigated', () => {
    expect(checkHealth(src(), obs(withSuffix('\ncf-mitigated\n')), { bytes: null }, NOW).reason).toBe(
      'interstitial marker present: cf-mitigated',
    );
  });

  it('rejects a body carrying Just a moment', () => {
    expect(checkHealth(src(), obs(withSuffix('\n<title>Just a moment...</title>\n')), { bytes: null }, NOW).reason).toBe(
      'interstitial marker present: Just a moment',
    );
  });

  it('rejects a body carrying Enable JavaScript and cookies to continue', () => {
    expect(
      checkHealth(src(), obs(withSuffix('\nEnable JavaScript and cookies to continue\n')), { bytes: null }, NOW).reason,
    ).toBe('interstitial marker present: Enable JavaScript and cookies to continue');
  });

  it('rejects a body carrying Attention Required!', () => {
    expect(checkHealth(src(), obs(withSuffix('\nAttention Required! | Cloudflare\n')), { bytes: null }, NOW).reason).toBe(
      'interstitial marker present: Attention Required!',
    );
  });

  // The band would also have rejected this body, at a ratio of 58. The marker
  // must win, because "size ratio 58.112 outside band" is a true statement that
  // sends an operator to the wrong problem.
  it('reports the marker rather than the size when both would reject', () => {
    expect(checkHealth(neuron(), obs(fxBytes('trap-interstitial.html')), { bytes: 6000 }, NOW).reason).toBe(
      'interstitial marker present: __CF$cv$params',
    );
  });
});

describe('checkHealth, the canary', () => {
  const gone = () => src({ invariants: { ...src().invariants, canary: 'THIS STRING IS NOT PRESENT' } });

  it('fails a text source whose canary has vanished', () => {
    expect(checkHealth(gone(), obs(fxBytes('healthy-claude-llms.txt')), { bytes: 63000 }, NOW).state).toBe('failed');
  });

  it('quotes the canary it could not find', () => {
    expect(checkHealth(gone(), obs(fxBytes('healthy-claude-llms.txt')), { bytes: 63000 }, NOW).reason).toBe(
      'canary absent: "THIS STRING IS NOT PRESENT"',
    );
  });

  it('does not apply a canary check when the source declares none', () => {
    const s = src({ contentType: 'html', invariants: { ...src().invariants, canary: null } });
    expect(checkHealth(s, obs(fxBytes('trap-anthropic-catchall.html')), { bytes: null }, NOW).state).toBe('ok');
  });
});

describe('checkHealth, the size floor and the size band', () => {
  it('fails an 81-byte redirect body that no parse check would catch', () => {
    expect(checkHealth(src(), obs(fxBytes('trap-openai-redirect-stub.txt')), { bytes: 34432 }, NOW).state).toBe(
      'failed',
    );
  });

  // The floor with nothing else standing in front of it: no band (first
  // fetch), no canary, no parse check. The two assertions above both survive
  // deleting the floor, because the band and the canary each reject these same
  // 81 bytes on their own, and a guard nothing tests alone is a guard nothing
  // tests.
  it('fails an 81-byte redirect body with no band and no canary to catch it first', () => {
    const bare = src({ contentType: 'html', invariants: { ...src().invariants, canary: null } });
    expect(checkHealth(bare, obs(fxBytes('trap-openai-redirect-stub.txt')), { bytes: null }, NOW).reason).toBe(
      'below min_bytes (81 < 1000)',
    );
  });

  it('names the floor it fell under', () => {
    expect(checkHealth(src(), obs(fxBytes('trap-openai-redirect-stub.txt')), { bytes: 34432 }, NOW).reason).toBe(
      'below min_bytes (81 < 1000)',
    );
  });

  const banded = () =>
    src({ contentType: 'html', invariants: { ...src().invariants, minBytes: 10, canary: null } });

  it('fails a body far above the top of the band', () => {
    expect(checkHealth(banded(), obs(new Uint8Array(200000).fill(65)), { bytes: 1000 }, NOW).reason).toBe(
      'size ratio 200.000 outside band [0.5, 2]',
    );
  });

  it('fails a body far below the bottom of the band', () => {
    expect(checkHealth(banded(), obs(new Uint8Array(10).fill(65)), { bytes: 1000 }, NOW).reason).toBe(
      'size ratio 0.010 outside band [0.5, 2]',
    );
  });

  it('accepts a body exactly on the bottom edge of the band', () => {
    expect(checkHealth(banded(), obs(new Uint8Array(500).fill(65)), { bytes: 1000 }, NOW).state).toBe('ok');
  });

  it('accepts a body exactly on the top edge of the band', () => {
    expect(checkHealth(banded(), obs(new Uint8Array(2000).fill(65)), { bytes: 1000 }, NOW).state).toBe('ok');
  });

  // A ratio needs something to be a ratio of. Applying the band to the first
  // ever fetch would reject every new source at birth.
  it('does not apply the size band on the first ever fetch', () => {
    expect(checkHealth(src(), obs(fxBytes('healthy-claude-llms.txt')), { bytes: null }, NOW).state).toBe('ok');
  });

  it('does not apply the size band against a zero-byte last-good snapshot', () => {
    expect(checkHealth(src(), obs(fxBytes('healthy-claude-llms.txt')), { bytes: 0 }, NOW).state).toBe('ok');
  });
});

/**
 * Parsing is not enough. `ET.parse()` ACCEPTS the cohere fixture, at a root of
 * `<html>`, so a health check that asked "does it parse" would have written a
 * blog homepage over an RSS feed.
 */
describe('checkHealth, the xml root element', () => {
  const feedish = (root: string) =>
    src({ contentType: 'xml', expectedRoot: root, invariants: { ...src().invariants, canary: null, minBytes: 100 } });

  it('fails the cohere body that a real parser accepts', () => {
    expect(checkHealth(feedish('rss'), obs(fxBytes('trap-cohere-xhtml.xml')), { bytes: 1000000 }, NOW).state).toBe(
      'failed',
    );
  });

  it('names both the root it found and the root it wanted', () => {
    expect(checkHealth(feedish('rss'), obs(fxBytes('trap-cohere-xhtml.xml')), { bytes: 1000000 }, NOW).reason).toBe(
      'root element is <html>, expected <rss>',
    );
  });

  it('fails a feed url that answers with the site homepage', () => {
    expect(
      checkHealth(feedish('feed'), obs(fxBytes('trap-anthropic-catchall.html')), { bytes: null }, NOW).reason,
    ).toBe('root element is <html>, expected <feed>');
  });

  it('accepts a real sitemap at its declared root', () => {
    expect(
      checkHealth(feedish('urlset'), obs(fxBytes('healthy-anthropic-sitemap.xml')), { bytes: 60000 }, NOW).state,
    ).toBe('ok');
  });

  it('accepts a real atom feed at its declared root', () => {
    const s = src({
      contentType: 'xml',
      expectedRoot: 'feed',
      invariants: { ...src().invariants, canary: null, minBytes: 100 },
    });
    expect(checkHealth(s, obs(fxBytes('trap-pytorch-tags.atom')), { bytes: 28000 }, NOW).state).toBe('ok');
  });

  it('does not require an xml declaration before the root element', () => {
    expect(xmlRootElement('<!DOCTYPE html><html lang="en"><head></head></html>')).toBe('html');
  });

  it('skips the xml declaration when there is one', () => {
    expect(xmlRootElement('<?xml version="1.0" encoding="UTF-8"?>\n<urlset><url/></urlset>')).toBe('urlset');
  });

  it('skips a byte order mark before the declaration', () => {
    expect(xmlRootElement('﻿<?xml version="1.0"?><rss version="2.0"></rss>')).toBe('rss');
  });

  it('skips a comment sitting between the declaration and the root', () => {
    expect(xmlRootElement('<?xml version="1.0"?><!-- built by hand --><feed/>')).toBe('feed');
  });

  it('skips a doctype whose internal subset contains a greater-than sign', () => {
    expect(xmlRootElement('<!DOCTYPE rss [<!ENTITY gt2 "a>b">]><rss/>')).toBe('rss');
  });

  it('strips a namespace prefix from the root element name', () => {
    expect(xmlRootElement('<?xml version="1.0"?><atom:feed xmlns:atom="urn:x"/>')).toBe('feed');
  });

  // A comment is skipped to its terminator, not to the first `>` inside it.
  it('skips a comment that itself contains a greater-than sign', () => {
    expect(xmlRootElement('<?xml version="1.0"?><!-- a > b --><feed/>')).toBe('feed');
  });

  // `<` followed by something that cannot start a name. Without the null check
  // the group access throws instead of reporting no root.
  it('returns null when the first element name cannot start an xml name', () => {
    expect(xmlRootElement('<1abc/>')).toBeNull();
  });

  it('returns null when the body opens with no element at all', () => {
    expect(xmlRootElement('Moved Permanently. Redirecting to https://example.com/')).toBeNull();
  });

  // The no-root branch with nothing standing in front of it. Deleting it is
  // invisible to every other test here, because the root comparison then
  // rejects the same body with `root element is <null>, expected <rss>`.
  // expectedRoot is nullable in the schema, so for an xml source that declares
  // none this branch is the only structural check there is.
  it('fails a body with no root element even when the source declares no expected root', () => {
    const s = src({
      contentType: 'xml',
      expectedRoot: null,
      invariants: { ...src().invariants, canary: null, minBytes: 10 },
    });
    expect(checkHealth(s, obs(fxBytes('trap-openai-redirect-stub.txt')), { bytes: null }, NOW).reason).toBe(
      'no xml root element found',
    );
  });
});

describe('checkHealth, the json invariants', () => {
  const jsonSrc = (over: Partial<Source['invariants']> = {}) =>
    src({
      contentType: 'json',
      invariants: {
        minBytes: 10,
        requiredKeyPath: 'data',
        minRecords: 300,
        canary: null,
        sizeBand: [0.5, 2.0],
        ...over,
      },
    });

  it('accepts a real catalog meeting its record floor', () => {
    expect(checkHealth(jsonSrc(), obs(fxBytes('healthy-openrouter.json')), { bytes: 687878 }, NOW).state).toBe('ok');
  });

  const collapsed = () => enc(JSON.stringify({ data: [1, 2, 3] }));

  // `{ bytes: null }` throughout: a collapsed catalog is also far outside the
  // size band, and with a previous size present the band fires first and steals
  // the diagnosis, so these would assert the band rather than the json rules.
  it('fails a catalog that collapsed to three records', () => {
    expect(checkHealth(jsonSrc(), obs(collapsed()), { bytes: null }, NOW).state).toBe('failed');
  });

  it('names the record count it got and the floor it wanted', () => {
    expect(checkHealth(jsonSrc(), obs(collapsed()), { bytes: null }, NOW).reason).toBe(
      'records below floor (3 < 300)',
    );
  });

  it('fails a body that lost the required key entirely', () => {
    expect(checkHealth(jsonSrc(), obs(enc(JSON.stringify({ models: [] }))), { bytes: null }, NOW).reason).toBe(
      'required key path absent: data',
    );
  });

  it('fails when the required key is present but is not an array', () => {
    expect(checkHealth(jsonSrc(), obs(enc(JSON.stringify({ data: { n: 1 } }))), { bytes: null }, NOW).reason).toBe(
      'records below floor (not an array < 300)',
    );
  });

  // `JSON.parse('null')` succeeds and yields null, so the key lookup has to be
  // optional. Without that it throws, and a throw is reported by runTier as
  // `threw`, which reads like an unreachable host rather than an empty body.
  it('reports a json body of literal null as a missing key rather than throwing', () => {
    expect(checkHealth(jsonSrc({ minBytes: 1 }), obs(enc('null')), { bytes: null }, NOW).reason).toBe(
      'required key path absent: data',
    );
  });

  // A floor of exactly N accepts N. The comparison is `<`, and `<=` is the
  // spelling that rejects a catalog for being precisely the size it must be.
  it('accepts a catalog holding exactly its record floor', () => {
    const s = jsonSrc({ minRecords: 3 });
    expect(checkHealth(s, obs(enc(JSON.stringify({ data: [1, 2, 3] }))), { bytes: null }, NOW).state).toBe('ok');
  });

  // No floor configured means no floor applied, even to a value that is not an
  // array at all. The schema permits this combination and nothing uses it yet.
  it('does not police the shape of the required key when no floor is configured', () => {
    const s = jsonSrc({ minRecords: null });
    expect(checkHealth(s, obs(enc(JSON.stringify({ data: { n: 1 } }))), { bytes: null }, NOW).state).toBe('ok');
  });

  it('fails a body that is not json at all', () => {
    expect(checkHealth(jsonSrc(), obs(enc('<html>nope, an error page</html>')), { bytes: null }, NOW).state).toBe(
      'failed',
    );
  });

  // The parse itself, with nothing standing in front of it. The assertion
  // above survives replacing the parse with `parsed = {}`, because
  // requiredKeyPath rejects the same body one line later. requiredKeyPath is
  // nullable in the schema, so the day a json source ships without one, the
  // parse is that source's only structural check.
  it('fails an unparseable body even when the source declares no required key', () => {
    const s = jsonSrc({ requiredKeyPath: null, minRecords: null });
    expect(checkHealth(s, obs(enc('<html>nope, an error page</html>')), { bytes: null }, NOW).reason).toMatch(
      /^json parse failed: /,
    );
  });

  // A null `data` reaches the optional-chain result `null`, which is not
  // `undefined`. Without an array check it would sail past the key test.
  it('fails when the required key is present and null', () => {
    expect(checkHealth(jsonSrc(), obs(enc('{"data":null}')), { bytes: null }, NOW).reason).toBe(
      'records below floor (not an array < 300)',
    );
  });
});

/**
 * Stale is not failed. A provider with a genuinely quiet quarter must not
 * produce a daily failure email, because that is how an alerting channel gets
 * muted, and then the real outage arrives in a channel nobody reads.
 */
describe('checkHealth, feed freshness', () => {
  const feed = (maxQuietDays: number) =>
    src({
      contentType: 'xml',
      expectedRoot: 'rss',
      freshness: { kind: 'feed', maxQuietDays },
      invariants: { ...src().invariants, canary: null, minBytes: 100 },
    });

  it('marks a 338-day-quiet feed stale', () => {
    expect(checkHealth(feed(60), obs(fxBytes('trap-qwen-stale.xml')), { bytes: 39000 }, NOW).state).toBe('stale');
  });

  it('refuses the write on a stale feed', () => {
    expect(checkHealth(feed(60), obs(fxBytes('trap-qwen-stale.xml')), { bytes: 39000 }, NOW).writeAllowed).toBe(false);
  });

  // The distinction the whole four-state design exists for.
  it('does NOT count a stale feed as a failure', () => {
    expect(checkHealth(feed(60), obs(fxBytes('trap-qwen-stale.xml')), { bytes: 39000 }, NOW).countsAsFailure).toBe(
      false,
    );
  });

  it('says how quiet the feed has been and against what limit', () => {
    expect(checkHealth(feed(60), obs(fxBytes('trap-qwen-stale.xml')), { bytes: 39000 }, NOW).reason).toBe(
      'newest item 338 days old, limit 60',
    );
  });

  it('does not call the same feed stale under a limit that accommodates it', () => {
    expect(checkHealth(feed(400), obs(fxBytes('trap-qwen-stale.xml')), { bytes: 39000 }, NOW).state).toBe('ok');
  });

  it('does not call a feed updated hours ago stale', () => {
    const s = src({
      contentType: 'xml',
      expectedRoot: 'feed',
      freshness: { kind: 'feed', maxQuietDays: 7 },
      invariants: { ...src().invariants, canary: null, minBytes: 100 },
    });
    expect(checkHealth(s, obs(fxBytes('trap-pytorch-tags.atom')), { bytes: 28000 }, NOW).state).toBe('ok');
  });

  it('does not check freshness at all when the source declares none', () => {
    const s = src({
      contentType: 'xml',
      expectedRoot: 'rss',
      invariants: { ...src().invariants, canary: null, minBytes: 100 },
    });
    expect(checkHealth(s, obs(fxBytes('trap-qwen-stale.xml')), { bytes: 39000 }, NOW).state).toBe('ok');
  });

  // Both halves of the gate, each held separately. A source declaring
  // `content` freshness with a real maxQuietDays is the shape three shipped
  // sources actually have, and feed staleness must not be applied to it.
  it('does not apply feed freshness to a source that declares content freshness', () => {
    const s = src({
      contentType: 'xml',
      expectedRoot: 'rss',
      freshness: { kind: 'content', maxQuietDays: 30 },
      invariants: { ...src().invariants, canary: null, minBytes: 100 },
    });
    expect(checkHealth(s, obs(fxBytes('trap-qwen-stale.xml')), { bytes: 39000 }, NOW).state).toBe('ok');
  });

  it('does not apply feed freshness to a feed that declares no quiet limit', () => {
    const s = src({
      contentType: 'xml',
      expectedRoot: 'rss',
      freshness: { kind: 'feed', maxQuietDays: null },
      invariants: { ...src().invariants, canary: null, minBytes: 100 },
    });
    expect(checkHealth(s, obs(fxBytes('trap-qwen-stale.xml')), { bytes: 39000 }, NOW).state).toBe('ok');
  });

  // A limit of 60 days means 60 days is still inside it. `>=` is the spelling
  // that calls a source stale on the last day it was allowed to be quiet.
  it('does not call a feed stale on the exact day of its quiet limit', () => {
    const s = src({
      contentType: 'xml',
      expectedRoot: 'feed',
      freshness: { kind: 'feed', maxQuietDays: 60 },
      invariants: { ...src().invariants, canary: null, minBytes: 10 },
    });
    // Exactly 60 days before NOW.
    const body = enc('<?xml version="1.0"?>\n<feed><entry><updated>2026-06-28T00:00:00Z</updated></entry></feed>\n');
    expect(checkHealth(s, obs(body), { bytes: 100 }, NOW).state).toBe('ok');
  });

  it('says an empty feed is empty', () => {
    const s = src({
      contentType: 'xml',
      expectedRoot: 'feed',
      freshness: { kind: 'feed', maxQuietDays: 60 },
      invariants: { ...src().invariants, canary: null, minBytes: 10 },
    });
    const body = enc('<?xml version="1.0"?>\n<feed><title>No incidents yet</title></feed>\n');
    expect(checkHealth(s, obs(body), { bytes: 64 }, NOW).reason).toBe('feed carries no items at all');
  });

  // NEWEST, not first. Feeds are not reliably ordered, and a scan that keeps
  // the first date it parses reads a stale feed as fresh whenever the newest
  // entry is not at the top.
  it('takes the newest item date even when it is not the first one in the document', () => {
    expect(
      newestFeedDate(
        '<feed><entry><updated>2025-01-01T00:00:00Z</updated></entry>' +
          '<entry><updated>2026-01-01T00:00:00Z</updated></entry></feed>',
      ),
    ).toBe(Date.parse('2026-01-01T00:00:00Z'));
  });

  it('does not count an entry whose closing tag is a different element', () => {
    expect(countFeedItems('<feed><entry>x</entryX></feed>')).toBe(0);
  });

  /**
   * An Atom feed's own `<updated>` advances on wall-clock time independently
   * of its entries. Not "on every request": three fetches minutes apart
   * returned the same stamp under the same etag. The evidence is this
   * repository's history, which is better than a probe anyway: commits
   * 3a80c22 and 690dd60 are 49 minutes apart, and the entire delta between
   * the two 33,787-byte claude-status captures is one line, the feed-level
   * `<updated>` moving 19:04:25Z to 20:55:09Z, every entry byte-identical.
   *
   * A document-wide date scan reads that line, and the staleness check on
   * every Atom status feed could then never fire.
   */
  const selfStamping =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<feed xmlns="http://www.w3.org/2005/Atom">\n' +
    '  <title>Status - Incident History</title>\n' +
    '  <updated>2026-08-26T20:55:09Z</updated>\n' +
    '  <entry>\n' +
    '    <id>tag:example,2005:Incident/1</id>\n' +
    '    <published>2025-06-01T00:00:00Z</published>\n' +
    '    <updated>2025-06-01T00:00:00Z</updated>\n' +
    '  </entry>\n' +
    '</feed>\n';

  it('ignores a feed-level updated stamp that advances independently of the entries', () => {
    const s = src({
      contentType: 'xml',
      expectedRoot: 'feed',
      freshness: { kind: 'feed', maxQuietDays: 60 },
      invariants: { ...src().invariants, canary: null, minBytes: 10 },
    });
    expect(checkHealth(s, obs(enc(selfStamping)), { bytes: 320 }, NOW).state).toBe('stale');
  });

  it('reads only the entry dates, not the feed-level stamp', () => {
    expect(newestFeedDate(selfStamping)).toBe(Date.parse('2025-06-01T00:00:00Z'));
  });

  it('reads an rss pubDate in rfc-822 form with a numeric offset', () => {
    expect(newestFeedDate('<item><pubDate>Tue, 23 Sep 2025 04:00:00 +0800</pubDate></item>')).toBe(
      Date.parse('2025-09-22T20:00:00Z'),
    );
  });

  // Two different things, and only one of them is a defect. A provider that
  // has published nothing is the quiet case, and by this module's own
  // reasoning a quiet provider must not drive a failure. `openai-status` goes
  // active in Task 8 and can legitimately be empty.
  it('calls a feed with no items at all stale rather than failed', () => {
    const s = src({
      contentType: 'xml',
      expectedRoot: 'feed',
      freshness: { kind: 'feed', maxQuietDays: 60 },
      invariants: { ...src().invariants, canary: null, minBytes: 10 },
    });
    const body = enc('<?xml version="1.0"?>\n<feed><title>No incidents yet</title></feed>\n');
    expect(checkHealth(s, obs(body), { bytes: 64 }, NOW).state).toBe('stale');
  });

  it('does not count an empty feed as a failure', () => {
    const s = src({
      contentType: 'xml',
      expectedRoot: 'feed',
      freshness: { kind: 'feed', maxQuietDays: 60 },
      invariants: { ...src().invariants, canary: null, minBytes: 10 },
    });
    const body = enc('<?xml version="1.0"?>\n<feed><title>No incidents yet</title></feed>\n');
    expect(checkHealth(s, obs(body), { bytes: 64 }, NOW).countsAsFailure).toBe(false);
  });

  // The other side of the same branch: items ARE present and none of them is
  // dated, which is malformed rather than quiet.
  it('fails a feed carrying no parseable item date', () => {
    const s = src({
      contentType: 'xml',
      expectedRoot: 'feed',
      freshness: { kind: 'feed', maxQuietDays: 60 },
      invariants: { ...src().invariants, canary: null, minBytes: 10 },
    });
    const body = enc('<?xml version="1.0"?>\n<feed><entry><id>a</id><title>t</title></entry></feed>\n');
    expect(checkHealth(s, obs(body), { bytes: 74 }, NOW).reason).toBe('feed carries no parseable item date');
  });

  /**
   * Withholding the write is what keeps `prev.bytes` null, so on a source that
   * has never archived anything, ANY verdict that withholds closes a loop.
   * Both spellings were built here and both were wrong:
   *
   *   stale  -> no write -> no baseline -> stale  -> silent for ever
   *   failed -> no write -> no baseline -> failed -> exit 1 for ever
   *
   * The second was my fix for the first, and it was the same loop shouting.
   * Six simulated days: exit 1 on day 3, exit 1 on day 6, artifact absent
   * throughout, no self-recovery. `openai-status` carries `maxQuietDays: 120`
   * on a provider-incident feed where four silent months is the normal good
   * state, and Task 8 activates it into exactly that.
   *
   * A first fetch therefore SEEDS. Every structural invariant has passed by
   * the time the quiet branch is reached, so the bytes are known good, and it
   * is this write that creates the baseline the next run measures against.
   */
  it('writes the first ever fetch of a quiet feed rather than withholding it', () => {
    expect(checkHealth(feed(60), obs(fxBytes('trap-qwen-stale.xml')), { bytes: null }, NOW).state).toBe('ok');
  });

  it('allows the write that creates the baseline', () => {
    expect(checkHealth(feed(60), obs(fxBytes('trap-qwen-stale.xml')), { bytes: null }, NOW).writeAllowed).toBe(true);
  });

  it('does not count a first-ever quiet fetch as a failure either', () => {
    expect(checkHealth(feed(60), obs(fxBytes('trap-qwen-stale.xml')), { bytes: null }, NOW).countsAsFailure).toBe(
      false,
    );
  });

  /**
   * The claim neither the silent version nor the loud version can pass, and
   * the only form in which the quiet contract can be stated at all: it is a
   * property of a SEQUENCE, not of a response. The second fetch measures its
   * quiet against the baseline the first one wrote.
   */
  it('calls the same quiet feed stale on the second fetch, once a baseline exists', () => {
    const body = fxBytes('trap-qwen-stale.xml');
    const first = checkHealth(feed(60), obs(body), { bytes: null }, NOW);
    const archived = first.writeAllowed ? body.byteLength : null;
    expect(checkHealth(feed(60), obs(body), { bytes: archived }, NOW).state).toBe('stale');
  });

  // The seed falls through to the ordinary tail rather than returning early,
  // so a first-ever fetch that ALSO moved is still reported as relocated.
  it('still reports a relocation on the first ever fetch of a quiet feed', () => {
    const moved = obs(fxBytes('trap-qwen-stale.xml'), { finalUrl: 'https://elsewhere.example/f', redirectCount: 1 });
    expect(checkHealth(feed(60), moved, { bytes: null }, NOW).state).toBe('relocated');
  });

  it('writes the first ever fetch of an empty feed rather than withholding it', () => {
    const s = src({
      contentType: 'xml',
      expectedRoot: 'feed',
      freshness: { kind: 'feed', maxQuietDays: 60 },
      invariants: { ...src().invariants, canary: null, minBytes: 10 },
    });
    const body = enc('<?xml version="1.0"?>\n<feed><title>No incidents yet</title></feed>\n');
    expect(checkHealth(s, obs(body), { bytes: null }, NOW).state).toBe('ok');
  });

  it('calls that same empty feed stale on the second fetch', () => {
    const s = src({
      contentType: 'xml',
      expectedRoot: 'feed',
      freshness: { kind: 'feed', maxQuietDays: 60 },
      invariants: { ...src().invariants, canary: null, minBytes: 10 },
    });
    const body = enc('<?xml version="1.0"?>\n<feed><title>No incidents yet</title></feed>\n');
    const first = checkHealth(s, obs(body), { bytes: null }, NOW);
    const archived = first.writeAllowed ? body.byteLength : null;
    expect(checkHealth(s, obs(body), { bytes: archived }, NOW).state).toBe('stale');
  });

  // Malformed is malformed with or without a baseline: this one does NOT seed.
  it('still fails an undated feed on its first ever fetch', () => {
    const s = src({
      contentType: 'xml',
      expectedRoot: 'feed',
      freshness: { kind: 'feed', maxQuietDays: 60 },
      invariants: { ...src().invariants, canary: null, minBytes: 10 },
    });
    const body = enc('<?xml version="1.0"?>\n<feed><entry><id>a</id><title>t</title></entry></feed>\n');
    expect(checkHealth(s, obs(body), { bytes: null }, NOW).reason).toBe('feed carries no parseable item date');
  });

  /**
   * `xmlRootElement` strips namespace prefixes and says so. The item scanner
   * did not, so `<atom:entry>` counted as ZERO items and a namespaced Atom
   * feed full of undated entries routed to the SILENT quiet branch instead of
   * the loud malformed one. Same file, one function apart.
   */
  it('counts a namespaced atom entry as an item', () => {
    expect(countFeedItems('<atom:feed><atom:entry><id>1</id></atom:entry></atom:feed>')).toBe(1);
  });

  it('counts a self-closing entry as an item', () => {
    expect(countFeedItems('<feed><entry/></feed>')).toBe(1);
  });

  it('counts an entry carrying attributes as an item', () => {
    expect(countFeedItems('<feed><entry xml:lang="en"><id>1</id></entry></feed>')).toBe(1);
  });

  it('does not count a paired element that merely starts with the word entry', () => {
    expect(countFeedItems('<feed><entryPoint>x</entryPoint></feed>')).toBe(0);
  });

  it('does not count a self-closing element that merely starts with the word entry', () => {
    expect(countFeedItems('<feed><entryPoint/></feed>')).toBe(0);
  });

  // A self-closing entry has no inner text at all, so the date reader gets
  // `undefined` where it used to get a string. Without a guard it throws, and
  // a throw inside checkHealth is caught by runTier and logged as `threw`,
  // which reads like an unreachable host rather than a feed it could not parse.
  it('does not trip over a self-closing entry while reading the dated ones', () => {
    expect(newestFeedDate('<feed><entry/><entry><updated>2025-06-01T00:00:00Z</updated></entry></feed>')).toBe(
      Date.parse('2025-06-01T00:00:00Z'),
    );
  });

  it('reads the date out of a namespaced entry', () => {
    expect(newestFeedDate('<atom:entry><updated>2025-06-01T00:00:00Z</updated></atom:entry>')).toBe(
      Date.parse('2025-06-01T00:00:00Z'),
    );
  });

  // The behaviour the counting bug actually broke: loud, not silent.
  it('fails a namespaced feed whose entries carry no date, rather than calling it quiet', () => {
    const s = src({
      contentType: 'xml',
      expectedRoot: 'feed',
      freshness: { kind: 'feed', maxQuietDays: 60 },
      invariants: { ...src().invariants, canary: null, minBytes: 10 },
    });
    const body = enc('<?xml version="1.0"?>\n<atom:feed><atom:entry><id>1</id></atom:entry></atom:feed>\n');
    expect(checkHealth(s, obs(body), { bytes: 80 }, NOW).reason).toBe('feed carries no parseable item date');
  });
});

describe('checkHealth, relocation and the redirect budget', () => {
  const moved = () =>
    obs(fxBytes('healthy-claude-llms.txt'), { finalUrl: 'https://elsewhere.example/f', redirectCount: 1 });

  it('marks a moved url relocated', () => {
    expect(checkHealth(src(), moved(), { bytes: 63000 }, NOW).state).toBe('relocated');
  });

  // Relocated writes. The bytes are good; it is the url in the config that is
  // stale, and refusing the write would lose real content over bookkeeping.
  it('allows the write on a relocation', () => {
    expect(checkHealth(src(), moved(), { bytes: 63000 }, NOW).writeAllowed).toBe(true);
  });

  it('does not count a relocation as a failure', () => {
    expect(checkHealth(src(), moved(), { bytes: 63000 }, NOW).countsAsFailure).toBe(false);
  });

  it('says where it landed and what was declared', () => {
    expect(checkHealth(src(), moved(), { bytes: 63000 }, NOW).reason).toBe(
      'final url is https://elsewhere.example/f, declared https://example.com/f',
    );
  });

  // Relocation is decided last. A moved url that also lost its canary is
  // failed, not a writable relocation.
  it('fails a relocation whose body lost the canary rather than writing it', () => {
    const s = src({ invariants: { ...src().invariants, canary: 'THIS STRING IS NOT PRESENT' } });
    expect(checkHealth(s, moved(), { bytes: 63000 }, NOW).state).toBe('failed');
  });

  it('fails when the redirect budget is exhausted', () => {
    const over = obs(fxBytes('healthy-claude-llms.txt'), { redirectCount: 4 });
    expect(checkHealth(src(), over, { bytes: 63000 }, NOW).reason).toBe('redirect budget exhausted (4 > 3)');
  });

  it('accepts a response that used its redirect budget exactly', () => {
    const at = obs(fxBytes('healthy-claude-llms.txt'), { redirectCount: 3 });
    expect(checkHealth(src(), at, { bytes: 63000 }, NOW).state).toBe('ok');
  });
});

/**
 * The canaries in `meta/sources.json` against the bytes actually in the
 * archive. Two independent artifacts: the canary comes from the config, the
 * body from `raw/`, so neither is derived from the other.
 */
describe('the configured canaries', () => {
  const file = loadSources(JSON.parse(fs.readFileSync('meta/sources.json', 'utf8')));
  const textSources = file.sources.filter((s) => s.contentType === 'text');

  it('covers all nine text-typed sources', () => {
    expect(textSources.map((s) => s.id)).toEqual([
      'anthropic-deprecations',
      'claude-llms-txt',
      'openrouter-llms-txt',
      'openai-llms-txt',
      'together-llms-txt',
      'perplexity-llms-txt',
      'mistral-llms-txt',
      'groq-llms-full-txt',
      'xai-llms-txt',
    ]);
  });

  it('leaves no task-6 placeholder behind', () => {
    expect(file.sources.filter((s) => s.invariants.canary?.includes('PLACEHOLDER')).map((s) => s.id)).toEqual([]);
  });

  it('uses no canary short enough to match by accident', () => {
    expect(textSources.filter((s) => (s.invariants.canary ?? '').length < 10).map((s) => s.id)).toEqual([]);
  });

  // The `archived` filter below is a filter, and a filter that quietly dropped
  // a source would be a coverage gap that looks like coverage. So the set it
  // drops is named. It is empty now: `xai-llms-txt` was the one entry here
  // while it shipped `pending`, and activating it gave the collector something
  // to archive on its first run.
  // An ACTIVE text source must have a capture, or its canary is never checked
  // against real bytes. A PENDING one has none by definition, so the gap is
  // asserted by name rather than skipped silently: if a source goes dark, this
  // test says which, and if one is reactivated without a capture it fails.
  it('has an archived capture for every ACTIVE text source, so the canary loop skips none', () => {
    const missing = textSources.filter((s) => s.status === 'active' && !fs.existsSync(s.path));
    expect(missing.map((s) => s.id)).toEqual([]);
  });

  it('names every text source that is dark, rather than skipping it quietly', () => {
    const dark = textSources.filter((s) => !fs.existsSync(s.path)).map((s) => s.id).sort();
    expect(dark).toEqual(['xai-llms-txt']);
  });

  const archived = textSources.filter((s) => fs.existsSync(s.path));

  // Two loops, not one. The `checkHealth` assertion below still passes if
  // checkHealth is stubbed to return ok, so on its own it would not prove the
  // canary is real. This one reads the bytes directly and no stub can satisfy
  // it.
  for (const s of archived) {
    it(`finds the configured canary of ${s.id} in its archived capture`, () => {
      expect(fs.readFileSync(s.path, 'utf8').includes(s.invariants.canary!)).toBe(true);
    });
  }

  for (const s of archived) {
    it(`accepts the archived capture of ${s.id} against its whole invariant set`, () => {
      const body = new Uint8Array(fs.readFileSync(s.path));
      const v = checkHealth(s, { status: 200, body, finalUrl: s.url, redirectCount: 0, headers: {} }, { bytes: null }, NOW);
      expect(v.state).toBe('ok');
    });
  }
});
