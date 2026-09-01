import { describe, it, expect } from 'vitest';
import { assertPageNamesSafe, buildApi, pageFileName, typeSlug } from '../src/api/build.js';
import { PAGE_SIZE } from '../src/api/records.js';
import { deriveEvents } from '../src/derive/events.js';
import { buildFeed } from '../src/derive/feed.js';
import { buildThreads } from '../src/derive/threads.js';
import { typePagePath } from '../src/site/render.js';
import { textContents } from '../src/site/build.js';
import { catalog, change, ORIGIN } from './derive-fixtures.js';
import type { SiteFile } from '../src/site/build.js';

const SITE = 'https://example.test/archive';
const REPO = 'https://github.com/MaxwellBrohm/llm-catalog-archive';

const empty = { feed: [], threads: { threads: [], held: [] }, refusals: [], ledger: [], changes: [], siteUrl: SITE, repoUrl: REPO };

const doc = (files: SiteFile[], rel: string): Record<string, unknown> => {
  const hit = files.find((f) => f.path === `api/v1/${rel}`);
  if (hit === undefined) throw new Error(`no file at api/v1/${rel}`);
  return JSON.parse(textContents(hit)) as Record<string, unknown>;
};

/** One catalogue change adding `n` models, so the stream can be paginated. */
function addModels(n: number) {
  const base = [{ id: 'anthropic/claude-opus-5' }];
  const after = [...base, ...Array.from({ length: n }, (_, i) => ({ id: `vendor/model-${String(i).padStart(4, '0')}` }))];
  return change({ before: catalog(base), after: catalog(after) });
}

function built(n: number): SiteFile[] {
  const changes = [addModels(n)];
  const feed = buildFeed(deriveEvents(changes), []);
  return buildApi({ ...empty, feed, threads: buildThreads(feed), changes });
}

describe('typeSlug', () => {
  it('folds an event type the same way the HTML page path does', () => {
    expect(`type/${typeSlug('model_added')}.html`).toBe(typePagePath('model_added'));
  });

  it('folds a leak type the same way the HTML page path does', () => {
    expect(`type/${typeSlug('codename_unmasked')}.html`).toBe(typePagePath('codename_unmasked'));
  });
});

describe('pageFileName', () => {
  it('names page two page-2.json', () => {
    expect(pageFileName(2)).toBe('page-2.json');
  });
});

describe('assertPageNamesSafe', () => {
  it('accepts the types this project actually derives', () => {
    expect(() => assertPageNamesSafe(['model_added', 'codename_unmasked'])).not.toThrow();
  });

  it('refuses a type whose file name would take a pagination address', () => {
    expect(() => assertPageNamesSafe(['page_2' as never])).toThrow(
      'event type page_2 collides with the pagination file names in events/',
    );
  });
});

/**
 * A category that vanished when it was empty would make a quiet week and a
 * broken extractor return the same 404. The HTML pages already refuse that; the
 * API has to refuse it too or the CLI reintroduces the ambiguity.
 */
describe('the file set for an archive holding nothing', () => {
  const files = buildApi(empty).map((f) => f.path);

  it('emits exactly these files', () => {
    expect(files).toEqual([
      'api/v1/events.json',
      'api/v1/events/model-added.json',
      'api/v1/events/model-removed.json',
      'api/v1/events/price-changed.json',
      'api/v1/events/context-changed.json',
      'api/v1/events/expiration-set.json',
      'api/v1/events/alias-retargeted.json',
      'api/v1/events/retirement-floor.json',
      'api/v1/events/doc-added.json',
      'api/v1/events/doc-moved.json',
      'api/v1/events/doc-removed.json',
      'api/v1/events/post-listed.json',
      'api/v1/events/post-published.json',
      'api/v1/events/incident-opened.json',
      'api/v1/events/codename-entered.json',
      'api/v1/events/codename-unmasked.json',
      'api/v1/events/upstream-pr-opened.json',
      'api/v1/events/upstream-pr-merged.json',
      'api/v1/events/stealth-listing.json',
      'api/v1/events/expiration-scheduled.json',
      'api/v1/models.json',
      'api/v1/retirements.json',
      'api/v1/leaks.json',
      'api/v1/accuracy.json',
      'api/v1/index.json',
    ]);
  });

  it('emits no lab file, because an empty lab file claims we watch that lab', () => {
    expect(files.filter((p) => p.startsWith('api/v1/labs/'))).toEqual([]);
  });

  it('emits page one of the stream even with nothing on it', () => {
    expect(doc(buildApi(empty), 'events.json')['total']).toBe(0);
  });

  it('reports one page rather than zero pages for an empty stream', () => {
    expect(doc(buildApi(empty), 'events.json')['pages']).toBe(1);
  });

  it('publishes a null catalogue source rather than an empty model list read as OpenRouter listing nothing', () => {
    expect(doc(buildApi(empty), 'models.json')['source']).toBeNull();
  });

  it('publishes a null retirements source when no lifecycle table has been captured', () => {
    expect(doc(buildApi(empty), 'retirements.json')['source']).toBeNull();
  });
});

describe('pagination', () => {
  const files = built(PAGE_SIZE + 1);
  const page1 = doc(files, 'events.json');
  // Looked up lazily. Reading page two in the describe body would make a
  // generator that stopped paginating fail COLLECTION rather than an
  // assertion, and a test that cannot run is not a test that caught anything.
  const page2 = (): Record<string, unknown> => doc(files, 'events/page-2.json');

  it('splits a stream one longer than a page into two pages', () => {
    expect(page1['pages']).toBe(2);
  });

  it('writes a second file for the second page', () => {
    expect(files.map((f) => f.path)).toContain('api/v1/events/page-2.json');
  });

  it('puts exactly one page of items on page one', () => {
    expect((page1['items'] as unknown[]).length).toBe(PAGE_SIZE);
  });

  it('puts the remainder on page two', () => {
    expect((page2()['items'] as unknown[]).length).toBe(1);
  });

  it('reports the same total on every page', () => {
    expect([page1['total'], page2()['total']]).toEqual([PAGE_SIZE + 1, PAGE_SIZE + 1]);
  });

  it('points page one at page two', () => {
    expect(page1['next']).toBe('https://example.test/archive/api/v1/events/page-2.json');
  });

  it('leaves the last page pointing nowhere rather than at itself', () => {
    expect(page2()['next']).toBeNull();
  });

  it('lists every page address so a client can jump rather than walk', () => {
    expect(page1['page_urls']).toEqual([
      'https://example.test/archive/api/v1/events.json',
      'https://example.test/archive/api/v1/events/page-2.json',
    ]);
  });

  it('does not repeat an item across the two pages', () => {
    const ids = [...(page1['items'] as { id: string }[]), ...(page2()['items'] as { id: string }[])].map((i) => i.id);
    expect(new Set(ids).size).toBe(PAGE_SIZE + 1);
  });

  it('emits no page-2 file for a stream that fits on one page', () => {
    expect(built(2).map((f) => f.path)).not.toContain('api/v1/events/page-2.json');
  });
});

describe('the micro-category files', () => {
  const files = built(3);

  it('files every addition under model-added', () => {
    expect(doc(files, 'events/model-added.json')['total']).toBe(3);
  });

  it('leaves an unrelated category at zero rather than absent', () => {
    expect(doc(files, 'events/price-changed.json')['total']).toBe(0);
  });

  it('names the type it holds so a consumer need not parse the filename', () => {
    expect(doc(files, 'events/model-added.json')['type']).toBe('model_added');
  });
});

describe('the lab files', () => {
  const changes = [
    change({
      before: catalog([{ id: 'anthropic/claude-opus-5' }]),
      after: catalog([{ id: 'anthropic/claude-opus-5' }, { id: 'anthropic/claude-fable-5' }, { id: 'aion-labs/aion-1.0' }]),
    }),
  ];
  const feed = buildFeed(deriveEvents(changes), []);
  const files = buildApi({ ...empty, feed, threads: buildThreads(feed), changes });

  it('emits a file for a lab the vendor table knows', () => {
    expect(files.map((f) => f.path)).toContain('api/v1/labs/anthropic.json');
  });

  it('emits no file for a vendor prefix that is not a lab in the table', () => {
    expect(files.map((f) => f.path).filter((p) => p.startsWith('api/v1/labs/'))).toEqual([
      'api/v1/labs/anthropic.json',
    ]);
  });

  it('holds only the items that attach to that lab', () => {
    expect(doc(files, 'labs/anthropic.json')['total']).toBe(1);
  });
});

describe('the per-model files', () => {
  const changes = [addModels(1)];
  const feed = buildFeed(deriveEvents(changes), []);
  const threads = buildThreads(feed);
  const files = buildApi({ ...empty, feed, threads, changes });

  it('emits one file per model thread, at the thread slug', () => {
    expect(files.map((f) => f.path)).toContain('api/v1/models/model-openrouter-vendor-model-0000.json');
  });

  it('emits no file for a lab thread under the models directory', () => {
    expect(files.map((f) => f.path).filter((p) => p.startsWith('api/v1/models/'))).toEqual([
      'api/v1/models/model-openrouter-vendor-model-0000.json',
    ]);
  });

  it('carries the model entity the thread was built from', () => {
    expect(doc(files, 'models/model-openrouter-vendor-model-0000.json')['entity']).toEqual({
      kind: 'model',
      id: 'model/openrouter:vendor/model-0000',
      label: 'vendor/model-0000',
      slug: 'model-openrouter-vendor-model-0000',
    });
  });

  /**
   * NOT named `first_seen`. The spec forbids that name outright, and the value
   * is not the catalogue's first-seen date: it is the origin_date of the
   * earliest EVENT on the thread, which for most models is a price change.
   */
  it('carries the oldest item stamp under a name that says what it is', () => {
    expect(doc(files, 'models/model-openrouter-vendor-model-0000.json')['first_seen']).toBeUndefined();
    expect(doc(files, 'models/model-openrouter-vendor-model-0000.json')['first_event_at']).toEqual({
      value: ORIGIN.iso,
      field: 'origin_date',
    });
  });
});

describe('the leaks desk', () => {
  it('publishes a tier breakdown with every tier present even at zero', () => {
    expect(doc(buildApi(empty), 'leaks.json')['by_tier']).toEqual({
      'confirmed-artifact': 0,
      credible: 0,
      unconfirmed: 0,
    });
  });

  it('publishes the refusals beside the items rather than only a count', () => {
    const files = buildApi({
      ...empty,
      refusals: [
        {
          sourceId: 'arena-leaderboard',
          sha: 'a'.repeat(40),
          path: 'raw/arena-leaderboard/response.json',
          stamp: ORIGIN,
          reason: '12 rows parsed, below the floor of 400',
        },
      ],
    });
    expect(doc(files, 'leaks.json')['refusals']).toEqual([
      {
        source_id: 'arena-leaderboard',
        sha: 'a'.repeat(40),
        path: 'raw/arena-leaderboard/response.json',
        artifact: `${REPO}/blob/${'a'.repeat(40)}/raw/arena-leaderboard/response.json`,
        commit: `${REPO}/commit/${'a'.repeat(40)}`,
        timestamp: { value: ORIGIN.iso, field: 'origin_date' },
        reason: '12 rows parsed, below the floor of 400',
      },
    ]);
  });
});

describe('the accuracy ledger', () => {
  it('publishes a null accuracy for a ledger with nothing resolved', () => {
    expect((doc(buildApi(empty), 'accuracy.json')['scorecard'] as Record<string, unknown>)['accuracy_pct']).toBeNull();
  });

  it('publishes the claims in the order the append-only file holds them', () => {
    const files = buildApi({
      ...empty,
      ledger: [
        { id: 'b', claim: 'second', tier: 'unconfirmed', recorded: '2026-08-02', artifact: null, outcome: 'open', resolved: null, resolutionNote: null },
        { id: 'a', claim: 'first', tier: 'credible', recorded: '2026-08-01', artifact: null, outcome: 'open', resolved: null, resolutionNote: null },
      ],
    });
    expect((doc(files, 'accuracy.json')['claims'] as { id: string }[]).map((c) => c.id)).toEqual(['b', 'a']);
  });
});

/**
 * The directory is what lets a client tell "this lab has nothing in the
 * archive" from "the deploy is broken". Two 404s are otherwise identical.
 */
describe('index.json', () => {
  const changes = [addModels(2)];
  const feed = buildFeed(deriveEvents(changes), []);
  const files = buildApi({ ...empty, feed, threads: buildThreads(feed), changes });
  const index = doc(files, 'index.json');

  it('lists every micro-category with its literal address', () => {
    expect((index['types'] as { type: string }[]).map((t) => t.type)).toEqual([
      'model_added',
      'model_removed',
      'price_changed',
      'context_changed',
      'expiration_set',
      'alias_retargeted',
      'retirement_floor',
      'doc_added',
      'doc_moved',
      'doc_removed',
      'post_listed',
      'post_published',
      'incident_opened',
      'codename_entered',
      'codename_unmasked',
      'upstream_pr_opened',
      'upstream_pr_merged',
      'stealth_listing',
      'expiration_scheduled',
    ]);
  });

  it('gives each listed category the address the generator actually emitted', () => {
    expect((index['types'] as { url: string }[])[0]!.url).toBe(
      'https://example.test/archive/api/v1/events/model-added.json',
    );
  });

  it('counts the items in the stream', () => {
    expect((index['counts'] as Record<string, number>)['items']).toBe(2);
  });

  it('counts the models in the current catalogue state', () => {
    expect((index['counts'] as Record<string, number>)['models']).toBe(3);
  });

  it('records how many captures of each source the archive holds', () => {
    expect((index['sources'] as { id: string; captures: number }[])[0]).toMatchObject({
      id: 'openrouter-models',
      captures: 1,
    });
  });

  it('publishes a null precision for a source captured once', () => {
    expect((index['sources'] as { precision_seconds: number | null }[])[0]!.precision_seconds).toBeNull();
  });

  it('states that no key is required, because that is the whole pitch', () => {
    expect((index['terms'] as Record<string, unknown>)['api_key']).toBe(false);
  });

  it('points at its own documentation page', () => {
    expect(index['docs']).toBe('https://example.test/archive/api.html');
  });
});

describe('the generated bytes', () => {
  it('ends every file with a newline, so a shell reading one does not run lines together', () => {
    expect(buildApi(empty).every((f) => textContents(f).endsWith('\n'))).toBe(true);
  });

  it('indents, because the product is that a person can read it with curl alone', () => {
    expect(textContents(buildApi(empty)[0]!).startsWith('{\n  "api_version"')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// the published copy, and the arms the first pass left unasserted
// ---------------------------------------------------------------------------

import { deriveLeaks } from '../src/derive/leaks.js';
import { deprecationsDoc, replacementTable } from './derive-fixtures.js';

/** A catalogue change that both adds a model and schedules an expiration. */
const mixedChange = change({
  before: catalog([{ id: 'moonshotai/kimi-k2.5' }]),
  after: catalog([
    { id: 'moonshotai/kimi-k2.5', expiration_date: '2026-12-01T00:00:00Z' },
    { id: 'anthropic/claude-opus-5' },
  ]),
});

const lifecycleDoc = [
  deprecationsDoc([['claude-opus-4-1-20250805', 'Deprecated', 'August 5, 2025', 'August 5, 2026']]),
  replacementTable([['August 5, 2026', 'claude-opus-4-1-20250805', 'claude-opus-4-8']]),
].join('\n');

const deprecationsChange = change({
  sourceId: 'anthropic-deprecations',
  path: 'raw/anthropic-deprecations/response.md',
  tier: 'daily',
  before: deprecationsDoc([['claude-opus-4-1-20250805', 'Deprecated', 'August 5, 2025', 'N/A']]),
  after: lifecycleDoc,
});

const mixedChanges = [mixedChange, deprecationsChange];
const mixedFeed = buildFeed(deriveEvents(mixedChanges), deriveLeaks(mixedChanges));
const mixed = buildApi({
  feed: mixedFeed,
  threads: buildThreads(mixedFeed),
  refusals: [],
  ledger: [],
  changes: mixedChanges,
  siteUrl: SITE,
  repoUrl: REPO,
});

describe('the stream over both derivations', () => {
  it('counts the event items and the leak items apart', () => {
    expect(doc(mixed, 'index.json')['counts']).toMatchObject({ events: 3, leaks: 1, items: 4 });
  });

  it('puts only the leak items on the desk', () => {
    expect(doc(mixed, 'leaks.json')['total']).toBe(1);
  });

  it('counts the desk items under the tier the derivation assigned', () => {
    expect(doc(mixed, 'leaks.json')['by_tier']).toEqual({
      'confirmed-artifact': 1,
      credible: 0,
      unconfirmed: 0,
    });
  });

  it('points the desk at the ledger that scores it', () => {
    expect(doc(mixed, 'leaks.json')['accuracy']).toBe('https://example.test/archive/api/v1/accuracy.json');
  });
});

describe('the current-state documents when the archive holds captures', () => {
  it('publishes the catalogue row count rather than a null total', () => {
    expect(doc(mixed, 'models.json')['total']).toBe(2);
  });

  it('publishes the catalogue rows themselves', () => {
    expect((doc(mixed, 'models.json')['models'] as { id: string }[]).map((m) => m.id)).toEqual([
      'anthropic/claude-opus-5',
      'moonshotai/kimi-k2.5',
    ]);
  });

  it('publishes the retirement rows read from the lifecycle table', () => {
    expect((doc(mixed, 'retirements.json')['retirements'] as { model: string }[]).map((r) => r.model)).toEqual([
      'claude-opus-4-1-20250805',
    ]);
  });

  it('publishes the retirement row count rather than a null total', () => {
    expect(doc(mixed, 'retirements.json')['total']).toBe(1);
  });

  it('carries the provenance of the lifecycle bytes the floors were read from', () => {
    expect((doc(mixed, 'retirements.json')['source'] as Record<string, string>)['path']).toBe(
      'raw/anthropic-deprecations/response.md',
    );
  });
});

describe('the per-model file', () => {
  it('links the human-readable thread beside the machine records', () => {
    expect(doc(mixed, 'models/model-openrouter-anthropic-claude-opus-5.json')['thread']).toBe(
      'https://example.test/archive/threads/model-openrouter-anthropic-claude-opus-5.html',
    );
  });
});

describe('the base URLs the generator was given', () => {
  it('collapses every trailing slash on the site URL, not only the last', () => {
    const files = buildApi({ ...empty, siteUrl: `${SITE}//` });
    expect(doc(files, 'index.json')['site']).toBe(SITE);
  });

  it('builds artifact permalinks against the repository URL it was given', () => {
    const changes = [mixedChange];
    const feed = buildFeed(deriveEvents(changes), []);
    const files = buildApi({ ...empty, feed, threads: buildThreads(feed), changes, repoUrl: 'https://example.test/repo' });
    expect((doc(files, 'events.json')['items'] as { artifact: string }[])[0]!.artifact).toBe(
      'https://example.test/repo/blob/a69a068319de9dc9a7ab1049b411a562a026e7d5/raw/openrouter-models/response.json',
    );
  });
});

describe('pagination writes each page exactly once', () => {
  it('writes page one only to events.json and page two only to its own file', () => {
    expect(built(PAGE_SIZE + 1).map((f) => f.path).filter((p) => p.startsWith('api/v1/events'))).toContain(
      'api/v1/events/page-2.json',
    );
  });

  it('does not write page two over page one', () => {
    const paths = built(PAGE_SIZE + 1).map((f) => f.path);
    expect(paths.filter((p) => p === 'api/v1/events.json').length).toBe(1);
  });

  it('puts the newest items on page one, so the front door is the front door', () => {
    const page1 = doc(built(PAGE_SIZE + 1), 'events.json');
    const page2 = doc(built(PAGE_SIZE + 1), 'events/page-2.json');
    const firstOfTwo = (page2['items'] as { id: string }[])[0]!.id;
    expect((page1['items'] as { id: string }[]).map((i) => i.id)).not.toContain(firstOfTwo);
  });
});

/**
 * A source's measured precision travels with every item derived from it. The
 * live archive has no source inside a day today, so this is the arm nothing
 * else in the suite reaches.
 */
describe('per-item precision', () => {
  it('carries the measured gap rather than the unbounded default', () => {
    const first = change({ sha: '1'.repeat(40), kind: 'added', before: null, after: catalog([{ id: 'a/b' }]), observedAt: '2026-08-28T00:00:00.000Z' });
    const second = change({
      sha: '2'.repeat(40),
      before: catalog([{ id: 'a/b' }]),
      after: catalog([{ id: 'a/b' }, { id: 'c/d' }]),
      observedAt: '2026-08-28T12:00:00.000Z',
    });
    const changes = [second, first];
    const feed = buildFeed(deriveEvents(changes), []);
    const files = buildApi({ ...empty, feed, threads: buildThreads(feed), changes });
    expect((doc(files, 'events.json')['items'] as { precision_seconds: number }[])[0]!.precision_seconds).toBe(43200);
  });
});

describe('the source directory in index.json', () => {
  const sources = doc(mixed, 'index.json')['sources'] as Record<string, unknown>[];

  it('sorts the sources by id rather than by the order git walked them', () => {
    expect(sources.map((s) => s['id'])).toEqual(['anthropic-deprecations', 'openrouter-models']);
  });

  it('links the newest stored artifact for each source', () => {
    expect(sources[0]!['latest_artifact']).toBe(
      `${REPO}/blob/a69a068319de9dc9a7ab1049b411a562a026e7d5/raw/anthropic-deprecations/response.md`,
    );
  });

  it('links the commit beside the artifact', () => {
    expect(sources[0]!['latest_commit']).toBe(`${REPO}/commit/a69a068319de9dc9a7ab1049b411a562a026e7d5`);
  });

  it('labels the newest timestamp with the field it came from', () => {
    expect(sources[0]!['latest_timestamp']).toEqual({ value: '2026-08-28T08:08:22.000Z', field: 'origin_date' });
  });

  it('counts zero captures for a source whose stored bytes carry no sidecar at all', () => {
    const unstamped = change({ sourceId: 'groq-llms-full-txt', path: 'raw/groq-llms-full-txt/response.txt', stamp: null, observedAt: null, before: 'a', after: 'b' });
    const files = buildApi({ ...empty, changes: [unstamped] });
    expect((doc(files, 'index.json')['sources'] as Record<string, unknown>[])[0]!['captures']).toBe(0);
  });
});

/**
 * The published copy, asserted exactly. These strings are the API's own claims
 * about what it does and does not mean, and the project's whole discipline is
 * that published copy is load-bearing rather than decorative.
 */
describe('the copy index.json publishes', () => {
  const index = doc(buildApi(empty), 'index.json');

  it('names itself', () => {
    expect(index['name']).toBe('llm-catalog-archive');
  });

  it('describes itself as an archive-backed API rather than as a data feed', () => {
    expect(index['description']).toBe(
      'A keyless static JSON API over a git archive of AI provider catalogs, documentation indexes and lifecycle tables. Every record links the raw artifact it was derived from, at the full sha of the commit that changed it.',
    );
  });

  it('publishes the terms exactly, because the terms are the pitch', () => {
    expect(index['terms']).toEqual({
      auth: 'none',
      api_key: false,
      signup: false,
      rate_limit: 'none imposed by this project; GitHub Pages fair use applies',
      cors: 'served by GitHub Pages, which sends access-control-allow-origin: *',
      cost: 'free',
    });
  });

  it('publishes the five parsing rules a consumer has to know', () => {
    expect(index['rules']).toEqual([
      'Every record carries the artifact permalink at the full sha of the commit that changed it, never HEAD.',
      "Every timestamp is an object naming the field it came from: origin_date is the provider's own generation time, observed_at is this runner's clock at request completion.",
      'No date is emitted at a resolution finer than precision_seconds allows. first_seen_in_catalog_at is null wherever the measured worst-case error for that source is wider than a day.',
      'precision_seconds is null when unbounded, meaning the archive holds fewer than two captures of that source. Null is not zero error.',
      'Every sentence names an artifact as its subject. No record here says why a value changed.',
    ]);
  });

  it('publishes every endpoint address, templates included', () => {
    expect(index['endpoints']).toEqual({
      index: 'https://example.test/archive/api/v1/index.json',
      models: 'https://example.test/archive/api/v1/models.json',
      model: 'https://example.test/archive/api/v1/models/{slug}.json',
      events: 'https://example.test/archive/api/v1/events.json',
      events_page: 'https://example.test/archive/api/v1/events/page-{n}.json',
      events_by_type: 'https://example.test/archive/api/v1/events/{type}.json',
      lab: 'https://example.test/archive/api/v1/labs/{lab}.json',
      leaks: 'https://example.test/archive/api/v1/leaks.json',
      accuracy: 'https://example.test/archive/api/v1/accuracy.json',
      retirements: 'https://example.test/archive/api/v1/retirements.json',
    });
  });

  it('lists the labs that exist, so an absent lab is distinguishable from a broken deploy', () => {
    expect(doc(mixed, 'index.json')['labs']).toEqual([
      { lab: 'moonshot', url: 'https://example.test/archive/api/v1/labs/moonshot.json' },
      { lab: 'anthropic', url: 'https://example.test/archive/api/v1/labs/anthropic.json' },
    ]);
  });
});

describe('the copy the other documents publish', () => {
  it('states on the retirements document that the two namespaces are not joined', () => {
    expect(doc(buildApi(empty), 'retirements.json')['namespace_note']).toBe(
      "Model names here are the provider's own API model names, read from that provider's own document. They are not OpenRouter catalog ids and are not joined to them: the two are different strings issued by different parties, and deciding they name the same model is a judgement this archive does not make.",
    );
  });

  it('states on the desk that the tier is about the artifact, not about confidence', () => {
    expect(doc(buildApi(empty), 'leaks.json')['tier_note']).toBe(
      'The tier is about the artifact, not about confidence. confirmed-artifact means a publicly observable artifact exists and is linked at the sha below.',
    );
  });

  it('states on the ledger why a null accuracy is not a zero', () => {
    expect(doc(buildApi(empty), 'accuracy.json')['accuracy_note']).toBe(
      'accuracy_pct is confirmed over resolved. It is null, never zero and never a hundred, while nothing has resolved: a ledger with no resolved claims has no accuracy.',
    );
  });
});

/**
 * THE NAMES THE SPEC FORBIDS, ENFORCED OVER EVERY EMITTED DOCUMENT.
 *
 * docs/superpowers/specs/2026-08-26-collector-and-archive-design.md section 10:
 * "Not `launched_at`, not `released_at`, not bare `first_seen`. A field named
 * `launched_at` will eventually be rendered as a launch date by something
 * downstream."
 *
 * The API shipped `first_seen` on all 116 model documents regardless, so the
 * rule needed a test rather than a sentence. This walks every key of every
 * emitted JSON document rather than checking one endpoint, because the next
 * violation will be somewhere else.
 */
describe('no emitted document uses a forbidden date field name', () => {
  const FORBIDDEN = ['first_seen', 'launched_at', 'released_at', 'release_date'];

  /** Every key at every depth of a parsed document. */
  function keysOf(value: unknown, into: Set<string> = new Set()): Set<string> {
    if (Array.isArray(value)) {
      for (const v of value) keysOf(v, into);
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        into.add(k);
        keysOf(v, into);
      }
    }
    return into;
  }

  const changes = [change({ before: catalog([{ id: 'vendor/model-0000' }]), after: catalog([{ id: 'vendor/model-0000' }, { id: 'vendor/model-0001' }]) })];
  const feed = buildFeed(deriveEvents(changes), []);
  const built = buildApi({ feed, threads: buildThreads(feed), refusals: [], ledger: [], changes });

  it('emits documents to check, so this cannot pass by walking nothing', () => {
    expect(built.length).toBeGreaterThan(10);
  });

  it('uses none of the forbidden names anywhere, at any depth', () => {
    const offenders: string[] = [];
    for (const f of built) {
      if (!f.path.endsWith('.json')) continue;
      for (const key of keysOf(JSON.parse(textContents(f)))) {
        if (FORBIDDEN.includes(key)) offenders.push(`${f.path}: ${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /** first_seen_in_catalog_at is the REQUIRED name and must not be caught by the rule above. */
  it('still permits the one first-seen name the spec asks for by name', () => {
    const all = new Set<string>();
    for (const f of built) {
      if (!f.path.endsWith('.json')) continue;
      for (const k of keysOf(JSON.parse(textContents(f)))) all.add(k);
    }
    expect(all.has('first_seen_in_catalog_at')).toBe(true);
  });
});
