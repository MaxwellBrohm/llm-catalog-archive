/**
 * TWO ENTITIES THAT FOLD TO ONE SLUG, THROUGH THE WHOLE GENERATOR.
 *
 * From 2026-10-21 every deploy stopped at "thread slug collision": Mistral's
 * llms.txt gained `studio/audio/text-to-speech/` pages beside the
 * `studio/audio/text_to_speech/` section the archive had held since September,
 * and both fold to one thread slug. buildThreads now gives the newcomer a
 * suffixed slug (test/derive-threads.test.ts pins the rule). What this file
 * pins is the other half, and it is the half that fails silently: EVERY place
 * that links to a thread has to link to the slug the thread was published
 * under. A chip, a tape row or an API record that refolded an entity id for
 * itself would build cleanly and send a reader to the other entity's page.
 *
 * So the fixture is a real derivation over both collisions this repository
 * can produce (a docs section and an OpenRouter catalogue id), and the checks
 * read every link out of every emitted page and file.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { deriveEvents, type ContentChange } from '../src/derive/events.js';
import { deriveLeaks } from '../src/derive/leaks.js';
import { buildFeed } from '../src/derive/feed.js';
import { buildThreads, type Thread } from '../src/derive/threads.js';
import { buildSite, textContents } from '../src/site/build.js';
import { buildApi } from '../src/api/build.js';
import { escapeHtml } from '../src/site/record.js';
import { catalog, change, docChange } from './derive-fixtures.js';

const SITE = 'https://example.test';
const digest8 = (id: string): string => createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 8);
const at = (iso: string) => ({ stamp: { iso, kind: 'origin' as const }, observedAt: iso });

const SEPT = '2026-09-24T12:06:31.000Z';
const OCT = '2026-10-20T19:20:33.000Z';
const LATER = '2026-10-25T08:00:00.000Z';

const doc = (path: string, title: string): string => `- [${title}](https://docs.mistral.ai/studio/audio/${path}.md): ${title}.`;
const SEPT_DOCS = [doc('text_to_speech/speech', 'Speech Generation'), doc('text_to_speech/voices', 'Voices')].join('\n');
const OCT_DOCS = [
  doc('text_to_speech/voices', 'Voices'),
  doc('text-to-speech/overview', 'Text to Speech'),
  doc('text-to-speech/voices', 'Voice library'),
].join('\n');
const LATER_DOCS = [OCT_DOCS, doc('text-to-speech/streaming', 'Streaming')].join('\n');

const OLD_MODEL = 'mistralai/voxtral-1.5';
const NEW_MODEL = 'mistralai/voxtral-1-5';
const price = (prompt: string) => ({ prompt, completion: '0.000002' });

/** Newest first, the order readContentChanges returns them in. */
const CHANGES: ContentChange[] = [
  // A price change on the NEWCOMER model, so the front page draws a tape row
  // whose link has to reach the newcomer's thread rather than the old one's,
  // and an expiration date, so the leaks desk draws a chip for it too.
  change({
    sha: 'f'.repeat(40),
    ...at(LATER),
    before: catalog([{ id: OLD_MODEL }, { id: NEW_MODEL }]),
    after: catalog([{ id: OLD_MODEL }, { id: NEW_MODEL, pricing: price('0.000003'), expiration_date: '2026-12-01' }]),
  }),
  { ...docChange(OCT_DOCS, LATER_DOCS, 'mistral-llms-txt'), sha: 'e'.repeat(40), ...at(LATER) },
  change({
    sha: 'd'.repeat(40),
    ...at(OCT),
    before: catalog([{ id: OLD_MODEL }]),
    after: catalog([{ id: OLD_MODEL }, { id: NEW_MODEL }]),
  }),
  { ...docChange(SEPT_DOCS, OCT_DOCS, 'mistral-llms-txt'), sha: 'c'.repeat(40), ...at(OCT) },
  change({ sha: 'b'.repeat(40), ...at(SEPT), before: catalog([]), after: catalog([{ id: OLD_MODEL }]) }),
  { ...docChange('', SEPT_DOCS, 'mistral-llms-txt'), sha: 'a'.repeat(40), ...at(SEPT) },
];

const LEAKS = deriveLeaks(CHANGES);
const FEED = buildFeed(deriveEvents(CHANGES), LEAKS);
const THREADS = buildThreads(FEED);
const SITE_FILES = buildSite([], SITE, THREADS, LEAKS, [], FEED, [], []);
const API_FILES = buildApi({ feed: FEED, threads: THREADS, refusals: [], ledger: [], changes: CHANGES, siteUrl: SITE });

const OLD_DOCS_ID = 'api-surface/docs.mistral.ai/studio/audio/text_to_speech';
const NEW_DOCS_ID = 'api-surface/docs.mistral.ai/studio/audio/text-to-speech';
const DOCS_PLAIN = 'api-surface-docs-mistral-ai-studio-audio-text-to-speech';
const OLD_MODEL_ID = `model/openrouter:${OLD_MODEL}`;
const NEW_MODEL_ID = `model/openrouter:${NEW_MODEL}`;
const MODEL_PLAIN = 'model-openrouter-mistralai-voxtral-1-5';

const byId = new Map<string, Thread>(THREADS.threads.map((t) => [t.entity.id, t]));
const bySlug = new Map<string, Thread>(THREADS.threads.map((t) => [t.slug, t]));
const thread = (id: string): Thread => {
  const t = byId.get(id);
  if (t === undefined) throw new Error(`fixture produced no thread for ${id}`);
  return t;
};

/** Every HTML page the build emitted, minus the legacy /site/ forwarding stubs. */
const PAGES = SITE_FILES.filter((f) => f.path.endsWith('.html') && !f.path.startsWith('site/')).map((f) => ({
  path: f.path,
  html: textContents(f),
}));
const EMITTED = new Set(SITE_FILES.map((f) => f.path));

/** `<a class="chip" href="../threads/<slug>.html">...<code>label</code></a>` on every page. */
const CHIP = /<a class="chip" href="(?:\.\.\/)*threads\/([^"]+)\.html"><span class="chip-kind">[^<]*<\/span><code>([^<]*)<\/code><\/a>/g;
/** The tape's per-model heading: `<a href="threads/<slug>.html">model id</a>`. */
const TAPE = /<tr class="tape-model"><th colspan="5" scope="colgroup"><a href="(?:\.\.\/)*threads\/([^"]+)\.html">([^<]*)<\/a><\/th><\/tr>/g;
const ANY_THREAD_HREF = /href="(?:\.\.\/)*(threads\/[^"#]+\.html)"/g;

describe('the fixture', () => {
  // If these stopped colliding, every check below would pass for the wrong reason.
  it('holds both collisions this repository can produce, each pair folding to one plain slug', () => {
    expect(thread(OLD_DOCS_ID).slug).toBe(DOCS_PLAIN);
    expect(thread(NEW_DOCS_ID).slug.startsWith(`${DOCS_PLAIN}-`)).toBe(true);
    expect(thread(OLD_MODEL_ID).slug).toBe(MODEL_PLAIN);
    expect(thread(NEW_MODEL_ID).slug.startsWith(`${MODEL_PLAIN}-`)).toBe(true);
  });
});

describe('a site built over two entities that fold to one slug', () => {
  it('builds, rather than stopping every deploy', () => {
    expect(SITE_FILES.length).toBeGreaterThan(0);
  });

  it('publishes the older entity at the address it has always had and the newcomer beside it', () => {
    for (const path of [
      `threads/${DOCS_PLAIN}.html`,
      `threads/${DOCS_PLAIN}-${digest8(NEW_DOCS_ID)}.html`,
      `threads/${MODEL_PLAIN}.html`,
      `threads/${MODEL_PLAIN}-${digest8(NEW_MODEL_ID)}.html`,
    ]) {
      expect(EMITTED.has(path), path).toBe(true);
    }
  });

  it('puts each entity on its own page, never the other one\'s', () => {
    for (const t of THREADS.threads) {
      const page = PAGES.find((p) => p.path === `threads/${t.slug}.html`);
      expect(page?.html, t.slug).toContain(`<p class="sha-full"><code>${escapeHtml(t.entity.id)}</code></p>`);
    }
  });

  it('points every entity chip on every page at the thread of the entity it names', () => {
    const wrong: string[] = [];
    const seen = new Set<string>();
    for (const { path, html } of PAGES) {
      for (const [, slug, label] of html.matchAll(CHIP)) {
        const target = bySlug.get(slug!);
        seen.add(slug!);
        if (target === undefined || escapeHtml(target.entity.label) !== label) {
          wrong.push(`${path}: chip ${label} -> threads/${slug}.html (${target?.entity.label ?? 'no such thread'})`);
        }
      }
    }
    expect(wrong).toEqual([]);
    // The check means something only if the newcomers' chips were drawn.
    expect(seen.has(thread(NEW_DOCS_ID).slug)).toBe(true);
    expect(seen.has(thread(NEW_MODEL_ID).slug)).toBe(true);
  });

  // Separately, because the desk renders its items from the leaks themselves
  // rather than from the feed, so it is a path of its own to get wrong.
  it('points the leaks desk chip for the newcomer model at the newcomer\'s thread', () => {
    const desk = PAGES.find((p) => p.path === 'leaks/index.html')!.html;
    const chips = [...desk.matchAll(CHIP)].map(([, slug, label]) => [label, slug]);
    expect(chips).toContainEqual([NEW_MODEL, thread(NEW_MODEL_ID).slug]);
  });

  it('points the front page tape row for each model at that model\'s own thread', () => {
    const index = PAGES.find((p) => p.path === 'index.html')!.html;
    const rows = [...index.matchAll(TAPE)].map(([, slug, label]) => [label, slug]);
    expect(rows).toContainEqual([NEW_MODEL, thread(NEW_MODEL_ID).slug]);
    for (const [label, slug] of rows) expect(bySlug.get(slug!)?.entity.label).toBe(label);
  });

  // The plain address holds the OLDER entity, which is not necessarily the one
  // a reader can see in the provider's docs today, so each page of a collision
  // names the other.
  it('names, on each page of a collision, the other entity that folds to its address', () => {
    const note = (t: Thread): string[] => {
      const html = PAGES.find((p) => p.path === `threads/${t.slug}.html`)!.html;
      const p = /<p class="note foldmates">(.*?)<\/p>/.exec(html)?.[1] ?? '';
      return [...p.matchAll(/<a href="([^"]+)\.html">/g)].map(([, slug]) => slug!);
    };
    for (const [a, b] of [
      [OLD_DOCS_ID, NEW_DOCS_ID],
      [NEW_DOCS_ID, OLD_DOCS_ID],
      [OLD_MODEL_ID, NEW_MODEL_ID],
      [NEW_MODEL_ID, OLD_MODEL_ID],
    ] as const) {
      expect(note(thread(a)), a).toEqual([thread(b).slug]);
    }
  });

  it('adds no such note to a thread that collides with nothing', () => {
    const lab = PAGES.find((p) => p.path === 'threads/lab-mistral.html')!.html;
    expect(lab).not.toContain('foldmates');
  });

  it('links to no thread page the build did not emit', () => {
    const dead: string[] = [];
    for (const { path, html } of PAGES) {
      for (const [, target] of html.matchAll(ANY_THREAD_HREF)) {
        if (!EMITTED.has(target!)) dead.push(`${path} -> ${target}`);
      }
    }
    expect(dead).toEqual([]);
  });
});

describe('an API built over two entities that fold to one slug', () => {
  const docs = API_FILES.filter((f) => f.path.endsWith('.json')).map((f) => ({
    path: f.path,
    value: JSON.parse(textContents(f)) as unknown,
  }));

  /** Every `{ id, slug, thread }` entity record anywhere in the API. */
  function entityRecords(value: unknown, out: { id: string; slug: string; thread: string }[] = []) {
    if (Array.isArray(value)) for (const v of value) entityRecords(v, out);
    else if (value !== null && typeof value === 'object') {
      const o = value as Record<string, unknown>;
      if (typeof o['id'] === 'string' && typeof o['slug'] === 'string' && typeof o['thread'] === 'string') {
        out.push({ id: o['id'], slug: o['slug'], thread: o['thread'] });
      }
      for (const v of Object.values(o)) entityRecords(v, out);
    }
    return out;
  }

  it('gives every entity record the slug and thread URL its thread was published under', () => {
    const records = docs.flatMap((d) => entityRecords(d.value).map((r) => ({ ...r, path: d.path })));
    const wrong = records.filter((r) => {
      const t = byId.get(r.id);
      return t === undefined || r.slug !== t.slug || r.thread !== `${SITE}/threads/${t.slug}.html`;
    });
    expect(wrong).toEqual([]);
    expect(records.some((r) => r.id === NEW_DOCS_ID)).toBe(true);
    expect(records.some((r) => r.id === NEW_MODEL_ID)).toBe(true);
  });

  it('writes one per-model file per model thread, each carrying its own entity', () => {
    for (const id of [OLD_MODEL_ID, NEW_MODEL_ID]) {
      const t = thread(id);
      const file = docs.find((d) => d.path === `api/v1/models/${t.slug}.json`);
      expect((file?.value as { entity?: { id?: string } } | undefined)?.entity?.id, id).toBe(id);
    }
  });

  it('points each models.json row at its own per-model file', () => {
    const models = (docs.find((d) => d.path === 'api/v1/models.json')?.value as {
      models: { id: string; slug: string; api: string | null }[];
    }).models;
    for (const [model, id] of [
      [OLD_MODEL, OLD_MODEL_ID],
      [NEW_MODEL, NEW_MODEL_ID],
    ] as const) {
      const row = models.find((m) => m.id === model);
      expect(row, model).toEqual(
        expect.objectContaining({ slug: thread(id).slug, api: `${SITE}/api/v1/models/${thread(id).slug}.json` }),
      );
    }
  });
});
