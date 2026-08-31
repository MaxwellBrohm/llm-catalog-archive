/**
 * The thread pages. Pure over a ThreadSet, so every guard is asserted from a
 * literal rather than from a fixture repository.
 */

import { describe, it, expect } from 'vitest';
import { renderThreadPage, renderThreadsIndex, threadPagePath, THREADS_INDEX_PATH } from '../src/site/render.js';
import { buildThreads } from '../src/derive/threads.js';
import { deriveEvents, eventsFromChange } from '../src/derive/events.js';
import { buildSite } from '../src/site/build.js';
import { catalog, change, SHA } from './derive-fixtures.js';
import { record } from './site-fixtures.js';

/**
 * Two captures of one fast-tier source 7h48m apart, which is the worst gap
 * measured on the live runner. deriveEvents rather than eventsFromChange,
 * because precision is a property of a source's capture history and a single
 * change carries none.
 */
const addedSet = buildThreads(
  deriveEvents([
    change({
      tier: 'fast',
      kind: 'added',
      before: null,
      observedAt: '2026-08-28T00:20:00.000Z',
      after: catalog([]),
    }),
    change({
      tier: 'fast',
      observedAt: '2026-08-28T08:08:00.000Z',
      before: catalog([]),
      after: catalog([{ id: 'anthropic/claude-opus-5' }]),
    }),
  ]),
);

const contextSet = buildThreads(
  eventsFromChange(
    change({
      before: catalog([
        { id: 'deepseek/deepseek-chat', context_length: 128000, top_provider_context_length: 128000 },
      ]),
      after: catalog([
        { id: 'deepseek/deepseek-chat', context_length: 65536, top_provider_context_length: 1048576 },
      ]),
    }),
  ),
);

const modelThread = addedSet.threads.find((t) => t.entity.kind === 'model');
const contextThread = contextSet.threads.find((t) => t.entity.kind === 'model');
if (modelThread === undefined || contextThread === undefined) throw new Error('fixture built no model thread');

describe('renderThreadPage', () => {
  it('prints the claim sentence for the event on the thread', () => {
    expect(renderThreadPage(modelThread)).toContain(
      "anthropic/claude-opus-5 entered OpenRouter&#39;s catalog.",
    );
  });

  it('titles the page with the entity label', () => {
    expect(renderThreadPage(modelThread)).toContain(
      '<title>anthropic/claude-opus-5 - llm-catalog-archive</title>',
    );
  });

  it('prints the entity id the permalink is built from', () => {
    expect(renderThreadPage(modelThread)).toContain('model/openrouter:anthropic/claude-opus-5');
  });

  // R5 overwrites one path in place, so a HEAD link would show whatever the
  // artifact later became rather than the bytes the claim was read out of.
  it('links the raw artifact at the commit sha the event carries', () => {
    expect(renderThreadPage(modelThread)).toContain(
      `https://github.com/MaxwellBrohm/llm-catalog-archive/blob/${SHA}/raw/openrouter-models/response.json`,
    );
  });

  it('links no artifact at HEAD', () => {
    expect(renderThreadPage(modelThread)).not.toContain('/blob/HEAD/');
  });

  it('links no artifact at a branch name', () => {
    expect(renderThreadPage(modelThread)).not.toContain('/blob/main/');
  });

  it('links back to the change page for the commit the event came from', () => {
    expect(renderThreadPage(modelThread)).toContain(`href="../changes/${SHA}.html"`);
  });

  // Spec section 10.1: a reader must be able to see the routing explanation
  // without the page asserting one, and the pair of numbers is how.
  it('prints the top_provider context length on the before side of a context change', () => {
    expect(renderThreadPage(contextThread)).toContain(
      '<th>top_provider.context_length before</th><td>128000</td>',
    );
  });

  it('prints the top_provider context length on the after side of a context change', () => {
    expect(renderThreadPage(contextThread)).toContain(
      '<th>top_provider.context_length after</th><td>1048576</td>',
    );
  });

  it('labels an origin timestamp as origin', () => {
    expect(renderThreadPage(modelThread)).toContain('<span class="badge badge-origin">origin</span>');
  });

  // Spec section 9: where the provider sent no Age the sidecar records a null
  // origin, and the page shows observed_at LABELLED as observed rather than
  // silently substituting it under the origin label.
  it('labels an observed timestamp as observed', () => {
    const observed = buildThreads(
      eventsFromChange(
        change({
          tier: 'fast',
          stamp: { iso: '2026-08-28T11:23:40.960Z', kind: 'observed' },
          before: catalog([]),
          after: catalog([{ id: 'anthropic/claude-opus-5' }]),
        }),
      ),
    ).threads[0];
    if (observed === undefined) throw new Error('fixture built no thread');
    expect(renderThreadPage(observed)).toContain('<span class="badge badge-observed">observed</span>');
  });

  it('shows the first-seen day when the measured error is under a day', () => {
    expect(renderThreadPage(modelThread)).toContain(
      '<th>first seen in the catalog</th><td>2026-08-28</td>',
    );
  });

  // The precision field is load-bearing rather than decorative. Four days
  // between two accepted captures is four days of first-seen error, whatever
  // the cron asked for.
  it('refuses the first-seen day when the measured error is over a day', () => {
    const wide = buildThreads(
      deriveEvents([
        change({
          tier: 'fast',
          kind: 'added',
          before: null,
          observedAt: '2026-08-24T08:08:00.000Z',
          after: catalog([]),
        }),
        change({
          tier: 'fast',
          observedAt: '2026-08-28T08:08:00.000Z',
          before: catalog([]),
          after: catalog([{ id: 'anthropic/claude-opus-5' }]),
        }),
      ]),
    ).threads[0];
    if (wide === undefined) throw new Error('fixture built no thread');
    expect(renderThreadPage(wide)).toContain(
      '<th>first seen in the catalog</th><td>not shown: the worst-case error is wider than a day</td>',
    );
  });

  it('prints the measured worst-case error, not the configured poll interval', () => {
    expect(renderThreadPage(modelThread)).toContain(
      "<th>first-seen worst-case error</th><td>28,080 seconds, measured from this source&#39;s capture history</td>",
    );
  });

  // Infinity through formatInt renders "Inf,ini,ty". The unbounded case is a
  // real value of this field, so it is spelled out and says why.
  it('spells out an unbounded error rather than formatting infinity as an integer', () => {
    const once = buildThreads(
      deriveEvents([
        change({
          tier: 'fast',
          observedAt: '2026-08-28T08:08:00.000Z',
          before: catalog([]),
          after: catalog([{ id: 'anthropic/claude-opus-5' }]),
        }),
      ]),
    ).threads[0];
    if (once === undefined) throw new Error('fixture built no thread');
    expect(renderThreadPage(once)).toContain(
      '<th>first-seen worst-case error</th><td>unbounded: the archive holds one capture of this source</td>',
    );
  });

  it('refuses the first-seen day when the error is unbounded', () => {
    const once = buildThreads(
      deriveEvents([
        change({
          tier: 'fast',
          observedAt: '2026-08-28T08:08:00.000Z',
          before: catalog([]),
          after: catalog([{ id: 'anthropic/claude-opus-5' }]),
        }),
      ]),
    ).threads[0];
    if (once === undefined) throw new Error('fixture built no thread');
    expect(renderThreadPage(once)).toContain(
      '<th>first seen in the catalog</th><td>not shown: the worst-case error is wider than a day</td>',
    );
  });

  it('escapes a title carried in from provider bytes', () => {
    const set = buildThreads(
      eventsFromChange(
        change({
          sourceId: 'openai-llms-txt',
          path: 'raw/openai-llms-txt/response.txt',
          before: '',
          after: '- [<script>x</script>](https://developers.openai.com/api/docs/a.md)',
        }),
      ),
    );
    const thread = set.threads[0];
    if (thread === undefined) throw new Error('fixture built no thread');
    expect(renderThreadPage(thread)).not.toContain('<script>x</script>');
  });
});

describe('renderThreadsIndex', () => {
  it('links every thread it lists at that thread slug', () => {
    expect(renderThreadsIndex(addedSet)).toContain('href="lab-anthropic.html"');
  });

  // Two events over three threads, so a count that reported the thread total
  // under the attachment label would print the wrong number here. With one
  // event on two threads the two numbers agree and the label is untested.
  it('counts the threads it holds and the attachments they carry', () => {
    const twoModels = buildThreads(
      eventsFromChange(
        change({
          before: catalog([]),
          after: catalog([{ id: 'anthropic/claude-opus-5' }, { id: 'anthropic/claude-sonnet-5' }]),
        }),
      ),
    );
    expect(renderThreadsIndex(twoModels)).toContain('3 threads carrying 4 event attachments');
  });

  it('says so plainly when nothing was held', () => {
    expect(renderThreadsIndex(addedSet)).toContain('No event was held.');
  });

  it('lists a held event rather than hiding it', () => {
    const held = buildThreads(
      eventsFromChange(
        change({
          sourceId: 'openai-llms-txt',
          path: 'raw/openai-llms-txt/response.txt',
          before: '',
          after: '- [Home](https://developers.openai.com/index.md)',
        }),
      ),
    );
    expect(renderThreadsIndex(held)).toContain(
      'The openai-llms-txt index added an entry titled &quot;Home&quot; at https://developers.openai.com/index.md.',
    );
  });

  it('reports the held count', () => {
    const held = buildThreads(
      eventsFromChange(
        change({
          sourceId: 'openai-llms-txt',
          path: 'raw/openai-llms-txt/response.txt',
          before: '',
          after: '- [Home](https://developers.openai.com/index.md)',
        }),
      ),
    );
    expect(renderThreadsIndex(held)).toContain('1 event could not be attached to an entity');
  });
});

describe('buildSite with threads', () => {
  it('emits a page at the permalink each thread names', () => {
    const files = buildSite([record()], 'https://example.test', addedSet);
    expect(files.map((f) => f.path)).toContain(threadPagePath('lab-anthropic'));
  });

  it('emits the threads index', () => {
    const files = buildSite([record()], 'https://example.test', addedSet);
    expect(files.map((f) => f.path)).toContain(THREADS_INDEX_PATH);
  });

  // The change pages are the evidence layer under the threads. A thread with no
  // resolvable evidence under it is an opinion.
  it('keeps the per-commit change page beside the thread pages', () => {
    const files = buildSite([record()], 'https://example.test', addedSet);
    expect(files.map((f) => f.path)).toContain(
      'changes/a0a9e12e5287b8ce564e6de63a280498413484cf.html',
    );
  });

  it('emits the threads index even when nothing derived', () => {
    const files = buildSite([record()], 'https://example.test');
    expect(files.filter((f) => f.path === THREADS_INDEX_PATH)).toHaveLength(1);
  });

  it('puts a threads link in the navigation of a change page', () => {
    const files = buildSite([record()], 'https://example.test', addedSet);
    const page = files.find((f) => f.path.startsWith('changes/'));
    expect(page?.contents).toContain('<a href="../threads/index.html">Threads</a>');
  });
});
