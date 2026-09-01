import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { loadSources, sourcesForTier, activeSourcesForTier } from '../src/config.js';
import type { SourcesFile } from '../src/config.js';

// A deliberately mutable fixture type. Every guard test below reaches in and
// breaks exactly one field, so the fixture cannot be `as const` and cannot
// infer `canary: null` as the literal type `null`.
type Fixture = {
  version: number;
  userAgent: string;
  contact: string;
  sources: Array<{
    id: string;
    url: string;
    tier: string;
    status: string;
    path: string;
    contentType: string;
    expectedRoot: string | null;
    invariants: {
      minBytes: number;
      requiredKeyPath: string | null;
      minRecords: number | null;
      canary: string | null;
      sizeBand: [number, number];
    };
    freshness: { kind: string; maxQuietDays: number | null };
    predicate: Record<string, unknown>;
    timeoutS: number;
    retries: number;
    maxRedirects: number;
    rateLimit: { maxAutoEventsPerDay: number };
    magnitudeGuard: { maxShrinkPct: number };
    notes: string;
  }>;
};

// A factory, not a shared literal: a test that mutates a shared object leaks
// its mutation into whichever test vitest happens to run next.
function minimal(): Fixture {
  return {
    version: 1,
    userAgent: 'llm-catalog-archive/1.0 (+https://github.com/OWNER/REPO)',
    contact: 'owner@example.com',
    sources: [
      {
        id: 'openrouter-models',
        url: 'https://openrouter.ai/api/v1/models',
        tier: 'fast',
        status: 'active',
        path: 'raw/openrouter-models/response.json',
        contentType: 'json',
        expectedRoot: null,
        invariants: {
          minBytes: 400000,
          requiredKeyPath: 'data',
          minRecords: 300,
          canary: null,
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
      },
    ],
  };
}

function only(f: Fixture) {
  return f.sources[0]!;
}

describe('loadSources', () => {
  it('accepts a well formed file', () => {
    expect(loadSources(minimal()).sources[0]!.id).toBe('openrouter-models');
  });

  it('rejects an unknown key rather than ignoring it', () => {
    const bad = minimal();
    (only(bad) as Record<string, unknown>).cadence = '15m';
    expect(() => loadSources(bad)).toThrow(/cadence/);
  });

  it('rejects an unknown key nested inside invariants', () => {
    const bad = minimal();
    (only(bad).invariants as Record<string, unknown>).maxBytes = 900000;
    expect(() => loadSources(bad)).toThrow(/maxBytes/);
  });

  it('rejects an unknown key inside the predicate, which is the dangerous one', () => {
    // A `patterns` list silently ignored on a `bytes` predicate reads like a
    // configured mask and behaves like no mask at all.
    const bad = minimal();
    only(bad).predicate = { type: 'bytes', patterns: ['"userId":"[^"]+"'] };
    expect(() => loadSources(bad)).toThrow(/patterns/);
  });

  it('rejects a duplicate id', () => {
    const bad = minimal();
    bad.sources.push(structuredClone(only(bad)));
    expect(() => loadSources(bad)).toThrow(/duplicate/i);
  });

  it('rejects a path that does not match the id', () => {
    const bad = minimal();
    only(bad).path = 'raw/somewhere-else/response.json';
    expect(() => loadSources(bad)).toThrow(/path/i);
  });

  it('rejects a path whose directory merely starts with the id', () => {
    // `raw/openrouter-models-old/` passes a prefix check written without the
    // trailing slash, and lands two sources in one directory.
    const bad = minimal();
    only(bad).path = 'raw/openrouter-models-old/response.json';
    expect(() => loadSources(bad)).toThrow(/path/i);
  });

  it('requires a canary for every text source, since parse checks are vacuous there', () => {
    const bad = minimal();
    only(bad).contentType = 'text';
    expect(() => loadSources(bad)).toThrow(/canary/i);
  });

  it('rejects an empty string canary on a text source', () => {
    const bad = minimal();
    only(bad).contentType = 'text';
    only(bad).invariants.canary = '';
    expect(() => loadSources(bad)).toThrow(/canary/i);
  });

  it('accepts a text source once it declares a canary', () => {
    // Proves the guard keys on the missing canary and not merely on the
    // contentType, so it cannot pass by rejecting all text sources.
    const ok = minimal();
    only(ok).contentType = 'text';
    only(ok).path = 'raw/openrouter-models/response.txt';
    only(ok).invariants.canary = '# OpenRouter';
    expect(loadSources(ok).sources[0]!.invariants.canary).toBe('# OpenRouter');
  });

  it('rejects a sizeBand whose lower bound is above 1', () => {
    // Was "rejects an inverted sizeBand" with [2.0, 0.5]. That pair violates
    // both tuple bounds at once, so neither bound proved itself and the name
    // claimed an ordering check that the loader body no longer performs on it.
    // [2.0, 3.0] is well ordered and still cannot mean "within a ratio of the
    // last accepted snapshot", so it exercises lo <= 1 alone.
    const bad = minimal();
    only(bad).invariants.sizeBand = [2.0, 3.0];
    expect(() => loadSources(bad)).toThrow(/sizeBand/i);
  });

  it('rejects a sizeBand whose upper bound is below 1', () => {
    // [0.5, 0.9] accepts a response only if it shrank. Exercises hi >= 1
    // alone, so that bound and the lower one each stand on their own.
    const bad = minimal();
    only(bad).invariants.sizeBand = [0.5, 0.9];
    expect(() => loadSources(bad)).toThrow(/sizeBand/i);
  });

  it('rejects a sizeBand whose bounds are equal', () => {
    const bad = minimal();
    only(bad).invariants.sizeBand = [1.0, 1.0];
    expect(() => loadSources(bad)).toThrow(/sizeBand/i);
  });

  it('accepts a mask predicate and keeps its patterns', () => {
    // The mask branch is the one the "silently ignored predicate override"
    // story is about, and no shipped source exercises it yet.
    const ok = minimal();
    only(ok).predicate = { type: 'mask', patterns: ['"userId":"[^"]+"'] };
    const p = loadSources(ok).sources[0]!.predicate;
    expect(p.type).toBe('mask');
    if (p.type === 'mask') expect(p.patterns).toEqual(['"userId":"[^"]+"']);
  });

  it('rejects a mask predicate with no patterns', () => {
    // An empty pattern list is a mask that masks nothing, so the source
    // commits every run while the table reads as if it were handled.
    const bad = minimal();
    only(bad).predicate = { type: 'mask', patterns: [] };
    expect(() => loadSources(bad)).toThrow(/patterns/);
  });

  it('rejects a url that is not https', () => {
    const bad = minimal();
    only(bad).url = 'javascript:alert(1)';
    expect(() => loadSources(bad)).toThrow(/url/i);
  });

  it('rejects an http url, not only a non http scheme', () => {
    // Removing the protocol option entirely dies to javascript:alert(1), but
    // relaxing /^https$/ to /^https?$/ is the likelier edit and nothing else
    // in the suite would notice it: all 18 shipped sources are https.
    const bad = minimal();
    only(bad).url = 'http://openrouter.ai/api/v1/models';
    expect(() => loadSources(bad)).toThrow(/url/i);
  });

  it('rejects a sizeBand wide enough to admit an SPA shell', () => {
    const bad = minimal();
    only(bad).invariants.sizeBand = [0.01, 100.0];
    expect(() => loadSources(bad)).toThrow(/sizeBand/i);
  });

  it('rejects a magnitude guard of 100, which can never fire', () => {
    const bad = minimal();
    only(bad).magnitudeGuard.maxShrinkPct = 100;
    expect(() => loadSources(bad)).toThrow(/maxShrinkPct/i);
  });

  it('rejects maxRedirects 0, which disables relocation detection', () => {
    const bad = minimal();
    only(bad).maxRedirects = 0;
    expect(() => loadSources(bad)).toThrow(/maxRedirects/i);
  });

  it('rejects an unknown top level key', () => {
    const bad = minimal() as Record<string, unknown>;
    bad.schedule = '*/15 * * * *';
    expect(() => loadSources(bad)).toThrow(/schedule/);
  });
});

describe('tier and status selection', () => {
  function twoSources(): Fixture {
    const f = minimal();
    const pending = structuredClone(only(f));
    pending.id = 'arena-leaderboard';
    pending.url = 'https://arena.ai/leaderboard';
    pending.path = 'raw/arena-leaderboard/response.html';
    pending.status = 'pending';
    f.sources.push(pending);
    return f;
  }

  it('returns the fast tier sources', () => {
    expect(sourcesForTier(loadSources(minimal()), 'fast')).toHaveLength(1);
  });

  it('returns nothing for a tier with no sources', () => {
    expect(sourcesForTier(loadSources(minimal()), 'daily')).toHaveLength(0);
  });

  it('activeSourcesForTier keeps an active source', () => {
    expect(activeSourcesForTier(loadSources(minimal()), 'fast')).toHaveLength(1);
  });

  it('activeSourcesForTier drops a pending source', () => {
    const f = loadSources(twoSources());
    expect(activeSourcesForTier(f, 'fast').map((s) => s.id)).toEqual(['openrouter-models']);
  });

  it('sourcesForTier still reports a pending source, so it can be validated and shown', () => {
    const f = loadSources(twoSources());
    expect(sourcesForTier(f, 'fast').map((s) => s.id)).toEqual([
      'openrouter-models',
      'arena-leaderboard',
    ]);
  });
});

describe('the shipped meta/sources.json', () => {
  // Lazy, not describe-body scope. Loaded eagerly, one bad row in the data
  // file takes down all of the pure loader tests too, and vitest reports a
  // collection error instead of naming the test that cares.
  let cached: SourcesFile | undefined;
  const shipped = (): SourcesFile =>
    (cached ??= loadSources(JSON.parse(fs.readFileSync('meta/sources.json', 'utf8'))));

  it('loads and has all 23 sources', () => {
    expect(shipped().sources).toHaveLength(23);
  });

  /**
   * Nothing is pending any more. The last two to go active this way were
   * deepmind-sitemap and openai-sitemap, which passed the double-fetch gate:
   * two fetches 20 seconds apart returned byte-identical bodies and an
   * identical sitemapLoc projection, so a second consecutive run commits
   * nothing. Before them, two went active for reasons that had nothing to do
   * with their predicates.
   *
   * `arena-leaderboard` was blocked at the health check by `__CF$cv$params`,
   * which turned out to mark "behind Cloudflare" rather than "is a challenge";
   * the denylist now carries markers only a real challenge has.
   * `xai-llms-txt` was dark because the provider published their own API key
   * in it, and the write-time credential gate in `src/secrets.ts` is now what
   * protects the archive from that rather than the darkness.
   */
  it('ships no pending source at all', () => {
    expect(shipped().sources.filter((s) => s.status === 'pending').map((s) => s.id)).toEqual([]);
  });

  // The half of the story a status field cannot say. Flipping the status
  // without the extractor would still pass the assertion above, and the source
  // would commit 5.2 MB of per-request noise every day forever.
  it('gives arena-leaderboard the extractor its activation depends on', () => {
    const arena = shipped().sources.find((s) => s.id === 'arena-leaderboard')!;
    expect(arena.predicate).toEqual({ type: 'extracted', extractor: 'arena' });
  });

  // The two the launch-day double dry run found. Neither was in the original
  // three, and both would have committed on every run forever under `bytes`.
  it('gives the four activated volatile sources the predicate each needs', () => {
    const p = Object.fromEntries(shipped().sources.map((s) => [s.id, s.predicate]));
    expect(p['anthropic-sitemap']).toEqual({ type: 'extracted', extractor: 'sitemapDated' });
    expect(p['openai-status']).toEqual({ type: 'extracted', extractor: 'atomStatus' });
    expect(p['openrouter-sitemap']).toEqual({ type: 'extracted', extractor: 'sitemapLoc' });
    expect(p['xai-llms-txt']).toEqual({ type: 'extracted', extractor: 'xai' });
  });

  // `sitemapLoc` would work on the Anthropic sitemap and would be wrong: it
  // reduces that source to add/remove detection and throws away the per-URL
  // lastmod that makes an edit detectable. The two sitemaps sharing one
  // extractor is the realistic mistake, so it gets its own assertion.
  it('does not give the two sitemaps the same extractor', () => {
    const p = Object.fromEntries(shipped().sources.map((s) => [s.id, s.predicate]));
    expect(p['anthropic-sitemap']).not.toEqual(p['openrouter-sitemap']);
  });

  // The feed-level `<updated>` line that has already produced seven commits of
  // one timestamp moving.
  it('masks claude-status rather than committing its feed-level updated', () => {
    const cs = shipped().sources.find((s) => s.id === 'claude-status')!;
    expect(cs.predicate).toEqual({
      type: 'mask',
      patterns: ['(?<!<entry[\\s>][\\s\\S]*)<updated>[^<]*</updated>'],
    });
  });

  it('puts only openrouter-models in the fast tier', () => {
    expect(sourcesForTier(shipped(), 'fast').map((s) => s.id)).toEqual(['openrouter-models']);
  });

  it('hands the collector every one of the twenty-three sources', () => {
    const fetched = [
      ...activeSourcesForTier(shipped(), 'fast'),
      ...activeSourcesForTier(shipped(), 'daily'),
    ].map((s) => s.id);
    expect(fetched).toHaveLength(23);
  });

  // The filter still filters. With nothing pending in the shipped file the
  // assertion above passes just as well against a function that ignores
  // `status` entirely, so the behaviour is pinned against a source that is.
  it('still withholds a source that is marked pending', () => {
    const file = shipped();
    const marked = {
      ...file,
      sources: file.sources.map((s) => (s.id === 'arena-leaderboard' ? { ...s, status: 'pending' as const } : s)),
    };
    expect(activeSourcesForTier(marked, 'daily').map((s) => s.id)).not.toContain('arena-leaderboard');
  });

  it('matches spec section 4 on every id and url', () => {
    // Section 4's tables are the authority for the URLs, several of which are
    // deliberately unobvious. Comparing against the spec text catches a
    // transcription typo that no amount of schema strictness would see.
    const spec = fs.readFileSync(
      'docs/superpowers/specs/2026-08-26-collector-and-archive-design.md',
      'utf8',
    );
    const inventory = spec.slice(
      spec.indexOf('## 4. Source inventory'),
      spec.indexOf('### Baselines'),
    );
    expect(inventory).not.toBe('');

    const fromSpec = new Map<string, string>();
    for (const line of inventory.split('\n')) {
      const m = /^\|\s*`([a-z0-9-]+)`\s*\|\s*`([^`]+)`\s*\|/.exec(line);
      if (m) fromSpec.set(m[1]!, m[2]!);
    }
    expect(fromSpec.size).toBe(23);

    const fromTable = new Map(shipped().sources.map((s) => [s.id, s.url]));
    expect(Object.fromEntries(fromTable)).toEqual(Object.fromEntries(fromSpec));
  });

  it('justifies every non default predicate in notes', () => {
    const exceptional = shipped().sources.filter((s) => s.predicate.type !== 'bytes');
    expect(exceptional.map((s) => s.id).sort()).toEqual([
      'anthropic-sitemap',
      'arena-leaderboard',
      'claude-status',
      'deepmind-blog-feed',
      'deepmind-sitemap',
      'huggingface-blog-feed',
      'openai-news-feed',
      'openai-sitemap',
      'openai-status',
      'openrouter-sitemap',
      'transformers-pulls',
      'vllm-pulls',
      'xai-llms-txt',
    ]);
    for (const s of exceptional) {
      expect(s.notes.length, `${s.id} notes`).toBeGreaterThanOrEqual(200);
      // Length alone passes on 200 characters of filler, and a justification
      // copied from a neighbouring source is the realistic failure. Require
      // the note to name the very mechanism it is justifying.
      if (s.predicate.type === 'extracted') {
        expect(s.notes, `${s.id} notes`).toContain(s.predicate.extractor);
      }
      // `arena` is a substring of the id and of arena.ai, and `xai` of its own
      // id, so naming the extractor is cheap to satisfy by accident. So is the
      // bare word `bytes`: it is the unit word in every size measurement, and
      // 15 of the 18 shipped notes contain it. The note has to reject the
      // default in so many words, which no size measurement does by accident.
      expect(s.notes, `${s.id} notes`).toMatch(/not bytes|bytes predicate|bytes is wrong/);
    }
  });

  it('stores every response at raw/<id>/response.<ext>', () => {
    for (const s of shipped().sources) {
      expect(s.path, s.id).toMatch(new RegExp(`^raw/${s.id}/response\\.[a-z]+$`));
    }
  });

  /**
   * This used to require a canary on every text source and NONE on any other,
   * on the reasoning that a canary stands in exactly where "parses as its
   * declared type" would be vacuous. That reasoning was half right and the
   * "and nowhere else" half was wrong, which cost real safety: a sweep of every
   * stored capture against every other source's gates accepted 5 of 306 foreign
   * bodies, all between structurally identical siblings, and four of the five
   * were json or xml sources this rule forbade from carrying a canary.
   *
   * A canary answers "are these the bytes of THIS source", which is a question
   * about identity and not about content type. Parsing tells you a json body is
   * json; it cannot tell you it is the vllm search rather than the transformers
   * one. So the rule is now the weaker and truer one: no placeholders anywhere.
   *
   * A canary that is present but WRONG is invisible from here. It is caught in
   * test/cross-origin.test.ts, which runs every configured canary against the
   * bytes actually archived under raw/<id>/ and against every sibling's.
   */
  it('leaves no canary placeholder in the shipped config', () => {
    for (const s of shipped().sources) {
      expect(s.invariants.canary, s.id).not.toBe('__CANARY_PLACEHOLDER_TASK_6__');
      if (s.invariants.canary !== null) expect(s.invariants.canary.length, s.id).toBeGreaterThan(0);
    }
  });

  it('still gives every text source a canary, which is where parsing is vacuous', () => {
    for (const s of shipped().sources) {
      if (s.contentType === 'text') expect(s.invariants.canary, s.id).not.toBeNull();
    }
  });

  it('sets minBytes below the size recorded in spec section 4 for every source', () => {
    // A minBytes at or above the observed size fails on the first healthy
    // fetch. Half the recorded size is the rule; this asserts the direction.
    const recorded: Record<string, number> = {
      'openrouter-models': 687878,
      'arena-leaderboard': 5235684,
      'anthropic-sitemap': 67354,
      'anthropic-deprecations': 13410,
      'claude-llms-txt': 63970,
      'openrouter-llms-txt': 66545,
      'openrouter-sitemap': 616687,
      'openai-llms-txt': 34432,
      'together-llms-txt': 61720,
      'perplexity-llms-txt': 43329,
      'mistral-llms-txt': 14658,
      'groq-llms-full-txt': 797252,
      'xai-llms-txt': 1465407,
      'modelsdev-commits': 20239,
      'transformers-pulls': 483237,
      'vllm-pulls': 657623,
    };
    for (const s of shipped().sources) {
      const size = recorded[s.id];
      if (size === undefined) continue;
      expect(s.invariants.minBytes, s.id).toBeLessThan(size);
      expect(s.invariants.minBytes, s.id).toBeGreaterThan(size / 4);
    }
  });
  it('carries the freshness setting every source was assigned', () => {
    // Freshness has no schema bound that can distinguish feed/120 from
    // none/null, so without this the whole field is unasserted and a source
    // can silently stop being freshness checked forever.
    const actual = Object.fromEntries(
      shipped().sources.map((s) => [s.id, `${s.freshness.kind}/${s.freshness.maxQuietDays}`]),
    );
    expect(actual).toEqual({
      'openrouter-models': 'none/null',
      'arena-leaderboard': 'content/30',
      'anthropic-sitemap': 'content/90',
      'anthropic-deprecations': 'content/90',
      'claude-llms-txt': 'content/90',
      'openrouter-llms-txt': 'content/90',
      'openrouter-sitemap': 'content/90',
      'openai-llms-txt': 'content/90',
      'together-llms-txt': 'content/90',
      'perplexity-llms-txt': 'content/90',
      'mistral-llms-txt': 'content/90',
      'groq-llms-full-txt': 'content/90',
      'xai-llms-txt': 'content/90',
      'modelsdev-commits': 'feed/7',
      'claude-status': 'feed/120',
      'openai-status': 'feed/120',
      'transformers-pulls': 'content/30',
      'vllm-pulls': 'content/30',
      // The two announcement indexes. content/90 like every other sitemap: a
      // provider going three months without publishing is quiet, not broken.
      'deepmind-sitemap': 'content/90',
      'openai-sitemap': 'content/90',
      // The announcement feeds. feed/30 like modelsdev-commits: a blog that
      // publishes nothing for a month is quiet, and the feed branch of the
      // health check reads their newest item date directly.
      'openai-news-feed': 'feed/30',
      'deepmind-blog-feed': 'feed/30',
      'huggingface-blog-feed': 'feed/30',
    });
  });

  it('declares the right expectedRoot, not merely some expectedRoot', () => {
    // Presence is the wrong assertion, because the failure this field exists
    // to stop is a wrong value. `html` is a legitimate expectedRoot elsewhere
    // in this same file, on arena-leaderboard, so copying it onto the sitemap
    // is the edit a reviewer's eye slides over, and it collapses spec health
    // rule 2 to "parses as XML": the cohere feed that a parser accepts happily
    // with root=html. Pinning the values also catches a source acquiring an
    // expectedRoot it should not have, as an extra key.
    const declared = Object.fromEntries(
      shipped()
        .sources.filter((s) => s.expectedRoot !== null)
        .map((s) => [s.id, s.expectedRoot]),
    );
    expect(declared).toEqual({
      'arena-leaderboard': 'html',
      'anthropic-sitemap': 'urlset',
      'openrouter-sitemap': 'urlset',
      'modelsdev-commits': 'feed',
      'claude-status': 'feed',
      'openai-status': 'feed',
      // Both are real urlsets, NOT sitemap indexes. openai.com/sitemap.xml is
      // an index whose children are urlsets, which is why the stored artifact
      // is the research child and not the root: pinning the root element is
      // what would catch a later edit pointing this back at the index.
      'deepmind-sitemap': 'urlset',
      'openai-sitemap': 'urlset',
      // rss, not feed: all three are RSS 2.0, and pinning the value is what
      // catches one of them being repointed at an Atom URL that a parser would
      // accept just as happily.
      'openai-news-feed': 'rss',
      'deepmind-blog-feed': 'rss',
      'huggingface-blog-feed': 'rss',
    });
  });

  it('declares the right requiredKeyPath, not merely some requiredKeyPath', () => {
    // Same reasoning one type over: valid JSON of the wrong shape is still
    // valid JSON, and `models` would read as plausible while pointing at
    // nothing in a body whose list lives under `data`.
    const declared = Object.fromEntries(
      shipped()
        .sources.filter((s) => s.invariants.requiredKeyPath !== null)
        .map((s) => [s.id, s.invariants.requiredKeyPath]),
    );
    expect(declared).toEqual({
      'openrouter-models': 'data',
      'transformers-pulls': 'items',
      'vllm-pulls': 'items',
    });
  });
});
