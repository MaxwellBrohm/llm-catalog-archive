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

  it('rejects an inverted sizeBand', () => {
    const bad = minimal();
    only(bad).invariants.sizeBand = [2.0, 0.5];
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

  it('loads and has all 16 sources', () => {
    expect(shipped().sources).toHaveLength(16);
  });

  it('marks exactly the three per-request volatile sources pending', () => {
    expect(
      shipped().sources
        .filter((s) => s.status === 'pending')
        .map((s) => s.id)
        .sort(),
    ).toEqual(['arena-leaderboard', 'openrouter-sitemap', 'xai-llms-txt']);
  });

  it('puts only openrouter-models in the fast tier', () => {
    expect(sourcesForTier(shipped(), 'fast').map((s) => s.id)).toEqual(['openrouter-models']);
  });

  it('never hands a pending source to the collector', () => {
    const fetched = [
      ...activeSourcesForTier(shipped(), 'fast'),
      ...activeSourcesForTier(shipped(), 'daily'),
    ].map((s) => s.id);
    expect(fetched).toHaveLength(13);
    for (const id of ['arena-leaderboard', 'openrouter-sitemap', 'xai-llms-txt']) {
      expect(fetched).not.toContain(id);
    }
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
    expect(fromSpec.size).toBe(16);

    const fromTable = new Map(shipped().sources.map((s) => [s.id, s.url]));
    expect(Object.fromEntries(fromTable)).toEqual(Object.fromEntries(fromSpec));
  });

  it('justifies every non default predicate in notes', () => {
    const exceptional = shipped().sources.filter((s) => s.predicate.type !== 'bytes');
    expect(exceptional.map((s) => s.id).sort()).toEqual([
      'arena-leaderboard',
      'openrouter-sitemap',
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
      // id, so naming the extractor is cheap to satisfy by accident. Naming
      // the default that was rejected is not: it forces the note to say why
      // bytes is wrong here.
      expect(s.notes, `${s.id} notes`).toContain('bytes');
    }
  });

  it('stores every response at raw/<id>/response.<ext>', () => {
    for (const s of shipped().sources) {
      expect(s.path, s.id).toMatch(new RegExp(`^raw/${s.id}/response\\.[a-z]+$`));
    }
  });

  it('gives every text source a canary and every other source none', () => {
    for (const s of shipped().sources) {
      // The exact placeholder, not merely a truthy string. A wrong but
      // plausible canary written now would fail health silently once Task 11
      // wires the check in, and the guard that catches a SURVIVING placeholder
      // cannot see one that was replaced early with a guess.
      if (s.contentType === 'text')
        expect(s.invariants.canary, s.id).toBe('__CANARY_PLACEHOLDER_TASK_6__');
      else expect(s.invariants.canary, s.id).toBeNull();
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
    });
  });

  it('gives every xml and html source an expectedRoot', () => {
    // Without it, spec health rule 2 collapses to "parses as XML", which is
    // exactly the cohere feed that parses happily with root=html.
    for (const s of shipped().sources) {
      if (s.contentType === 'xml' || s.contentType === 'html') {
        expect(s.expectedRoot, s.id).toBeTruthy();
      }
    }
  });

  it('gives every json source a requiredKeyPath', () => {
    // Same reasoning one type over: valid JSON of the wrong shape is still
    // valid JSON, so the parse alone proves nothing.
    for (const s of shipped().sources) {
      if (s.contentType === 'json') expect(s.invariants.requiredKeyPath, s.id).toBeTruthy();
    }
  });
});
