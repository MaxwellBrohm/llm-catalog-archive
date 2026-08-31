import { describe, it, expect } from 'vitest';
import {
  canRenderAt,
  DAY_SECONDS,
  eventsFromChange,
  parseCatalog,
  parseDeprecationTable,
  parseDocIndex,
  parseFloorDate,
  deriveEvents,
  maxGapSeconds,
  observationsBySource,
  precisionBySource,
  precisionFloorFor,
  precisionSecondsFrom,
  type DerivedEvent,
} from '../src/derive/events.js';
import { catalog, change, deprecationsDoc, docChange, EARLIER, SHA } from './derive-fixtures.js';

/** The one event of this type, so a test asserts about a known row. */
function only<T extends DerivedEvent['type']>(
  events: DerivedEvent[],
  type: T,
): Extract<DerivedEvent, { type: T }> {
  const hits = events.filter((e) => e.type === type);
  expect(hits).toHaveLength(1);
  return hits[0] as Extract<DerivedEvent, { type: T }>;
}

describe('the baseline rule', () => {
  // The only thing an added path's diff supports is "these bytes are now
  // stored". Reading 416 model_added events out of it would date every model in
  // the catalogue to the day collection started.
  it('emits nothing at all from the capture that first stored a catalogue', () => {
    expect(
      eventsFromChange(
        change({ kind: 'added', before: null, after: catalog([{ id: 'anthropic/claude-opus-5' }]) }),
      ),
    ).toEqual([]);
  });

  it('emits nothing from the capture that first stored a docs index', () => {
    expect(
      eventsFromChange({
        ...docChange('', '- [Quickstart](https://developers.openai.com/api/docs/quickstart.md)'),
        kind: 'added',
        before: null,
      }),
    ).toEqual([]);
  });

  // A caller that says 'modified' with no before would otherwise have every
  // entry in the after reported as newly added.
  it('emits nothing when the kind says modified but no before was supplied', () => {
    expect(eventsFromChange(change({ kind: 'modified', before: null }))).toEqual([]);
  });

  it('emits nothing for a source it holds no reader for', () => {
    expect(
      eventsFromChange(
        change({ sourceId: 'claude-status', path: 'raw/claude-status/response.atom', before: '<a/>', after: '<b/>' }),
      ),
    ).toEqual([]);
  });
});

describe('parseCatalog', () => {
  it('keys entries by the catalogue id', () => {
    expect([...parseCatalog(catalog([{ id: 'anthropic/claude-opus-5' }])).keys()]).toEqual([
      'anthropic/claude-opus-5',
    ]);
  });

  it('reads top_provider.context_length separately from the model context_length', () => {
    const entry = parseCatalog(
      catalog([{ id: 'deepseek/deepseek-v4-flash-0731', context_length: 1310720, top_provider_context_length: 1048576 }]),
    ).get('deepseek/deepseek-v4-flash-0731');
    expect(entry?.topProviderContextLength).toBe(1048576);
  });

  // 60 models ship a pricing.overrides ARRAY of day-banded rates. Comparing it
  // as a listed price emits a price_changed whose from and to are the string
  // "[object Object]".
  it('drops the pricing.overrides array, which is not a listed price', () => {
    const entry = parseCatalog(
      catalog([{ id: 'deepseek/x', pricing: { prompt: '0.000001', overrides: [{ prompt: '0.0002' }] } }]),
    ).get('deepseek/x');
    expect(entry?.pricing).toEqual({ prompt: '0.000001' });
  });

  // The whole message, not a fragment of it. Node's own SyntaxError for
  // JSON.parse already reads "... is not valid JSON", so a substring assertion
  // passes whether the parse error was wrapped with the source it came from or
  // simply rethrown, and the source is the part that makes it actionable.
  it('throws on bytes that are not JSON rather than deriving nothing in silence', () => {
    expect(() => parseCatalog('<html>')).toThrow(
      'openrouter-models: stored bytes are not valid JSON',
    );
  });

  it('throws on a JSON document with no data array, which the collector invariants forbid', () => {
    expect(() => parseCatalog('{"models":[]}')).toThrow(
      'openrouter-models: stored bytes have no `data` array',
    );
  });
});

describe('model_added', () => {
  it('names the id that is present in the after and absent from the before', () => {
    const events = eventsFromChange(
      change({
        before: catalog([{ id: 'anthropic/claude-opus-5' }]),
        after: catalog([{ id: 'anthropic/claude-opus-5' }, { id: 'z-ai/glm-5.3' }]),
      }),
    );
    expect(only(events, 'model_added').modelId).toBe('z-ai/glm-5.3');
  });

  it('carries the catalogue created field verbatim', () => {
    const events = eventsFromChange(
      change({
        before: catalog([]),
        after: catalog([{ id: 'z-ai/glm-5.3', created: 1787752741 }]),
      }),
    );
    expect(only(events, 'model_added').created).toBe(1787752741);
  });

  it('carries the worst-case first-seen error handed to it', () => {
    const events = eventsFromChange(
      change({ tier: 'fast', before: catalog([]), after: catalog([{ id: 'z-ai/glm-5.3' }]) }),
      28080,
    );
    expect(only(events, 'model_added').precisionSeconds).toBe(28080);
  });

  // The default a caller gets by forgetting has to be the one that cannot
  // overstate confidence. One change carries no cadence evidence at all.
  it('carries an unbounded error when no measurement was handed to it', () => {
    const events = eventsFromChange(
      change({ tier: 'fast', before: catalog([]), after: catalog([{ id: 'z-ai/glm-5.3' }]) }),
    );
    expect(only(events, 'model_added').precisionSeconds).toBe(Infinity);
  });

  // A model seen for the first time has no previous values, so a differ that
  // compared it against nothing would report a context change from absent and
  // a price change from absent on top of the addition.
  it('emits exactly one event for a newly present model', () => {
    const events = eventsFromChange(
      change({ before: catalog([]), after: catalog([{ id: 'z-ai/glm-5.3' }]) }),
    );
    expect(events.map((e) => e.type)).toEqual(['model_added']);
  });
});

describe('model_removed', () => {
  it('names the id that is present in the before and absent from the after', () => {
    const events = eventsFromChange(
      change({ before: catalog([{ id: 'z-ai/glm-5.3' }]), after: catalog([]) }),
    );
    expect(only(events, 'model_removed').modelId).toBe('z-ai/glm-5.3');
  });

  // This commit is when the model was seen ABSENT. The last time it was seen
  // present is the capture before it, which is the only honest last-seen.
  it('reports the previous capture as the last time the model was seen present', () => {
    const events = eventsFromChange(
      change({ before: catalog([{ id: 'z-ai/glm-5.3' }]), after: catalog([]) }),
    );
    expect(only(events, 'model_removed').lastSeen).toEqual(EARLIER);
  });
});

describe('context_changed', () => {
  const events = eventsFromChange(
    change({
      before: catalog([{ id: 'deepseek/deepseek-chat', context_length: 128000, top_provider_context_length: 128000 }]),
      after: catalog([{ id: 'deepseek/deepseek-chat', context_length: 65536, top_provider_context_length: 128000 }]),
    }),
  );

  it('reports the catalogue value it moved from', () => {
    expect(only(events, 'context_changed').from).toBe(128000);
  });

  it('reports the catalogue value it moved to', () => {
    expect(only(events, 'context_changed').to).toBe(65536);
  });

  // Spec section 10.1. context_length is the maximum across the providers
  // currently routing a model, so it moves when a provider joins or leaves the
  // pool with nothing happening at the lab. Both numbers on both sides are what
  // lets a reader see that without the page asserting it.
  it('carries the top_provider context length on the before side', () => {
    expect(only(events, 'context_changed').topProviderFrom).toBe(128000);
  });

  it('carries the top_provider context length on the after side', () => {
    expect(only(events, 'context_changed').topProviderTo).toBe(128000);
  });

  it('carries a null top_provider context length rather than omitting the field', () => {
    const e = eventsFromChange(
      change({
        before: catalog([{ id: 'deepseek/x', context_length: 128000, top_provider_context_length: null }]),
        after: catalog([{ id: 'deepseek/x', context_length: 65536, top_provider_context_length: null }]),
      }),
    );
    expect(only(e, 'context_changed').topProviderTo).toBeNull();
  });

  it('emits nothing when the catalogue context length is unchanged', () => {
    const e = eventsFromChange(
      change({
        before: catalog([{ id: 'deepseek/x', context_length: 128000, top_provider_context_length: 128000 }]),
        after: catalog([{ id: 'deepseek/x', context_length: 128000, top_provider_context_length: 64000 }]),
      }),
    );
    expect(e.filter((x) => x.type === 'context_changed')).toEqual([]);
  });
});

describe('price_changed', () => {
  it('names the pricing field that moved', () => {
    const events = eventsFromChange(
      change({
        before: catalog([{ id: 'z-ai/glm-5.2', pricing: { prompt: '0.000001', completion: '0.000002' } }]),
        after: catalog([{ id: 'z-ai/glm-5.2', pricing: { prompt: '0.000003', completion: '0.000002' } }]),
      }),
    );
    expect(only(events, 'price_changed').field).toBe('prompt');
  });

  it('reports the listed value as the string the catalogue stores it as', () => {
    const events = eventsFromChange(
      change({
        before: catalog([{ id: 'z-ai/glm-5.2', pricing: { prompt: '0.000001' } }]),
        after: catalog([{ id: 'z-ai/glm-5.2', pricing: { prompt: '0.000003' } }]),
      }),
    );
    expect([only(events, 'price_changed').from, only(events, 'price_changed').to]).toEqual([
      '0.000001',
      '0.000003',
    ]);
  });

  // A field that disappears is a change to what the catalogue lists, so the
  // union of both sides is walked rather than only the after's keys.
  it('reports a price field that disappeared as a change to absent', () => {
    const events = eventsFromChange(
      change({
        before: catalog([{ id: 'z-ai/glm-5.2', pricing: { prompt: '0.000001', web_search: '0.004' } }]),
        after: catalog([{ id: 'z-ai/glm-5.2', pricing: { prompt: '0.000001' } }]),
      }),
    );
    expect([only(events, 'price_changed').field, only(events, 'price_changed').to]).toEqual([
      'web_search',
      null,
    ]);
  });

  it('emits one event per changed field, in sorted field order', () => {
    const events = eventsFromChange(
      change({
        before: catalog([{ id: 'z-ai/glm-5.2', pricing: { prompt: '1', completion: '2' } }]),
        after: catalog([{ id: 'z-ai/glm-5.2', pricing: { prompt: '3', completion: '4' } }]),
      }),
    );
    expect(events.filter((e) => e.type === 'price_changed').map((e) => e.field)).toEqual([
      'completion',
      'prompt',
    ]);
  });
});

describe('expiration_set', () => {
  it('reports the date the catalogue set on a transient entry', () => {
    const events = eventsFromChange(
      change({
        before: catalog([{ id: 'openai/gpt-preview', expiration_date: null }]),
        after: catalog([{ id: 'openai/gpt-preview', expiration_date: '2026-09-30' }]),
      }),
    );
    expect(only(events, 'expiration_set').date).toBe('2026-09-30');
  });

  // The field is non-null only on transient entries, so the event is the
  // transition INTO non-null. A date that merely moved is a different claim.
  it('emits nothing when a date that was already set changes', () => {
    const events = eventsFromChange(
      change({
        before: catalog([{ id: 'openai/gpt-preview', expiration_date: '2026-09-30' }]),
        after: catalog([{ id: 'openai/gpt-preview', expiration_date: '2026-12-31' }]),
      }),
    );
    expect(events.filter((e) => e.type === 'expiration_set')).toEqual([]);
  });
});

describe('alias_retargeted', () => {
  it('reports the stable id whose canonical slug moved', () => {
    const events = eventsFromChange(
      change({
        before: catalog([{ id: 'z-ai/glm-5.3', canonical_slug: 'z-ai/glm-5.3-20260816' }]),
        after: catalog([{ id: 'z-ai/glm-5.3', canonical_slug: 'z-ai/glm-5.3-20260901' }]),
      }),
    );
    expect(only(events, 'alias_retargeted').alias).toBe('z-ai/glm-5.3');
  });

  it('reports the slug it pointed at and the slug it points at now', () => {
    const events = eventsFromChange(
      change({
        before: catalog([{ id: 'z-ai/glm-5.3', canonical_slug: 'z-ai/glm-5.3-20260816' }]),
        after: catalog([{ id: 'z-ai/glm-5.3', canonical_slug: 'z-ai/glm-5.3-20260901' }]),
      }),
    );
    const e = only(events, 'alias_retargeted');
    expect([e.from, e.to]).toEqual(['z-ai/glm-5.3-20260816', 'z-ai/glm-5.3-20260901']);
  });

  // A slug appearing where there was none is a field being populated, not a
  // pointer moving, and the archive has no previous target to name.
  it('emits nothing when the canonical slug was absent before', () => {
    const e = eventsFromChange(
      change({
        before: '{"data":[{"id":"a/b"}]}',
        after: '{"data":[{"id":"a/b","canonical_slug":"a/b-2"}]}',
      }),
    );
    expect(e).toEqual([]);
  });

  it('emits nothing when the canonical slug disappeared', () => {
    const e = eventsFromChange(
      change({
        before: '{"data":[{"id":"a/b","canonical_slug":"a/b-1"}]}',
        after: '{"data":[{"id":"a/b"}]}',
      }),
    );
    expect(e).toEqual([]);
  });

  it('emits nothing when the canonical slug is unchanged', () => {
    const events = eventsFromChange(
      change({
        before: catalog([{ id: 'z-ai/glm-5.3', canonical_slug: 'z-ai/glm-5.3-20260816' }]),
        after: catalog([{ id: 'z-ai/glm-5.3', canonical_slug: 'z-ai/glm-5.3-20260816' }]),
      }),
    );
    expect(events).toEqual([]);
  });
});

describe('parseDocIndex', () => {
  it('reads the title and url out of an llms.txt entry', () => {
    expect(parseDocIndex('- [Quickstart](https://openrouter.ai/docs/quickstart.md): Get started')).toEqual(
      new Map([['https://openrouter.ai/docs/quickstart.md', 'Quickstart']]),
    );
  });

  // OpenRouter's index carries descriptions holding their own inline markdown
  // links. A greedy match would take the description's url as the page's.
  it('takes the page url, not a url appearing later in the description', () => {
    const line =
      '- [List models](https://openrouter.ai/docs/api/models.md): filtered by [privacy settings](https://openrouter.ai/docs/guides/privacy.md)';
    expect([...parseDocIndex(line).keys()]).toEqual(['https://openrouter.ai/docs/api/models.md']);
  });

  it('ignores a line that is not an index entry', () => {
    expect(parseDocIndex('# OpenRouter | Documentation').size).toBe(0);
  });
});

describe('doc_added and doc_removed', () => {
  const before = [
    '- [Assistants API deep dive](https://developers.openai.com/api/docs/assistants/deep-dive.md)',
    '- [Quickstart](https://developers.openai.com/api/docs/quickstart.md)',
  ].join('\n');
  const after = [
    '- [Quickstart](https://developers.openai.com/api/docs/quickstart.md)',
    '- [Responses](https://developers.openai.com/api/docs/responses.md)',
  ].join('\n');
  const events = eventsFromChange(docChange(before, after));

  it('reports the url present in the after and absent from the before', () => {
    expect(only(events, 'doc_added').url).toBe('https://developers.openai.com/api/docs/responses.md');
  });

  it('reports the title the index gave the added page', () => {
    expect(only(events, 'doc_added').title).toBe('Responses');
  });

  it('reports the url present in the before and absent from the after', () => {
    expect(only(events, 'doc_removed').url).toBe(
      'https://developers.openai.com/api/docs/assistants/deep-dive.md',
    );
  });

  it('reports the provider the source id names', () => {
    expect(only(events, 'doc_added').provider).toBe('openai');
  });

  it('says nothing about a page present on both sides', () => {
    expect(events).toHaveLength(2);
  });

  it('attaches the added page to the api surface its section names', () => {
    expect(only(events, 'doc_added').entities[0]?.id).toBe('api-surface/developers.openai.com/api/docs');
  });

  // Held, not dropped. The event is real and its artifact link resolves; what
  // it lacks is a thread, because a page at the host root has no section above
  // it and calling the host a section would invent an API surface.
  it('still emits an event for a url with no section', () => {
    expect(
      eventsFromChange(docChange('', '- [Home](https://developers.openai.com/index.md)')),
    ).toHaveLength(1);
  });

  it('marks an event whose url has no section as held', () => {
    const e = eventsFromChange(docChange('', '- [Home](https://developers.openai.com/index.md)'));
    expect(e[0]?.held).toBe(true);
  });

  it('attaches no entity at all to an event it held', () => {
    const e = eventsFromChange(docChange('', '- [Home](https://developers.openai.com/index.md)'));
    expect(e[0]?.entities).toEqual([]);
  });
});

describe('parseFloorDate', () => {
  it('reads the date out of a not-sooner-than floor', () => {
    expect(parseFloorDate('Not sooner than June 9, 2027')).toBe('2027-06-09');
  });

  it('reads a bare retirement date', () => {
    expect(parseFloorDate('August 5, 2026')).toBe('2026-08-05');
  });

  it('pads a single digit day so the value sorts as a date', () => {
    expect(parseFloorDate('February 5, 2027')).toBe('2027-02-05');
  });

  it('returns null for a cell holding no date', () => {
    expect(parseFloorDate('N/A')).toBeNull();
  });
});

describe('parseDeprecationTable', () => {
  const doc = deprecationsDoc([
    ['claude-opus-5', 'Active', 'N/A', 'Not sooner than July 24, 2027'],
    ['claude-opus-4-1-20250805', 'Retired', 'June 5, 2026', 'August 5, 2026'],
  ]);

  it('keys the retirement cell by the API model name', () => {
    expect(parseDeprecationTable(doc).get('claude-opus-5')).toBe('Not sooner than July 24, 2027');
  });

  it('does not treat the header rule row as a model', () => {
    expect([...parseDeprecationTable(doc).keys()]).toEqual([
      'claude-opus-5',
      'claude-opus-4-1-20250805',
    ]);
  });

  // The same document holds deprecation-history tables shaped
  // `Retirement date | Deprecated model | Recommended replacement`. A parser
  // that matched on shape alone would file a date as a model name.
  it('ignores a three column table elsewhere in the document', () => {
    const other = [
      '| Retirement date | Deprecated model | Recommended replacement |',
      '| --- | --- | --- |',
      '| August 5, 2026 | `claude-opus-4-1-20250805` | `claude-opus-4-8` |',
    ].join('\n');
    expect(parseDeprecationTable(other).size).toBe(0);
  });
});

describe('retirement_floor', () => {
  const before = deprecationsDoc([['claude-opus-5', 'Active', 'N/A', 'Not sooner than July 24, 2027']]);
  const after = deprecationsDoc([['claude-opus-5', 'Active', 'N/A', 'Not sooner than June 9, 2027']]);
  const events = eventsFromChange(
    change({
      sourceId: 'anthropic-deprecations',
      path: 'raw/anthropic-deprecations/response.md',
      before,
      after,
    }),
  );

  it('names the API model whose retirement cell changed', () => {
    expect(only(events, 'retirement_floor').model).toBe('claude-opus-5');
  });

  it('parses the cell to a comparable date', () => {
    expect(only(events, 'retirement_floor').floorDate).toBe('2027-06-09');
  });

  it('keeps the cell verbatim beside the parsed date', () => {
    expect(only(events, 'retirement_floor').floorText).toBe('Not sooner than June 9, 2027');
  });

  it('emits nothing for a row whose retirement cell did not change', () => {
    expect(
      eventsFromChange(
        change({
          sourceId: 'anthropic-deprecations',
          path: 'raw/anthropic-deprecations/response.md',
          before,
          after: before,
        }),
      ),
    ).toEqual([]);
  });

  it('attaches the row to the provider API model namespace', () => {
    expect(only(events, 'retirement_floor').entities[0]?.id).toBe('model/anthropic-api:claude-opus-5');
  });
});

describe('the tier floor', () => {
  // A FLOOR, not an answer. The number that used to live here was the interval
  // plus a guessed 3,600 second cron allowance, and the measured worst case for
  // the fast tier is 28,080 seconds.
  it('is the fast tier poll interval, with nothing added to it', () => {
    expect(precisionFloorFor('fast')).toBe(900);
  });

  it('is the daily tier poll interval, with nothing added to it', () => {
    expect(precisionFloorFor('daily')).toBe(86400);
  });
});

describe('maxGapSeconds', () => {
  it('is the widest interval between consecutive observations', () => {
    expect(
      maxGapSeconds([
        '2026-08-26T00:00:00.000Z',
        '2026-08-26T00:15:00.000Z',
        '2026-08-26T08:00:00.000Z',
      ]),
    ).toBe(27900);
  });

  it('sorts before measuring, so input order cannot shrink a gap', () => {
    expect(
      maxGapSeconds([
        '2026-08-26T08:00:00.000Z',
        '2026-08-26T00:00:00.000Z',
        '2026-08-26T00:15:00.000Z',
      ]),
    ).toBe(27900);
  });

  // The widest gap, not the most recent one. A run of captures that settles
  // down after a long outage still carries the outage as its worst case.
  it('is the widest gap even when a later gap is narrower', () => {
    expect(
      maxGapSeconds([
        '2026-08-26T00:00:00.000Z',
        '2026-08-26T08:00:00.000Z',
        '2026-08-26T08:15:00.000Z',
      ]),
    ).toBe(28800);
  });

  it('is null for a single observation, which bounds nothing', () => {
    expect(maxGapSeconds(['2026-08-26T00:00:00.000Z'])).toBeNull();
  });

  it('is null for no observations at all', () => {
    expect(maxGapSeconds([])).toBeNull();
  });

  // Dropping an unreadable instant merges the two gaps either side of it, so
  // the error can only widen. Treating it as zero would narrow the claim on the
  // strength of a value nobody could read.
  it('merges the gaps either side of an unreadable instant rather than zeroing it', () => {
    expect(
      maxGapSeconds(['2026-08-26T00:00:00.000Z', 'not a date', '2026-08-26T08:00:00.000Z']),
    ).toBe(28800);
  });
});

describe('precisionSecondsFrom', () => {
  // The point of the whole change. The configured fast interval is 900 seconds
  // and the measured worst case is 28,080, and the published number has to be
  // the measurement.
  it('reports the measured gap, not the configured interval, when the gap is wider', () => {
    expect(
      precisionSecondsFrom('fast', ['2026-08-26T00:00:00.000Z', '2026-08-26T07:48:00.000Z']),
    ).toBe(28080);
  });

  it('reports the measured gap for a daily source whose captures fell four days apart', () => {
    expect(
      precisionSecondsFrom('daily', ['2026-08-26T00:00:00.000Z', '2026-08-30T00:00:00.000Z']),
    ).toBe(345600);
  });

  // Nothing is credited with resolution finer than its own configured interval,
  // however lucky a run of captures looks.
  it('floors a run of captures tighter than the configured interval at the interval', () => {
    expect(
      precisionSecondsFrom('fast', ['2026-08-26T00:00:00.000Z', '2026-08-26T00:01:00.000Z']),
    ).toBe(900);
  });

  it('is unbounded for a source seen exactly once', () => {
    expect(precisionSecondsFrom('fast', ['2026-08-26T00:00:00.000Z'])).toBe(Infinity);
  });

  it('is unbounded for a source with no usable observation', () => {
    expect(precisionSecondsFrom('fast', [])).toBe(Infinity);
  });
});

describe('canRenderAt', () => {
  // Spec section 10.1: a renderer may show a date only when precision_seconds
  // is at or below the resolution it renders at. This is what makes the field
  // load-bearing rather than decorative.
  it('allows a day resolution for an error measured under a day', () => {
    expect(canRenderAt(28080, DAY_SECONDS)).toBe(true);
  });

  it('forbids a day resolution for an error measured over a day', () => {
    expect(canRenderAt(345600, DAY_SECONDS)).toBe(false);
  });

  it('forbids every resolution for an unbounded error', () => {
    expect(canRenderAt(Infinity, DAY_SECONDS)).toBe(false);
  });

  it('allows a resolution exactly equal to the precision', () => {
    expect(canRenderAt(86400, 86400)).toBe(true);
  });
});

describe('observationsBySource', () => {
  it('collects every capture of a source, baselines included', () => {
    const changes = [
      change({ kind: 'added', before: null, observedAt: '2026-08-26T00:00:00.000Z' }),
      change({ observedAt: '2026-08-30T00:00:00.000Z' }),
    ];
    expect(observationsBySource(changes).get('openrouter-models')).toEqual([
      '2026-08-26T00:00:00.000Z',
      '2026-08-30T00:00:00.000Z',
    ]);
  });

  it('keeps two sources apart', () => {
    const changes = [
      change({ observedAt: '2026-08-26T00:00:00.000Z' }),
      change({ sourceId: 'openai-llms-txt', observedAt: '2026-08-30T00:00:00.000Z' }),
    ];
    expect([...observationsBySource(changes).keys()]).toEqual([
      'openrouter-models',
      'openai-llms-txt',
    ]);
  });

  // observed_at is the runner's clock. origin_date is when the provider made
  // the bytes, and stale-while-revalidate lets those two drift apart by an hour.
  it('prefers observed_at over the rendered stamp', () => {
    const changes = [change({ observedAt: '2026-08-30T00:00:00.000Z' })];
    expect(observationsBySource(changes).get('openrouter-models')).toEqual([
      '2026-08-30T00:00:00.000Z',
    ]);
  });

  it('falls back to the rendered stamp when no observed_at was stored', () => {
    const changes = [change({ observedAt: null })];
    expect(observationsBySource(changes).get('openrouter-models')).toEqual([
      '2026-08-28T08:08:22.000Z',
    ]);
  });

  it('skips a capture with no usable instant at all', () => {
    const changes = [change({ observedAt: null, stamp: null })];
    expect(observationsBySource(changes).size).toBe(0);
  });
});

describe('deriveEvents', () => {
  // The end-to-end claim: an event's published precision is measured from its
  // own source's capture history, and a configured interval narrower than the
  // real gap must not survive the trip.
  it('gives an event the measured gap of its source rather than the tier interval', () => {
    const changes = [
      change({ kind: 'added', before: null, observedAt: '2026-08-26T00:00:00.000Z' }),
      change({
        observedAt: '2026-08-30T00:00:00.000Z',
        before: catalog([]),
        after: catalog([{ id: 'z-ai/glm-5.3' }]),
      }),
    ];
    const added = deriveEvents(changes).find((e) => e.type === 'model_added');
    expect(added?.type === 'model_added' ? added.precisionSeconds : null).toBe(345600);
  });

  it('gives an event an unbounded precision when its source was seen once', () => {
    const changes = [
      change({
        observedAt: '2026-08-30T00:00:00.000Z',
        stamp: null,
        before: catalog([]),
        after: catalog([{ id: 'z-ai/glm-5.3' }]),
      }),
    ];
    const added = deriveEvents(changes).find((e) => e.type === 'model_added');
    expect(added?.type === 'model_added' ? added.precisionSeconds : null).toBe(Infinity);
  });

  it('measures each source separately', () => {
    const changes = [
      change({ kind: 'added', before: null, observedAt: '2026-08-29T00:00:00.000Z' }),
      change({
        observedAt: '2026-08-30T00:00:00.000Z',
        before: catalog([]),
        after: catalog([{ id: 'z-ai/glm-5.3' }]),
      }),
      change({ sourceId: 'openai-llms-txt', kind: 'added', before: null, observedAt: '2026-08-26T00:00:00.000Z' }),
      change({ sourceId: 'openai-llms-txt', observedAt: '2026-08-30T00:00:00.000Z' }),
    ];
    expect(precisionBySource(changes).get('openai-llms-txt')).toBe(345600);
  });

  // The catalogue source's own gap is one day here and another source in the
  // same set has four. An event may only ever carry its OWN source's number.
  it('gives an event its own source gap when another source in the set is wider', () => {
    const changes = [
      change({ kind: 'added', before: null, observedAt: '2026-08-29T00:00:00.000Z' }),
      change({
        observedAt: '2026-08-30T00:00:00.000Z',
        before: catalog([]),
        after: catalog([{ id: 'z-ai/glm-5.3' }]),
      }),
      change({ sourceId: 'openai-llms-txt', kind: 'added', before: null, observedAt: '2026-08-26T00:00:00.000Z' }),
      change({ sourceId: 'openai-llms-txt', observedAt: '2026-08-30T00:00:00.000Z' }),
    ];
    const added = deriveEvents(changes).find((e) => e.type === 'model_added');
    expect(added?.type === 'model_added' ? added.precisionSeconds : null).toBe(86400);
  });

  // Not in the map at all, which is different from being in it with one entry.
  // The fallback for a source with no readable observation must be unbounded,
  // not the configured interval.
  it('gives an event an unbounded precision when its source has no readable observation', () => {
    const changes = [
      change({
        observedAt: null,
        stamp: null,
        before: catalog([]),
        after: catalog([{ id: 'z-ai/glm-5.3' }]),
      }),
    ];
    const added = deriveEvents(changes).find((e) => e.type === 'model_added');
    expect(added?.type === 'model_added' ? added.precisionSeconds : null).toBe(Infinity);
  });

  it('derives the same events it did before precision was measured', () => {
    const changes = [change({ before: catalog([]), after: catalog([{ id: 'z-ai/glm-5.3' }]) })];
    expect(deriveEvents(changes).map((e) => e.type)).toEqual(['model_added']);
  });
});

describe('event identity', () => {
  it('keys an event by its commit, its type and its subject', () => {
    const events = eventsFromChange(
      change({ before: catalog([]), after: catalog([{ id: 'z-ai/glm-5.3' }]) }),
    );
    expect(only(events, 'model_added').id).toBe(`${SHA}:model_added:z-ai/glm-5.3`);
  });

  it('gives two price fields on one model two distinct ids', () => {
    const events = eventsFromChange(
      change({
        before: catalog([{ id: 'z-ai/glm-5.2', pricing: { prompt: '1', completion: '2' } }]),
        after: catalog([{ id: 'z-ai/glm-5.2', pricing: { prompt: '3', completion: '4' } }]),
      }),
    );
    const ids = events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries the commit sha of the change it was derived from', () => {
    const events = eventsFromChange(
      change({ before: catalog([]), after: catalog([{ id: 'z-ai/glm-5.3' }]) }),
    );
    expect(only(events, 'model_added').sha).toBe(SHA);
  });

  it('carries the stored path so a permalink can be built at that sha', () => {
    const events = eventsFromChange(
      change({ before: catalog([]), after: catalog([{ id: 'z-ai/glm-5.3' }]) }),
    );
    expect(only(events, 'model_added').path).toBe('raw/openrouter-models/response.json');
  });
});

describe('the baseline rule, guard by guard', () => {
  // The two guards in eventsFromChange are independent, and a test that only
  // exercises one of them leaves the other free to be deleted. A capture the
  // archive recorded as an addition emits nothing even when a caller also hands
  // over a body to compare against.
  it('emits nothing for an added capture even when a before was supplied', () => {
    expect(
      eventsFromChange(
        change({
          kind: 'added',
          before: catalog([]),
          after: catalog([{ id: 'z-ai/glm-5.3' }]),
        }),
      ),
    ).toEqual([]);
  });

  it('derives from the same two bodies once the kind says modified', () => {
    expect(
      eventsFromChange(
        change({ kind: 'modified', before: catalog([]), after: catalog([{ id: 'z-ai/glm-5.3' }]) }),
      ),
    ).toHaveLength(1);
  });
});

describe('the dispatcher', () => {
  it('routes the catalogue source to the catalogue reader', () => {
    const events = eventsFromChange(
      change({ before: catalog([]), after: catalog([{ id: 'z-ai/glm-5.3' }]) }),
    );
    expect(events.map((e) => e.type)).toEqual(['model_added']);
  });

  it('routes the deprecations source to the lifecycle reader', () => {
    const events = eventsFromChange(
      change({
        sourceId: 'anthropic-deprecations',
        path: 'raw/anthropic-deprecations/response.md',
        before: deprecationsDoc([]),
        after: deprecationsDoc([['claude-opus-5', 'Active', 'N/A', 'Not sooner than June 9, 2027']]),
      }),
    );
    expect(events.map((e) => e.type)).toEqual(['retirement_floor']);
  });

  it('routes the full-text llms variant to the docs reader', () => {
    const events = eventsFromChange(
      docChange('', '- [Batches](https://console.groq.com/docs/batch.md)', 'groq-llms-full-txt'),
    );
    expect(events.map((e) => e.type)).toEqual(['doc_added']);
  });

  // Only the llms.txt sources are read as documentation indexes. A sitemap
  // carries a provider segment in its id and could otherwise be routed here,
  // and a stray markdown list line in one would become a documentation event
  // attributed to a page the sitemap never claimed to index.
  it('derives no documentation event from a sitemap source', () => {
    expect(
      eventsFromChange(
        change({
          sourceId: 'anthropic-sitemap',
          path: 'raw/anthropic-sitemap/response.xml',
          before: '<urlset>\n</urlset>',
          after: '<urlset>\n- [Models](https://docs.anthropic.com/en/models.md)\n</urlset>',
        }),
      ),
    ).toEqual([]);
  });

  it('derives nothing from a docs source whose id carries no provider', () => {
    expect(eventsFromChange(docChange('', '- [x](https://a.test/docs/x.md)', '-llms-txt'))).toEqual([]);
  });
});

describe('parseCatalog on the shapes a live catalogue ships', () => {
  it('skips an entry that is not an object', () => {
    expect(parseCatalog('{"data":[null,42,"x"]}').size).toBe(0);
  });

  it('skips an entry with no id', () => {
    expect(parseCatalog('{"data":[{"context_length":1}]}').size).toBe(0);
  });

  it('skips an entry whose id is the empty string', () => {
    expect(parseCatalog('{"data":[{"id":""}]}').size).toBe(0);
  });

  it('skips an entry whose id is not a string', () => {
    expect(parseCatalog('{"data":[{"id":7}]}').size).toBe(0);
  });

  it('reads no prices from an entry with no pricing object', () => {
    expect(parseCatalog('{"data":[{"id":"a/b"}]}').get('a/b')?.pricing).toEqual({});
  });

  it('reads a null top_provider as an absent top provider context length', () => {
    expect(parseCatalog('{"data":[{"id":"a/b"}]}').get('a/b')?.topProviderContextLength).toBeNull();
  });

  it('reads a non-numeric created as absent rather than as a number', () => {
    expect(parseCatalog('{"data":[{"id":"a/b","created":"1787752741"}]}').get('a/b')?.created).toBeNull();
  });

  it('throws when the document root is an array rather than an object', () => {
    expect(() => parseCatalog('[]')).toThrow('no `data` array');
  });

  it('throws when data is present but is not an array', () => {
    expect(() => parseCatalog('{"data":{}}')).toThrow('no `data` array');
  });
});

describe('holding a catalogue event whose id names no entity', () => {
  // The catalogue's id shape is `vendor/slug`. An id without the separator is
  // not one, and attaching it to a model thread anyway would put a thread in
  // the generated directory under a name the catalogue never issued.
  it('still emits the event', () => {
    const events = eventsFromChange(
      change({ before: catalog([]), after: catalog([{ id: 'notacatalogid' }]) }),
    );
    expect(events).toHaveLength(1);
  });

  it('marks it held', () => {
    const events = eventsFromChange(
      change({ before: catalog([]), after: catalog([{ id: 'notacatalogid' }]) }),
    );
    expect(events[0]?.held).toBe(true);
  });

  it('marks an event that named an entity as not held', () => {
    const events = eventsFromChange(
      change({ before: catalog([]), after: catalog([{ id: 'z-ai/glm-5.3' }]) }),
    );
    expect(events[0]?.held).toBe(false);
  });
});

describe('the id each event type is keyed by', () => {
  const both = (before: string, after: string) => eventsFromChange(change({ before, after }));

  it('keys a context change by the model it names', () => {
    const e = both(
      catalog([{ id: 'a/b', context_length: 1 }]),
      catalog([{ id: 'a/b', context_length: 2 }]),
    );
    expect(only(e, 'context_changed').id).toBe(`${SHA}:context_changed:a/b`);
  });

  it('keys a price change by the model and the field', () => {
    const e = both(
      catalog([{ id: 'a/b', pricing: { prompt: '1' } }]),
      catalog([{ id: 'a/b', pricing: { prompt: '2' } }]),
    );
    expect(only(e, 'price_changed').id).toBe(`${SHA}:price_changed:a/b:prompt`);
  });

  it('keys an expiration by the model it names', () => {
    const e = both(
      catalog([{ id: 'a/b', expiration_date: null }]),
      catalog([{ id: 'a/b', expiration_date: '2026-09-30' }]),
    );
    expect(only(e, 'expiration_set').id).toBe(`${SHA}:expiration_set:a/b`);
  });

  it('keys an alias retarget by the alias', () => {
    const e = both(
      catalog([{ id: 'a/b', canonical_slug: 'a/b-1' }]),
      catalog([{ id: 'a/b', canonical_slug: 'a/b-2' }]),
    );
    expect(only(e, 'alias_retargeted').id).toBe(`${SHA}:alias_retargeted:a/b`);
  });

  it('keys a removal by the model that left', () => {
    const e = both(catalog([{ id: 'a/b' }]), catalog([]));
    expect(only(e, 'model_removed').id).toBe(`${SHA}:model_removed:a/b`);
  });

  it('keys an added documentation entry by its url', () => {
    const e = eventsFromChange(docChange('', '- [X](https://a.test/docs/x.md)'));
    expect(only(e, 'doc_added').id).toBe(`${SHA}:doc_added:https://a.test/docs/x.md`);
  });

  it('keys a removed documentation entry by its url', () => {
    const e = eventsFromChange(docChange('- [X](https://a.test/docs/x.md)', ''));
    expect(only(e, 'doc_removed').id).toBe(`${SHA}:doc_removed:https://a.test/docs/x.md`);
  });

  it('keys a retirement floor by the API model name', () => {
    const e = eventsFromChange(
      change({
        sourceId: 'anthropic-deprecations',
        path: 'raw/anthropic-deprecations/response.md',
        before: deprecationsDoc([]),
        after: deprecationsDoc([['claude-opus-5', 'Active', 'N/A', 'August 5, 2026']]),
      }),
    );
    expect(only(e, 'retirement_floor').id).toBe(`${SHA}:retirement_floor:claude-opus-5`);
  });
});

describe('parseDocIndex line shapes', () => {
  it('reads an indented entry, which a nested list produces', () => {
    expect([...parseDocIndex('  - [X](https://a.test/docs/x.md)').keys()]).toEqual([
      'https://a.test/docs/x.md',
    ]);
  });

  it('ignores a dash immediately followed by a bracket, which is not an entry', () => {
    expect(parseDocIndex('-[X](https://a.test/docs/x.md)').size).toBe(0);
  });

  it('keeps the first title when one url is listed twice', () => {
    const text = ['- [First](https://a.test/docs/x.md)', '- [Second](https://a.test/docs/x.md)'].join('\n');
    expect(parseDocIndex(text).get('https://a.test/docs/x.md')).toBe('First');
  });

  it('stops the url at the closing parenthesis rather than running past it', () => {
    expect([...parseDocIndex('- [X](https://a.test/docs/x.md) trailing (text)').keys()]).toEqual([
      'https://a.test/docs/x.md',
    ]);
  });
});

describe('parseFloorDate across every month name', () => {
  it('maps all twelve months to their numbers', () => {
    const cells = [
      'January 1, 2027',
      'February 2, 2027',
      'March 3, 2027',
      'April 4, 2027',
      'May 5, 2027',
      'June 6, 2027',
      'July 7, 2027',
      'August 8, 2027',
      'September 9, 2027',
      'October 10, 2027',
      'November 11, 2027',
      'December 12, 2027',
    ];
    expect(cells.map(parseFloorDate)).toEqual([
      '2027-01-01',
      '2027-02-02',
      '2027-03-03',
      '2027-04-04',
      '2027-05-05',
      '2027-06-06',
      '2027-07-07',
      '2027-08-08',
      '2027-09-09',
      '2027-10-10',
      '2027-11-11',
      '2027-12-12',
    ]);
  });

  it('returns null for a month name the table does not hold', () => {
    expect(parseFloorDate('Smarch 9, 2027')).toBeNull();
  });

  it('reads a two digit day without truncating it', () => {
    expect(parseFloorDate('November 24, 2026')).toBe('2026-11-24');
  });

  it('requires a space between the month and the day', () => {
    expect(parseFloorDate('November24, 2026')).toBeNull();
  });

  it('requires a four digit year', () => {
    expect(parseFloorDate('November 24, 26')).toBeNull();
  });
});

describe('parseDeprecationTable, the document shapes it must survive', () => {
  it('strips the backticks the document wraps a model name in', () => {
    const doc = [
      '| API model name | Current state | Deprecated | Tentative retirement date |',
      '| --- | --- | --- | --- |',
      '| `claude-opus-5` | Active | N/A | August 5, 2026 |',
    ].join('\n');
    expect([...parseDeprecationTable(doc).keys()]).toEqual(['claude-opus-5']);
  });

  it('finds the table when it is the first line of the document', () => {
    const doc = [
      '| API model name | Current state | Deprecated | Tentative retirement date |',
      '| --- | --- | --- | --- |',
      '| claude-opus-5 | Active | N/A | August 5, 2026 |',
    ].join('\n');
    expect(parseDeprecationTable(doc).get('claude-opus-5')).toBe('August 5, 2026');
  });

  // Leaving the table on a non-row is what stops a later four-column table
  // being read as more lifecycle rows.
  it('stops at the end of the table rather than absorbing a later four column table', () => {
    const doc = [
      '| API model name | Current state | Deprecated | Tentative retirement date |',
      '| --- | --- | --- | --- |',
      '| claude-opus-5 | Active | N/A | August 5, 2026 |',
      '',
      '| Feature | Status | Since | Notes |',
      '| --- | --- | --- | --- |',
      '| batch | GA | 2026 | none |',
    ].join('\n');
    expect([...parseDeprecationTable(doc).keys()]).toEqual(['claude-opus-5']);
  });

  it('ignores a four column table whose header is not the lifecycle header', () => {
    const doc = [
      '| Feature | Status | Since | Notes |',
      '| --- | --- | --- | --- |',
      '| batch | GA | 2026 | none |',
    ].join('\n');
    expect(parseDeprecationTable(doc).size).toBe(0);
  });

  it('ignores a line that is not a table row at all', () => {
    expect(parseDeprecationTable('API model name is a phrase, not a row').size).toBe(0);
  });

  it('keeps the first row when one model name is listed twice', () => {
    const doc = [
      '| API model name | Current state | Deprecated | Tentative retirement date |',
      '| --- | --- | --- | --- |',
      '| claude-opus-5 | Active | N/A | August 5, 2026 |',
      '| claude-opus-5 | Active | N/A | September 5, 2026 |',
    ].join('\n');
    expect(parseDeprecationTable(doc).get('claude-opus-5')).toBe('August 5, 2026');
  });
});

describe('holding a retirement row whose model name names no entity', () => {
  const doc = (name: string) =>
    deprecationsDoc([[name, 'Active', 'N/A', 'Not sooner than June 9, 2027']]);

  it('marks a row whose name carries a vendor separator as held', () => {
    const e = eventsFromChange(
      change({
        sourceId: 'anthropic-deprecations',
        path: 'raw/anthropic-deprecations/response.md',
        before: deprecationsDoc([]),
        after: doc('anthropic/claude-opus-5'),
      }),
    );
    expect(e[0]?.held).toBe(true);
  });

  it('marks an ordinary API model name as not held', () => {
    const e = eventsFromChange(
      change({
        sourceId: 'anthropic-deprecations',
        path: 'raw/anthropic-deprecations/response.md',
        before: deprecationsDoc([]),
        after: doc('claude-opus-5'),
      }),
    );
    expect(e[0]?.held).toBe(false);
  });
});

describe('parseDocIndex, the boundaries of what counts as an entry', () => {
  it('reads an entry with more than one space after the dash', () => {
    expect([...parseDocIndex('-  [X](https://a.test/docs/x.md)').keys()]).toEqual([
      'https://a.test/docs/x.md',
    ]);
  });

  // An index entry starts a line. A dash and a bracket in the middle of prose,
  // which a page description can easily contain, is not an entry.
  it('ignores an entry shape appearing part way through a line', () => {
    expect(parseDocIndex('see also - [X](https://a.test/docs/x.md)').size).toBe(0);
  });

  it('trims a title padded inside its brackets', () => {
    expect(parseDocIndex('- [  X  ](https://a.test/docs/x.md)').get('https://a.test/docs/x.md')).toBe('X');
  });
});

describe('holding a removed documentation entry', () => {
  it('marks a removal whose url has no section as held', () => {
    const e = eventsFromChange(docChange('- [Home](https://developers.openai.com/index.md)', ''));
    expect(e[0]?.held).toBe(true);
  });

  it('marks a removal whose url names a section as not held', () => {
    const e = eventsFromChange(docChange('- [X](https://developers.openai.com/api/docs/x.md)', ''));
    expect(e[0]?.held).toBe(false);
  });

  it('marks an addition whose url names a section as not held', () => {
    const e = eventsFromChange(docChange('', '- [X](https://developers.openai.com/api/docs/x.md)'));
    expect(e[0]?.held).toBe(false);
  });
});

describe('parseFloorDate spacing', () => {
  it('reads a cell with no space after the comma', () => {
    expect(parseFloorDate('August 5,2026')).toBe('2026-08-05');
  });

  it('reads a cell with two spaces after the comma', () => {
    expect(parseFloorDate('August 5,  2026')).toBe('2026-08-05');
  });
});

describe('parseDeprecationTable row shapes', () => {
  it('reads a row indented ahead of its leading pipe', () => {
    const doc = [
      '| API model name | Current state | Deprecated | Tentative retirement date |',
      '| --- | --- | --- | --- |',
      '  | claude-opus-5 | Active | N/A | August 5, 2026 |',
    ].join('\n');
    expect(parseDeprecationTable(doc).get('claude-opus-5')).toBe('August 5, 2026');
  });

  it('skips a row whose model name cell is empty', () => {
    const doc = [
      '| API model name | Current state | Deprecated | Tentative retirement date |',
      '| --- | --- | --- | --- |',
      '|  | Active | N/A | August 5, 2026 |',
    ].join('\n');
    expect(parseDeprecationTable(doc).size).toBe(0);
  });
});

describe('parseDeprecationTable, lines that only look like rows', () => {
  // Once inside the table, a prose line carrying three pipes has four
  // pipe-separated fields and would be read as a model row. Requiring a leading
  // pipe is what ends the table at the first line that is not one.
  it('does not read a prose line carrying pipes as a table row', () => {
    const doc = [
      '| API model name | Current state | Deprecated | Tentative retirement date |',
      '| --- | --- | --- | --- |',
      '| claude-opus-5 | Active | N/A | August 5, 2026 |',
      'write it as name | state | deprecated | date',
    ].join('\n');
    expect([...parseDeprecationTable(doc).keys()]).toEqual(['claude-opus-5']);
  });

  // The separator is a cell that is ENTIRELY dashes. A name that merely starts
  // with one is a name.
  it('keeps a model name that ends with a dash', () => {
    const doc = [
      '| API model name | Current state | Deprecated | Tentative retirement date |',
      '| --- | --- | --- | --- |',
      '| claude-preview- | Active | N/A | August 5, 2026 |',
    ].join('\n');
    expect([...parseDeprecationTable(doc).keys()]).toEqual(['claude-preview-']);
  });

  it('keeps a model name that begins with a dash', () => {
    const doc = [
      '| API model name | Current state | Deprecated | Tentative retirement date |',
      '| --- | --- | --- | --- |',
      '| -preview-model | Active | N/A | August 5, 2026 |',
    ].join('\n');
    expect([...parseDeprecationTable(doc).keys()]).toEqual(['-preview-model']);
  });
});
