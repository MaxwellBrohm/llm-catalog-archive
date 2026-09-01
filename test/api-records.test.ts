import { describe, it, expect } from 'vitest';
import {
  API_PREFIX,
  API_VERSION,
  apiUrl,
  currentModels,
  currentRetirements,
  dayIfPermitted,
  entityRecord,
  eventFields,
  firstAddedByModel,
  itemCountByEntity,
  itemRecord,
  newestChangeOf,
  precisionView,
  scorecardRecord,
  siteUrlFor,
  subjectOf,
  timestampView,
} from '../src/api/records.js';
import { deriveEvents, type ContentChange } from '../src/derive/events.js';
import { buildFeed, feedItemFromEvent } from '../src/derive/feed.js';
import { scoreLedger } from '../src/site/ledger.js';
import { catalog, change, deprecationsDoc, replacementTable, ORIGIN, SHA } from './derive-fixtures.js';

const SITE = 'https://maxwellbrohm.github.io/llm-catalog-archive';
const REPO = 'https://github.com/MaxwellBrohm/llm-catalog-archive';

/** One catalogue change whose only difference is a context_length. */
const contextChange = change({
  before: catalog([{ id: 'anthropic/claude-opus-5', context_length: 200000 }]),
  after: catalog([{ id: 'anthropic/claude-opus-5', context_length: 100000 }]),
});

const contextItem = buildFeed(deriveEvents([contextChange]), [])[0]!;

describe('the version segment', () => {
  it('serves every file under api/v1', () => {
    expect(API_PREFIX).toBe('api/v1');
  });

  it('names the version v1', () => {
    expect(API_VERSION).toBe('v1');
  });

  it('builds an absolute endpoint URL under that prefix', () => {
    expect(apiUrl(SITE, 'models.json')).toBe(
      'https://maxwellbrohm.github.io/llm-catalog-archive/api/v1/models.json',
    );
  });

  it('does not double the separator when the base carries a trailing slash', () => {
    expect(apiUrl(`${SITE}/`, 'models.json')).toBe(
      'https://maxwellbrohm.github.io/llm-catalog-archive/api/v1/models.json',
    );
  });

  it('builds a site URL outside the api prefix', () => {
    expect(siteUrlFor(SITE, 'threads/lab-anthropic.html')).toBe(
      'https://maxwellbrohm.github.io/llm-catalog-archive/threads/lab-anthropic.html',
    );
  });
});

/**
 * Section 9: origin_date is when the provider generated the bytes and
 * observed_at is when this runner saw them, and they are not interchangeable. A
 * bare ISO string in a JSON body is a claim that they are.
 */
describe('timestampView', () => {
  it('labels an origin stamp as origin_date', () => {
    expect(timestampView({ iso: '2026-08-28T08:08:22.000Z', kind: 'origin' })).toEqual({
      value: '2026-08-28T08:08:22.000Z',
      field: 'origin_date',
    });
  });

  it('labels an observed stamp as observed_at', () => {
    expect(timestampView({ iso: '2026-08-28T11:23:40.960Z', kind: 'observed' })).toEqual({
      value: '2026-08-28T11:23:40.960Z',
      field: 'observed_at',
    });
  });

  it('emits null rather than an unlabelled string when there is no stamp', () => {
    expect(timestampView(null)).toBeNull();
  });
});

/**
 * JSON.stringify(Infinity) is the string `null` with nothing attached, and a
 * consumer reading a bare null there would take it for "no error recorded".
 */
describe('precisionView', () => {
  it('publishes a measured value as an integer of seconds', () => {
    expect(precisionView(348766).precision_seconds).toBe(348766);
  });

  it('publishes null for an unbounded precision', () => {
    expect(precisionView(Infinity).precision_seconds).toBeNull();
  });

  it('says why the unbounded case is unbounded rather than leaving a bare null', () => {
    expect(precisionView(Infinity).precision_note).toBe(
      'unbounded: the archive holds fewer than two captures of this source, so no gap between captures bounds the error',
    );
  });

  it('says what a measured number was measured from', () => {
    expect(precisionView(900).precision_note).toBe(
      'worst-case first-seen error in seconds, measured as the largest gap between consecutive accepted captures of this source, floored at its configured poll interval',
    );
  });
});

/**
 * Section 10.1: no date at a resolution finer than precision_seconds allows.
 * This is the rule that makes the field load-bearing rather than decorative.
 */
describe('dayIfPermitted', () => {
  it('prints the UTC day when the measured error is exactly one day', () => {
    expect(dayIfPermitted({ iso: '2026-08-28T08:08:22.000Z', kind: 'origin' }, 86400)).toBe('2026-08-28');
  });

  it('refuses the day when the measured error is one second wider than a day', () => {
    expect(dayIfPermitted({ iso: '2026-08-28T08:08:22.000Z', kind: 'origin' }, 86401)).toBeNull();
  });

  it('refuses the day when the precision is unbounded', () => {
    expect(dayIfPermitted({ iso: '2026-08-28T08:08:22.000Z', kind: 'origin' }, Infinity)).toBeNull();
  });

  it('emits null when there is no stamp to render at any resolution', () => {
    expect(dayIfPermitted(null, 900)).toBeNull();
  });
});

describe('entityRecord', () => {
  it('carries the thread page a human can open for that entity', () => {
    expect(entityRecord({ kind: 'lab', id: 'lab/anthropic', label: 'anthropic' }, SITE)).toEqual({
      kind: 'lab',
      id: 'lab/anthropic',
      label: 'anthropic',
      slug: 'lab-anthropic',
      thread: 'https://maxwellbrohm.github.io/llm-catalog-archive/threads/lab-anthropic.html',
    });
  });
});

describe('subjectOf', () => {
  it('is the catalogue id for a context change', () => {
    expect(subjectOf(contextItem)).toBe('anthropic/claude-opus-5');
  });

  it('is the alias for an alias retargeting', () => {
    const item = feedItemFromEvent({
      id: `${SHA}:alias_retargeted:~anthropic/claude-latest`,
      type: 'alias_retargeted',
      sha: SHA,
      sourceId: 'openrouter-models',
      path: 'raw/openrouter-models/response.json',
      stamp: ORIGIN,
      entities: [],
      held: true,
      alias: '~anthropic/claude-latest',
      from: 'anthropic/claude-opus-4.8',
      to: 'anthropic/claude-opus-5',
    });
    expect(subjectOf(item)).toBe('~anthropic/claude-latest');
  });

  it('is the URL for a documentation entry', () => {
    const item = feedItemFromEvent({
      id: `${SHA}:doc_added:https://x/a.md`,
      type: 'doc_added',
      sha: SHA,
      sourceId: 'openai-llms-txt',
      path: 'raw/openai-llms-txt/response.txt',
      stamp: ORIGIN,
      entities: [],
      held: true,
      provider: 'openai',
      title: 'Quickstart',
      url: 'https://x/a.md',
    });
    expect(subjectOf(item)).toBe('https://x/a.md');
  });
});

/**
 * The pair is never optional. OpenRouter's context_length is the maximum across
 * the providers currently routing a model, so publishing it alone invites the
 * inference section 10.1 forbids.
 */
describe('eventFields for a context change', () => {
  it('carries both sides of the catalogue value and both sides of top_provider', () => {
    expect(eventFields(contextItem.event!, 900)).toEqual({
      model_id: 'anthropic/claude-opus-5',
      from: 200000,
      to: 100000,
      top_provider_from: 200000,
      top_provider_to: 100000,
    });
  });
});

describe('eventFields for a model addition', () => {
  const added = buildFeed(
    deriveEvents([
      change({
        before: catalog([{ id: 'anthropic/claude-opus-5' }]),
        after: catalog([{ id: 'anthropic/claude-opus-5' }, { id: 'anthropic/claude-fable-5', created: 1787752741 }]),
      }),
    ]),
    [],
  )[0]!;

  it('publishes the catalogue created integer verbatim', () => {
    expect(eventFields(added.event!, 86400)['created']).toBe(1787752741);
  });

  it('publishes a first-seen day when the source earns day resolution', () => {
    expect(eventFields(added.event!, 86400)['first_seen_in_catalog_at']).toBe('2026-08-28');
  });

  it('publishes null for first-seen when the measured error is wider than a day', () => {
    expect(eventFields(added.event!, 348766)['first_seen_in_catalog_at']).toBeNull();
  });
});

describe('itemRecord', () => {
  const record = itemRecord(contextItem, 348766, SITE, REPO);

  it('links the artifact at the full sha of the commit that changed it', () => {
    expect(record.artifact).toBe(
      `${REPO}/blob/a69a068319de9dc9a7ab1049b411a562a026e7d5/raw/openrouter-models/response.json`,
    );
  });

  it('links the commit itself beside the artifact', () => {
    expect(record.commit).toBe(`${REPO}/commit/a69a068319de9dc9a7ab1049b411a562a026e7d5`);
  });

  it('copies the sentence the deriving module wrote rather than composing one', () => {
    expect(record.sentence).toBe(
      'OpenRouter\'s catalog context_length for "anthropic/claude-opus-5" changed from 200000 to 100000. The top_provider.context_length recorded beside it was 200000 and is 100000.',
    );
  });

  it('carries the labs the derivation attached, read off the entities', () => {
    expect(record.labs).toEqual(['anthropic']);
  });

  it('carries a null tier on an event, because an event has no sourcing tier', () => {
    expect(record.tier).toBeNull();
  });

  it('carries the source precision it was handed', () => {
    expect(record.precision_seconds).toBe(348766);
  });
});

describe('newestChangeOf', () => {
  const older: ContentChange = { ...contextChange, sha: 'a'.repeat(40), stamp: { iso: '2026-08-01T00:00:00.000Z', kind: 'origin' } };
  const newer: ContentChange = { ...contextChange, sha: 'b'.repeat(40), stamp: { iso: '2026-08-29T00:00:00.000Z', kind: 'origin' } };

  it('picks the change with the latest stamp, not the first in the list', () => {
    expect(newestChangeOf([older, newer], 'openrouter-models')?.sha).toBe('b'.repeat(40));
  });

  it('picks the same change when the list is handed over in the other order', () => {
    expect(newestChangeOf([newer, older], 'openrouter-models')?.sha).toBe('b'.repeat(40));
  });

  it('ignores changes belonging to another source', () => {
    expect(newestChangeOf([newer], 'anthropic-deprecations')).toBeNull();
  });

  it('falls back to the first in input order when nothing carries a stamp', () => {
    const a: ContentChange = { ...contextChange, sha: 'c'.repeat(40), stamp: null };
    const b: ContentChange = { ...contextChange, sha: 'd'.repeat(40), stamp: null };
    expect(newestChangeOf([a, b], 'openrouter-models')?.sha).toBe('c'.repeat(40));
  });
});

/**
 * OLDEST, not newest. A model that left the catalogue and came back was first
 * seen on the first of those, and reporting the second would publish a
 * first-seen date later than an event the same API serves.
 */
describe('firstAddedByModel', () => {
  it('keeps the oldest addition when a model was added twice', () => {
    const newerAdd = change({
      sha: 'f'.repeat(40),
      stamp: { iso: '2026-08-29T00:00:00.000Z', kind: 'origin' },
      before: catalog([{ id: 'anthropic/claude-opus-5' }]),
      after: catalog([{ id: 'anthropic/claude-opus-5' }, { id: 'x/y' }]),
    });
    const olderAdd = change({
      sha: 'e'.repeat(40),
      stamp: { iso: '2026-08-01T00:00:00.000Z', kind: 'origin' },
      before: catalog([{ id: 'anthropic/claude-opus-5' }]),
      after: catalog([{ id: 'anthropic/claude-opus-5' }, { id: 'x/y' }]),
    });
    const feed = buildFeed(deriveEvents([newerAdd, olderAdd]), []);
    expect(firstAddedByModel(feed).get('x/y')?.sha).toBe('e'.repeat(40));
  });
});

describe('itemCountByEntity', () => {
  it('counts one context change once against the model it names', () => {
    expect(itemCountByEntity([contextItem]).get('model/openrouter:anthropic/claude-opus-5')).toBe(1);
  });

  it('counts the same item against the lab it also names', () => {
    expect(itemCountByEntity([contextItem]).get('lab/anthropic')).toBe(1);
  });
});

describe('currentModels', () => {
  const built = currentModels([contextChange], [contextItem], SITE, new Set(['model-openrouter-anthropic-claude-opus-5']), REPO)!;

  it('reads the catalogue state out of the newest stored bytes, not the diff', () => {
    expect(built.models.map((m) => m.id)).toEqual(['anthropic/claude-opus-5']);
  });

  it('publishes the context_length the stored bytes carry after the change', () => {
    expect(built.models[0]!.context_length).toBe(100000);
  });

  it('publishes top_provider.context_length beside it, never omitted', () => {
    expect(built.models[0]!.top_provider_context_length).toBe(100000);
  });

  it('points a model with a thread at its own endpoint', () => {
    expect(built.models[0]!.api).toBe(
      'https://maxwellbrohm.github.io/llm-catalog-archive/api/v1/models/model-openrouter-anthropic-claude-opus-5.json',
    );
  });

  it('points a model with no thread at no endpoint rather than at a 404', () => {
    const none = currentModels([contextChange], [contextItem], SITE, new Set(), REPO)!;
    expect(none.models[0]!.api).toBeNull();
  });

  it('counts the items attached to the model', () => {
    expect(built.models[0]!.events).toBe(1);
  });

  it('publishes null first-seen for a source the archive has captured once', () => {
    expect(built.models[0]!.first_seen_in_catalog_at).toBeNull();
  });

  it('carries the provenance of the bytes the state was read from', () => {
    expect(built.source.artifact).toBe(
      `${REPO}/blob/a69a068319de9dc9a7ab1049b411a562a026e7d5/raw/openrouter-models/response.json`,
    );
  });

  it('returns null when the archive holds no capture of the catalogue at all', () => {
    expect(currentModels([], [], SITE, new Set(), REPO)).toBeNull();
  });
});

describe('currentRetirements', () => {
  const doc = [
    deprecationsDoc([
      ['claude-opus-5', 'Active', 'N/A', 'Not sooner than July 24, 2027'],
      ['claude-opus-4-1-20250805', 'Deprecated', 'August 5, 2025', 'August 5, 2026'],
    ]),
    replacementTable([['August 5, 2026', 'claude-opus-4-1-20250805', 'claude-opus-4-8']]),
  ].join('\n');
  const deprecations = change({
    sourceId: 'anthropic-deprecations',
    path: 'raw/anthropic-deprecations/response.md',
    tier: 'daily',
    before: doc,
    after: doc,
  });
  const built = currentRetirements([deprecations], REPO)!;

  it('lists every model in the lifecycle table, sorted by name', () => {
    expect(built.retirements.map((r) => r.model)).toEqual(['claude-opus-4-1-20250805', 'claude-opus-5']);
  });

  it('parses a bare date cell to a day', () => {
    expect(built.retirements[0]!.floor_date).toBe('2026-08-05');
  });

  it('parses a "not sooner than" cell to the day inside it', () => {
    expect(built.retirements[1]!.floor_date).toBe('2027-07-24');
  });

  it('keeps the cell verbatim beside the parsed date', () => {
    expect(built.retirements[1]!.floor_text).toBe('Not sooner than July 24, 2027');
  });

  it('joins the replacement the same document records', () => {
    expect(built.retirements[0]!.replacement).toBe('claude-opus-4-8');
  });

  it('names where a replacement came from rather than asserting it bare', () => {
    expect(built.retirements[0]!.replacement_source).toBe(
      'the anthropic-deprecations deprecation-history table\'s "Recommended replacement" column',
    );
  });

  it('publishes no replacement for a model the history table does not name', () => {
    expect(built.retirements[1]!.replacement).toBeNull();
  });

  it('carries the provider the source is named for', () => {
    expect(built.retirements[0]!.provider).toBe('anthropic');
  });

  it('returns null when the archive holds no capture of a lifecycle table', () => {
    expect(currentRetirements([], REPO)).toBeNull();
  });
});

describe('scorecardRecord', () => {
  it('publishes a null accuracy rather than a score nobody earned', () => {
    expect(scorecardRecord(scoreLedger([]))['accuracy_pct']).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the arms the first pass left unasserted
// ---------------------------------------------------------------------------

import { deriveLeaks } from '../src/derive/leaks.js';
import { feedItemFromLeak } from '../src/derive/feed.js';
import { OBSERVED_AT } from './derive-fixtures.js';

/** A catalogue change that schedules an expiration, which the desk reads. */
const expiringChange = change({
  before: catalog([{ id: 'moonshotai/kimi-k2.5' }]),
  after: catalog([{ id: 'moonshotai/kimi-k2.5', expiration_date: '2026-12-01T00:00:00Z' }]),
});
const leakItem = feedItemFromLeak(deriveLeaks([expiringChange])[0]!);

describe('apiUrl and siteUrlFor: the trailing-slash fold', () => {
  it('collapses every trailing slash on the base, not only the last one', () => {
    expect(apiUrl(`${SITE}//`, 'models.json')).toBe(
      'https://maxwellbrohm.github.io/llm-catalog-archive/api/v1/models.json',
    );
  });

  it('collapses every trailing slash for a site URL too', () => {
    expect(siteUrlFor(`${SITE}//`, 'about.html')).toBe(
      'https://maxwellbrohm.github.io/llm-catalog-archive/about.html',
    );
  });
});

describe('subjectOf on a leak item', () => {
  it('is the leak\'s own subject rather than an event field', () => {
    expect(subjectOf(leakItem)).toBe('moonshotai/kimi-k2.5');
  });

  it('is empty for an item carrying neither an event nor a leak', () => {
    expect(subjectOf({ ...leakItem, leak: null, event: null })).toBe('');
  });
});

/**
 * One assertion per event type. A type with no arm here is a type the API would
 * serve as a sentence with no data under it.
 */
describe('eventFields covers every event type', () => {
  const fieldsFor = (before: string, after: string): Record<string, string | number | null> => {
    const item = buildFeed(deriveEvents([change({ before, after })]), [])[0]!;
    return eventFields(item.event!, 900);
  };

  it('carries the removed id for a model_removed', () => {
    expect(
      fieldsFor(catalog([{ id: 'a/b' }, { id: 'c/d' }]), catalog([{ id: 'a/b' }]))['model_id'],
    ).toBe('c/d');
  });

  it('records the last stamp the removed model was seen at', () => {
    expect(
      fieldsFor(catalog([{ id: 'a/b' }, { id: 'c/d' }]), catalog([{ id: 'a/b' }]))['last_seen_at'],
    ).toBe('2026-08-27T08:08:22.000Z');
  });

  it('carries both sides of a price change', () => {
    const f = fieldsFor(
      catalog([{ id: 'a/b', pricing: { prompt: '1', completion: '2' } }]),
      catalog([{ id: 'a/b', pricing: { prompt: '3', completion: '2' } }]),
    );
    expect([f['field'], f['from'], f['to']]).toEqual(['prompt', '1', '3']);
  });

  it('carries the scheduled expiration date', () => {
    expect(
      fieldsFor(catalog([{ id: 'a/b' }]), catalog([{ id: 'a/b', expiration_date: '2026-12-01' }]))[
        'expiration_date'
      ],
    ).toBe('2026-12-01');
  });

  it('carries both sides of an alias retarget', () => {
    const f = fieldsFor(
      catalog([{ id: '~a/latest', canonical_slug: 'a/one' }]),
      catalog([{ id: '~a/latest', canonical_slug: 'a/two' }]),
    );
    expect([f['alias'], f['from'], f['to']]).toEqual(['~a/latest', 'a/one', 'a/two']);
  });

  it('carries the provider, title and url of an added documentation entry', () => {
    const item = buildFeed(
      deriveEvents([
        {
          ...change({}),
          sourceId: 'openai-llms-txt',
          path: 'raw/openai-llms-txt/response.txt',
          before: '',
          after: '- [Quickstart](https://developers.openai.com/api/docs/quickstart.md)',
        },
      ]),
      [],
    )[0]!;
    expect(eventFields(item.event!, 900)).toEqual({
      provider: 'openai',
      title: 'Quickstart',
      url: 'https://developers.openai.com/api/docs/quickstart.md',
    });
  });

  it('carries the provider, title and url of a removed documentation entry', () => {
    const item = buildFeed(
      deriveEvents([
        {
          ...change({}),
          sourceId: 'openai-llms-txt',
          path: 'raw/openai-llms-txt/response.txt',
          before: '- [Quickstart](https://developers.openai.com/api/docs/quickstart.md)',
          after: '',
        },
      ]),
      [],
    )[0]!;
    expect(eventFields(item.event!, 900)['url']).toBe('https://developers.openai.com/api/docs/quickstart.md');
  });

  it('carries the parsed floor date and the cell it was read from', () => {
    const before = deprecationsDoc([['claude-opus-5', 'Active', 'N/A', 'N/A']]);
    const after = deprecationsDoc([['claude-opus-5', 'Active', 'N/A', 'Not sooner than July 24, 2027']]);
    const item = buildFeed(
      deriveEvents([
        change({ sourceId: 'anthropic-deprecations', path: 'raw/anthropic-deprecations/response.md', tier: 'daily', before, after }),
      ]),
      [],
    )[0]!;
    expect(eventFields(item.event!, 900)).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
      floor_date: '2027-07-24',
      floor_text: 'Not sooner than July 24, 2027',
    });
  });
});

describe('itemRecord on a leak item', () => {
  const record = itemRecord(leakItem, 900, SITE, REPO);

  it('takes its fields from the leak\'s own fact rows, not from an event', () => {
    expect(record.fields).toEqual({
      'catalog id': 'moonshotai/kimi-k2.5',
      expiration_date: '2026-12-01T00:00:00Z',
      'sentinel check':
        'a year at or past 2090 is read as the vendor spelling "no expiry" and is not listed here',
    });
  });

  it('carries the sourcing tier the desk assigned', () => {
    expect(record.tier).toBe('confirmed-artifact');
  });

  it('marks which derivation produced it, because the two are not equivalent', () => {
    expect(record.kind).toBe('leak');
  });
});

describe('itemRecord entities', () => {
  it('renders every entity the derivation attached, with its thread link', () => {
    expect(itemRecord(contextItem, 900, SITE, REPO).entities).toEqual([
      {
        kind: 'model',
        id: 'model/openrouter:anthropic/claude-opus-5',
        label: 'anthropic/claude-opus-5',
        slug: 'model-openrouter-anthropic-claude-opus-5',
        thread: `${SITE}/threads/model-openrouter-anthropic-claude-opus-5.html`,
      },
      {
        kind: 'lab',
        id: 'lab/anthropic',
        label: 'anthropic',
        slug: 'lab-anthropic',
        thread: `${SITE}/threads/lab-anthropic.html`,
      },
    ]);
  });
});

describe('firstAddedByModel over a mixed feed', () => {
  it('indexes only the additions, leaving other item types out', () => {
    const feed = buildFeed(
      deriveEvents([
        change({ before: catalog([{ id: 'a/b' }]), after: catalog([{ id: 'a/b' }, { id: 'c/d' }]) }),
      ]),
      deriveLeaks([expiringChange]),
    );
    expect([...firstAddedByModel(feed).keys()]).toEqual(['c/d']);
  });
});

describe('currentModels: ordering and a source that earns a date', () => {
  it('sorts the catalogue by id rather than serving the payload order', () => {
    const c = change({
      before: catalog([{ id: 'a/b' }]),
      after: catalog([{ id: 'z/z' }, { id: 'a/b' }, { id: 'm/m' }]),
    });
    expect(currentModels([c], [], SITE, new Set(), REPO)!.models.map((m) => m.id)).toEqual([
      'a/b',
      'm/m',
      'z/z',
    ]);
  });

  // Two captures 12 hours apart bound the error at the fast tier's 15 minutes
  // floor raised to the measured gap, which is inside a day, so the day may be
  // published. This is the arm the live archive does not reach today.
  it('publishes a first-seen day for a source whose measured error is inside a day', () => {
    const first = change({
      sha: '1'.repeat(40),
      kind: 'added',
      before: null,
      after: catalog([{ id: 'a/b' }]),
      observedAt: '2026-08-28T00:00:00.000Z',
      stamp: { iso: '2026-08-28T00:00:00.000Z', kind: 'origin' },
    });
    const second = change({
      sha: '2'.repeat(40),
      before: catalog([{ id: 'a/b' }]),
      after: catalog([{ id: 'a/b' }, { id: 'c/d' }]),
      observedAt: '2026-08-28T12:00:00.000Z',
      stamp: { iso: '2026-08-28T12:00:00.000Z', kind: 'origin' },
    });
    const changes = [second, first];
    const feed = buildFeed(deriveEvents(changes), []);
    const built = currentModels(changes, feed, SITE, new Set(), REPO)!;
    expect(built.models.find((m) => m.id === 'c/d')!.first_seen_in_catalog_at).toBe('2026-08-28');
  });

  // The gate, exercised where it actually bites: a model addition IS on record
  // and the source's measured error is still wider than a day, so the day is
  // refused. Without this the gate can be deleted and every assertion still
  // passes, because the other cases have no addition to date in the first place.
  it('refuses a first-seen day for an addition whose source is captured too rarely', () => {
    const first = change({
      sha: '1'.repeat(40),
      kind: 'added',
      before: null,
      after: catalog([{ id: 'a/b' }]),
      observedAt: '2026-08-26T00:00:00.000Z',
      stamp: { iso: '2026-08-26T00:00:00.000Z', kind: 'origin' },
    });
    const second = change({
      sha: '2'.repeat(40),
      before: catalog([{ id: 'a/b' }]),
      after: catalog([{ id: 'a/b' }, { id: 'c/d' }]),
      observedAt: '2026-08-28T12:00:00.000Z',
      stamp: { iso: '2026-08-28T12:00:00.000Z', kind: 'origin' },
    });
    const changes = [second, first];
    const feed = buildFeed(deriveEvents(changes), []);
    const built = currentModels(changes, feed, SITE, new Set(), REPO)!;
    expect(built.models.find((m) => m.id === 'c/d')!.first_seen_in_catalog_at).toBeNull();
  });

  it('measures that error rather than assuming the tier interval', () => {
    const first = change({ sha: '1'.repeat(40), kind: 'added', before: null, after: catalog([{ id: 'a/b' }]), observedAt: '2026-08-28T00:00:00.000Z' });
    const second = change({ sha: '2'.repeat(40), observedAt: '2026-08-28T12:00:00.000Z' });
    expect(currentModels([second, first], [], SITE, new Set(), REPO)!.models[0]!.precision_seconds).toBe(43200);
  });
});

describe('currentRetirements: the rows with no replacement', () => {
  const doc = [
    deprecationsDoc([
      ['claude-z', 'Active', 'N/A', 'Not sooner than July 24, 2027'],
      ['claude-a', 'Active', 'N/A', 'Not sooner than June 9, 2027'],
      ['claude-m', 'Active', 'N/A', 'Not sooner than May 28, 2027'],
    ]),
  ].join('\n');
  const built = currentRetirements(
    [change({ sourceId: 'anthropic-deprecations', path: 'raw/anthropic-deprecations/response.md', tier: 'daily', before: doc, after: doc })],
    REPO,
  )!;

  it('sorts by model name rather than serving the table order', () => {
    expect(built.retirements.map((r) => r.model)).toEqual(['claude-a', 'claude-m', 'claude-z']);
  });

  it('names no source for a replacement it does not have', () => {
    expect(built.retirements[0]!.replacement_source).toBeNull();
  });
});

describe('observedAt is what cadence is measured from', () => {
  it('uses the runner clock rather than the origin date the page prints', () => {
    expect(OBSERVED_AT).toBe('2026-08-28T11:23:40.960Z');
  });
});
