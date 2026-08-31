import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  ARENA_MIN_RECORDS,
  SHARED_LASTMOD_FLOOR,
  applyMask,
  changedUnderPredicate,
  extractArena,
  extractAtomStatus,
  extractSitemapDated,
  extractSitemapLoc,
  extractXai,
  project,
} from '../src/predicate.js';
import { loadSources } from '../src/config.js';
import type { Source } from '../src/config.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

const shipped = (): Source[] =>
  loadSources(JSON.parse(fs.readFileSync('meta/sources.json', 'utf8'))).sources;

const sourceFor = (id: string): Source => shipped().find((s) => s.id === id)!;

const fixture = (name: string): string => fs.readFileSync(`test/fixtures/${name}`, 'utf8');

describe('extractArena', () => {
  /**
   * The three volatile regions, verbatim from the live page, wrapped around a
   * record block. Every quote is escaped the way the flight payload escapes
   * it, because that escaping is the thing the extractor has to see through.
   */
  const arenaPage = (opts: { userId: string; flag: string; ray: string; records: string[] }): string =>
    `<!DOCTYPE html><html><head><script>` +
    `window.__CF$cv$params={r:'${opts.ray}',t:'MTc4ODIxNDU2OA=='};` +
    `</script></head><body><script>self.__next_f.push([1,"19:[\\"$\\",\\"$L28\\",null,` +
    `{\\"user\\":null,\\"userId\\":\\"${opts.userId}\\",\\"userState\\":\\"provisional\\",` +
    `\\"posthogFlags\\":{\\"email-optin-copy\\":\\"${opts.flag}\\"}}]"])</script>` +
    `<script>self.__next_f.push([1,"7:{\\"entries\\":[${opts.records.join(',')}]}"])</script>` +
    `</body></html>`;

  const record = (key: string, display: string, rating: string, votes: number): string =>
    `{\\"rank\\":1,\\"modelKey\\":\\"${key}\\",\\"modelDisplayName\\":\\"${display}\\",` +
    `\\"rating\\":${rating},\\"ratingUpper\\":1512.5,\\"ratingLower\\":1502.4,\\"votes\\":${votes}}`;

  const filler = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => record(`m-${i}-text`, `m-${i}`, `${1000 + i}.5`, 100 + i));

  it('projects the four fields of a record as one tab separated row', () => {
    const page = arenaPage({
      userId: 'x',
      flag: 'a',
      ray: 'r',
      records: [record('claude-fable-5-text', 'claude-fable-5', '1507.4767250288949', 25824), ...filler(499)],
    });
    const got = extractArena(page);
    expect(got.ok).toBe(true);
    expect(got.ok && got.key.split('\n')).toContain(
      'claude-fable-5-text\tclaude-fable-5\t1507.4767250288949\t25824',
    );
  });

  it('projects two responses differing only in userId, posthogFlags and cf-ray to the same key', () => {
    const records = filler(ARENA_MIN_RECORDS);
    const a = extractArena(
      arenaPage({ userId: '01a059e4-e799-7a2f-abe7-d733982df1ee', flag: 'treatment-5', ray: 'a33f65df080eae4c', records }),
    );
    const b = extractArena(
      arenaPage({ userId: '01a05a11-0000-7a2f-abe7-000000000000', flag: 'control', ray: 'a33f65f54e26a506', records }),
    );
    expect(a.ok && b.ok && a.key === b.key).toBe(true);
  });

  it('projects a permuted record order to the same key', () => {
    const records = filler(ARENA_MIN_RECORDS);
    const same = { userId: 'u', flag: 'f', ray: 'r' };
    const a = extractArena(arenaPage({ ...same, records }));
    const b = extractArena(arenaPage({ ...same, records: [...records].reverse() }));
    expect(a.ok && b.ok && a.key === b.key).toBe(true);
  });

  it('reports a differing rating as a differing key', () => {
    const base = filler(ARENA_MIN_RECORDS);
    const moved = [record('m-0-text', 'm-0', '1099.5', 100), ...base.slice(1)];
    const same = { userId: 'u', flag: 'f', ray: 'r' };
    const a = extractArena(arenaPage({ ...same, records: base }));
    const b = extractArena(arenaPage({ ...same, records: moved }));
    expect(a.ok && b.ok && a.key === b.key).toBe(false);
  });

  it('reports a vanished component of the tuple rather than tolerating it', () => {
    const same = { userId: 'u', flag: 'f', ray: 'r' };
    const withVotes = filler(ARENA_MIN_RECORDS);
    const withoutVotes = withVotes.map((r) => r.replace(/,\\"votes\\":\d+/, ''));
    const a = extractArena(arenaPage({ ...same, records: withVotes }));
    const b = extractArena(arenaPage({ ...same, records: withoutVotes }));
    expect(a.ok && b.ok && a.key === b.key).toBe(false);
  });

  it('refuses a payload one record under the floor rather than calling it unchanged', () => {
    const got = extractArena(
      arenaPage({ userId: 'u', flag: 'f', ray: 'r', records: filler(ARENA_MIN_RECORDS - 1) }),
    );
    expect(got).toEqual({
      ok: false,
      reason: `arena projection found ${ARENA_MIN_RECORDS - 1} records, floor is ${ARENA_MIN_RECORDS}`,
    });
  });

  it('accepts a payload exactly at the floor', () => {
    const got = extractArena(
      arenaPage({ userId: 'u', flag: 'f', ray: 'r', records: filler(ARENA_MIN_RECORDS) }),
    );
    expect(got.ok).toBe(true);
  });

  // The failure this floor exists for: the payload reshapes, every regex
  // misses, and a projection with no floor is the empty string on every run.
  it('refuses a page whose record shape it no longer recognises', () => {
    expect(extractArena('<html><body>Leaderboard unavailable</body></html>')).toEqual({
      ok: false,
      reason: `arena projection found 0 records, floor is ${ARENA_MIN_RECORDS}`,
    });
  });

  /**
   * The same records with NO backslash escaping.
   *
   * Every quote in the live payload is escaped today because the records sit
   * inside a JS string literal, but the nesting depth already varies by flight
   * chunk and a future one may not escape at all. Each `\\?"` in the extractor
   * is what makes both readable, and a test that only ever feeds the escaped
   * form cannot tell `\\?"` from `\\"`.
   */
  const plainRecord = (key: string, display: string, rating: string, votes: number): string =>
    `{"rank":1,"modelKey":"${key}","modelDisplayName":"${display}","rating":${rating},"votes":${votes}}`;

  const plainFiller = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => plainRecord(`m-${i}-text`, `m-${i}`, `${1000 + i}.5`, 100 + i));

  it('reads a record whose quotes are not escaped at all', () => {
    const got = extractArena(`<html>${plainFiller(ARENA_MIN_RECORDS).join(',')}</html>`);
    expect(got.ok && got.key.split('\n')).toContain('m-0-text\tm-0\t1000.5\t100');
  });

  it('reads an integer rating', () => {
    const got = extractArena(
      `<html>${[plainRecord('k', 'd', '1507', 7), ...plainFiller(ARENA_MIN_RECORDS)].join(',')}</html>`,
    );
    expect(got.ok && got.key.split('\n')).toContain('k\td\t1507\t7');
  });

  it('reads a negative rating', () => {
    const got = extractArena(
      `<html>${[plainRecord('k', 'd', '-3.5', 7), ...plainFiller(ARENA_MIN_RECORDS)].join(',')}</html>`,
    );
    expect(got.ok && got.key.split('\n')).toContain('k\td\t-3.5\t7');
  });

  it('projects a record with no display name as an empty display field', () => {
    const noDisplay = `{"modelKey":"solo","rating":1,"votes":2}`;
    const got = extractArena(`<html>${[noDisplay, ...plainFiller(ARENA_MIN_RECORDS)].join(',')}</html>`);
    expect(got.ok && got.key.split('\n')).toContain('solo\t\t1\t2');
  });

  it('reads the model picker spelling of the same two fields', () => {
    const picker =
      `{\\"publicName\\":\\"claude-opus-4-6-thinking\\",\\"displayName\\":\\"claude-opus-4-6-high\\"}`;
    const got = extractArena(
      arenaPage({ userId: 'u', flag: 'f', ray: 'r', records: [picker, ...filler(ARENA_MIN_RECORDS)] }),
    );
    expect(got.ok && got.key.split('\n')).toContain('claude-opus-4-6-thinking\tclaude-opus-4-6-high\t\t');
  });
});

describe('extractXai', () => {
  const table = (rows: string[]): string =>
    ['## Imagine Pricing', '', '| Model | Cost |', '| --- | --- |', ...rows, '', '## Voice Pricing'].join('\n');

  it('projects a permuted table body to the same key', () => {
    const a = extractXai(table(['| grok-imagine-image-quality | $0.05 |', '| grok-imagine-image | $0.02 |']));
    const b = extractXai(table(['| grok-imagine-image | $0.02 |', '| grok-imagine-image-quality | $0.05 |']));
    expect(a).toBe(b);
  });

  it('reports a changed cell in a table body', () => {
    const a = extractXai(table(['| grok-imagine-image | $0.02 |']));
    const b = extractXai(table(['| grok-imagine-image | $0.03 |']));
    expect(a).not.toBe(b);
  });

  it('leaves the header and delimiter rows in place, so a renamed column is a change', () => {
    const renamed = ['## Imagine Pricing', '', '| Model | Price |', '| --- | --- |', '| a | 1 |'].join('\n');
    const original = ['## Imagine Pricing', '', '| Model | Cost |', '| --- | --- |', '| a | 1 |'].join('\n');
    expect(extractXai(renamed)).not.toBe(extractXai(original));
  });

  // The reason the sort is per block. Sorting the whole file would make this
  // pair identical, and a section reorder is a real docs change.
  it('reports a reordered section between two tables as a change', () => {
    const one = ['# A', '| x | 1 |', '# B', '| y | 2 |'].join('\n');
    const two = ['# B', '| y | 2 |', '# A', '| x | 1 |'].join('\n');
    expect(extractXai(one)).not.toBe(extractXai(two));
  });

  // Two blocks separated by prose must not pool their rows, or a row moving
  // from one pricing table to another becomes invisible.
  it('does not sort rows across a block boundary', () => {
    const one = ['| b | 2 |', 'prose', '| a | 1 |'].join('\n');
    const two = ['| a | 1 |', 'prose', '| b | 2 |'].join('\n');
    expect(extractXai(one)).not.toBe(extractXai(two));
  });

  it('sorts every row of a block that has no delimiter row', () => {
    expect(extractXai(['| b | 2 |', '| a | 1 |'].join('\n'))).toBe(['| a | 1 |', '| b | 2 |'].join('\n'));
  });

  /**
   * The block that tells a recognised delimiter row from an unrecognised one.
   *
   * `| Z |` sorts AFTER `| --- |` and BEFORE `| a |`, so leaving the header
   * fixed and sorting it produce different documents. Every way of failing to
   * recognise `| --- | --- |` collapses to the sorted form, and every way of
   * recognising something that is not a delimiter shows up in the tests below
   * it.
   */
  const headerBlock = ['| Z | Cost |', '| --- | --- |', '| a | 1 |'];

  it('keeps a header row above its delimiter rather than sorting it under one', () => {
    expect(extractXai(headerBlock.join('\n'))).toBe('| Z | Cost |\n| --- | --- |\n| a | 1 |');
  });

  it('keeps a header above its delimiter in a block that is only those two rows', () => {
    expect(extractXai('| Z | Cost |\n| --- | --- |')).toBe('| Z | Cost |\n| --- | --- |');
  });

  it('recognises an indented delimiter row', () => {
    expect(extractXai('  | Z | Cost |\n  | --- | --- |\n  | a | 1 |')).toBe(
      '  | Z | Cost |\n  | --- | --- |\n  | a | 1 |',
    );
  });

  it('recognises a delimiter row with trailing whitespace', () => {
    expect(extractXai('| Z | Cost |\n| --- | --- | \n| a | 1 |')).toBe('| Z | Cost |\n| --- | --- | \n| a | 1 |');
  });

  // A row of empty cells is data, not a delimiter. Reading it as one silently
  // stops the row below it being sorted.
  it('does not read a row of empty cells as a delimiter', () => {
    expect(extractXai('| z | 1 |\n| | |\n| a | 2 |')).toBe('| a | 2 |\n| z | 1 |\n| | |');
  });

  // A dash in a model name is not a delimiter either, which is what separates
  // "contains a dash" from "is made of dashes".
  it('does not read a data row containing a dash as a delimiter', () => {
    expect(extractXai('| z | 1 |\n| grok-imagine | 2 |\n| a | 3 |')).toBe(
      '| a | 3 |\n| grok-imagine | 2 |\n| z | 1 |',
    );
  });

  // Trailing content after the pipes disqualifies it, so the `$` anchor is
  // load bearing rather than decorative.
  it('does not read a delimiter-shaped prefix followed by text as a delimiter', () => {
    expect(extractXai('| z | 1 |\n| --- | oops\n| a | 2 |')).toBe('| --- | oops\n| a | 2 |\n| z | 1 |');
  });

  // The `^` anchor: this row contains `| --- |` but does not START with it.
  it('does not read a delimiter shape found mid-row as a delimiter', () => {
    expect(extractXai('| z | 1 |\n| Model | --- |\n| a | 2 |')).toBe('| Model | --- |\n| a | 2 |\n| z | 1 |');
  });

  it('emits each row of a delimited block exactly once', () => {
    expect(extractXai(headerBlock.join('\n')).split('\n')).toHaveLength(3);
  });

  // Without the `^` this sentence is a table row and gets sorted into the
  // block beside it.
  it('does not read a sentence containing a pipe as a table row', () => {
    expect(extractXai('| z | 1 |\nuse a | b to split\n| a | 2 |')).toBe('| z | 1 |\nuse a | b to split\n| a | 2 |');
  });

  // Without the leading `\s*` an indented table stops being a table, and its
  // rows quietly return to committing their own permutation.
  it('sorts the rows of an indented block', () => {
    expect(extractXai('  | z | 1 |\n  | a | 2 |')).toBe('  | a | 2 |\n  | z | 1 |');
  });

  it('leaves a line that is not a table row untouched and in place', () => {
    expect(extractXai(['# Heading', 'body text', ''].join('\n'))).toBe(['# Heading', 'body text', ''].join('\n'));
  });
});

describe('extractSitemapLoc', () => {
  const sitemap = (urls: { loc: string; lastmod?: string }[]): string =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n` +
    urls
      .map((u) => `<url>\n<loc>${u.loc}</loc>\n${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>\n` : ''}</url>\n`)
      .join('') +
    `</urlset>\n`;

  it('projects two rebuilds that rewrote every lastmod to the same key', () => {
    const a = extractSitemapLoc(sitemap([{ loc: 'https://openrouter.ai', lastmod: '2026-08-30T00:00:00Z' }]));
    const b = extractSitemapLoc(sitemap([{ loc: 'https://openrouter.ai', lastmod: '2026-08-31T00:00:00Z' }]));
    expect(a).toBe(b);
  });

  it('reports an added url', () => {
    const a = extractSitemapLoc(sitemap([{ loc: 'https://openrouter.ai' }]));
    const b = extractSitemapLoc(sitemap([{ loc: 'https://openrouter.ai' }, { loc: 'https://openrouter.ai/new' }]));
    expect(a).not.toBe(b);
  });

  it('projects a reordered url list to the same key', () => {
    const a = extractSitemapLoc(sitemap([{ loc: 'https://b' }, { loc: 'https://a' }]));
    expect(a).toBe('https://a\nhttps://b');
  });

  // Whitespace around a URL is formatting, and a sitemap that reindents would
  // otherwise read as every URL having changed at once.
  it('trims the whitespace a pretty-printed sitemap puts around a loc', () => {
    expect(extractSitemapLoc('<urlset><url><loc>\n  https://x/a\n</loc></url></urlset>')).toBe('https://x/a');
  });

  // `<loc/>` is a URL element with no URL in it. Projecting it as an empty
  // string would put a row keyed on nothing into the set.
  it('drops a self closing loc, which names no url', () => {
    expect(extractSitemapLoc('<urlset><url><loc/></url><url><loc>https://x/a</loc></url></urlset>')).toBe(
      'https://x/a',
    );
  });

  it('reads a namespaced loc element', () => {
    expect(extractSitemapLoc('<urlset><url><sitemap:loc>https://x/a</sitemap:loc></url></urlset>')).toBe('https://x/a');
  });
});

describe('extractSitemapDated', () => {
  const a = fixture('volatile-anthropic-sitemap-a.xml');
  const b = fixture('volatile-anthropic-sitemap-b.xml');

  // The property the pair exists to prove. If these two files ever become
  // byte-identical the fixture has been recaptured and proves nothing.
  it('has a fixture pair that differs in bytes', () => {
    expect(a).not.toBe(b);
  });

  it('projects the two live edge generations to the same key', () => {
    expect(extractSitemapDated(a)).toBe(extractSitemapDated(b));
  });

  it('projects one row per url', () => {
    expect(extractSitemapDated(a).split('\n')).toHaveLength(522);
  });

  it('keeps the lastmod of a url that does not share its stamp', () => {
    expect(extractSitemapDated(a).split('\n')).toContain(
      'https://www.anthropic.com/about-anthropic-interviewer\t2026-03-23T17:15:18.000Z',
    );
  });

  it('drops the lastmod of a url whose stamp is shared by 25 urls', () => {
    expect(extractSitemapDated(a).split('\n')).toContain('https://www.anthropic.com/\t');
  });

  it('drops the stamp of exactly the 71 urls in the four shared groups', () => {
    const blank = extractSitemapDated(a).split('\n').filter((l) => l.endsWith('\t'));
    expect(blank).toHaveLength(71);
  });

  // The line between build stamp and edit. Two urls sharing a stamp is a
  // coincidence a real edit can produce; three is a build.
  it('keeps a stamp shared by one under the floor and drops it at the floor', () => {
    const url = (loc: string, lastmod: string): string =>
      `<url><loc>${loc}</loc><lastmod>${lastmod}</lastmod></url>`;
    const shared = Array.from({ length: SHARED_LASTMOD_FLOOR - 1 }, (_, i) => url(`https://x/${i}`, 'T')).join('');
    const atFloor = shared + url(`https://x/${SHARED_LASTMOD_FLOOR - 1}`, 'T');

    expect(extractSitemapDated(`<urlset>${shared}</urlset>`).split('\n')[0]).toBe('https://x/0\tT');
    expect(extractSitemapDated(`<urlset>${atFloor}</urlset>`).split('\n')[0]).toBe('https://x/0\t');
  });

  // The whole reason this is not sitemapLoc: an edit to one existing page
  // changes nothing about the url set.
  it('reports an edit to one page, which sitemapLoc cannot see', () => {
    const one = '<urlset><url><loc>https://x/a</loc><lastmod>2026-01-01</lastmod></url></urlset>';
    const two = '<urlset><url><loc>https://x/a</loc><lastmod>2026-02-02</lastmod></url></urlset>';
    expect(extractSitemapDated(one)).not.toBe(extractSitemapDated(two));
    expect(extractSitemapLoc(one)).toBe(extractSitemapLoc(two));
  });

  it('sorts its rows, so a reordered sitemap projects to the same key', () => {
    const one = '<urlset><url><loc>https://x/b</loc></url><url><loc>https://x/a</loc></url></urlset>';
    expect(extractSitemapDated(one)).toBe('https://x/a\t\nhttps://x/b\t');
  });

  // A `<url>` with no `<loc>` has no identity, so it is dropped rather than
  // projected as a row keyed on nothing.
  it('drops a url element that carries no loc', () => {
    const one = '<urlset><url><lastmod>2026-01-01</lastmod></url><url><loc>https://x/a</loc></url></urlset>';
    expect(extractSitemapDated(one)).toBe('https://x/a\t');
  });

  // Reached through `first`, which must report a self-closing element as
  // absent rather than dereferencing a capture group that did not participate.
  it('drops a url whose loc is self closing', () => {
    const one = '<urlset><url><loc/><lastmod>T</lastmod></url><url><loc>https://x/a</loc></url></urlset>';
    expect(extractSitemapDated(one)).toBe('https://x/a\t');
  });

  it('treats a self closing lastmod as no lastmod at all', () => {
    expect(extractSitemapDated('<urlset><url><loc>https://x/a</loc><lastmod/></url></urlset>')).toBe('https://x/a\t');
  });

  it('trims the whitespace around a loc and a lastmod', () => {
    expect(extractSitemapDated('<urlset><url><loc> https://x/a </loc><lastmod> T </lastmod></url></urlset>')).toBe(
      'https://x/a\tT',
    );
  });

  it('keeps a url that carries no lastmod at all', () => {
    expect(extractSitemapDated('<urlset><url><loc>https://x/a</loc></url></urlset>')).toBe('https://x/a\t');
  });
});

describe('extractAtomStatus', () => {
  const feed = fixture('healthy-openai-status.atom');

  it('projects one row per entry', () => {
    expect(extractAtomStatus(feed).split('\n')).toHaveLength(84);
  });

  it('projects an entry as its id, its updated and its sorted component list', () => {
    expect(extractAtomStatus(feed).split('\n')).toContain(
      'https://status.openai.com//incidents/01M0FQAR3NNH3ANVTQMBRD47DC\t2026-08-20T16:51:51.914Z\t' +
        'ChatGPT Work (Operational)|ChatGPT Work (Operational)|Conversations (Operational)|' +
        'Conversations (Operational)|Image Generation (Operational)|Image Generation (Operational)',
    );
  });

  // The line that re-stamps per cache generation while no entry moves. It sits
  // outside every entry, so the projection never reads it.
  it('projects two generations differing only in the feed level updated to the same key', () => {
    const a = extractAtomStatus(feed);
    const b = extractAtomStatus(feed.replace('2026-08-31T22:16:04.352Z', '2026-08-31T23:59:59.999Z'));
    expect(a).toBe(b);
  });

  const entry = (id: string, updated: string, components: string[]): string =>
    `<entry><id>${id}</id><updated>${updated}</updated><summary type="html"><![CDATA[<ul>` +
    components.map((c) => `<li>${c}</li>`).join('') +
    `</ul>]]></summary></entry>`;

  it('projects a permuted component list to the same key', () => {
    const a = extractAtomStatus(`<feed>${entry('i', 'u', ['API', 'ChatGPT', 'Sora'])}</feed>`);
    const b = extractAtomStatus(`<feed>${entry('i', 'u', ['Sora', 'API', 'ChatGPT'])}</feed>`);
    expect(a).toBe(b);
  });

  // Sorting is what makes the permutation invisible. Dropping the list would
  // be cheaper and would also make THIS invisible, which is the quiet
  // withdrawal a status feed exists to leak.
  it('reports a component that has vanished from an entry', () => {
    const a = extractAtomStatus(`<feed>${entry('i', 'u', ['API', 'ChatGPT', 'Sora'])}</feed>`);
    const b = extractAtomStatus(`<feed>${entry('i', 'u', ['API', 'ChatGPT'])}</feed>`);
    expect(a).not.toBe(b);
  });

  it('reports a component that has appeared in an entry', () => {
    const a = extractAtomStatus(`<feed>${entry('i', 'u', ['API'])}</feed>`);
    const b = extractAtomStatus(`<feed>${entry('i', 'u', ['API', 'Codex'])}</feed>`);
    expect(a).not.toBe(b);
  });

  it("reports an entry's updated moving", () => {
    const a = extractAtomStatus(`<feed>${entry('i', '2026-08-20T00:00:00Z', ['API'])}</feed>`);
    const b = extractAtomStatus(`<feed>${entry('i', '2026-08-21T00:00:00Z', ['API'])}</feed>`);
    expect(a).not.toBe(b);
  });

  it('sorts its rows, so a reordered feed projects to the same key', () => {
    const one = `<feed>${entry('b', 'u', [])}${entry('a', 'u', [])}</feed>`;
    expect(extractAtomStatus(one)).toBe('a\tu\t\nb\tu\t');
  });

  // The live feed indents its `<li>` items, so an untrimmed component list
  // would change whenever the generator reflowed its own HTML.
  it('trims the whitespace around a component name', () => {
    expect(extractAtomStatus(`<feed><entry><id>i</id><updated>u</updated><li>  API  </li></entry></feed>`)).toBe(
      'i\tu\tAPI',
    );
  });

  it('reads a component list item that carries an attribute', () => {
    expect(
      extractAtomStatus(`<feed><entry><id>i</id><updated>u</updated><li class="c">API</li></entry></feed>`),
    ).toBe('i\tu\tAPI');
  });

  it('projects an entry missing its id as an empty id rather than dropping it', () => {
    expect(extractAtomStatus('<feed><entry><updated>u</updated></entry></feed>')).toBe('\tu\t');
  });

  it('projects an entry missing its updated as an empty updated', () => {
    expect(extractAtomStatus('<feed><entry><id>i</id></entry></feed>')).toBe('i\t\t');
  });

  // A self-closing entry carries nothing, but its presence and absence are
  // still a change, and `src/health.ts` counts it as an item too.
  it('projects a self closing entry rather than skipping it', () => {
    expect(extractAtomStatus('<feed><entry/></feed>')).toBe('\t\t');
  });

  it('reports a self closing entry appearing beside a real one', () => {
    const one = `<feed>${entry('i', 'u', [])}</feed>`;
    const two = `<feed>${entry('i', 'u', [])}<entry/></feed>`;
    expect(extractAtomStatus(one)).not.toBe(extractAtomStatus(two));
  });

  it('reads a namespaced entry element', () => {
    expect(extractAtomStatus('<atom:feed><atom:entry><id>i</id></atom:entry></atom:feed>')).toBe('i\t\t');
  });

  it('reports a new entry', () => {
    const a = extractAtomStatus(`<feed>${entry('i', 'u', ['API'])}</feed>`);
    const b = extractAtomStatus(`<feed>${entry('i', 'u', ['API'])}${entry('j', 'u', ['API'])}</feed>`);
    expect(a).not.toBe(b);
  });
});

describe('applyMask', () => {
  const feedUpdated = '(?<!<entry[\\s>][\\s\\S]*)<updated>[^<]*</updated>';
  /**
   * A frozen capture, NOT `raw/claude-status/response.atom`.
   *
   * The collector rewrites that path on any run that sees a change, so a test
   * reading it asserts against a moving target and goes red for a reason that
   * has nothing to do with the code. It did, once, between one run and the
   * next.
   */
  const atom = fixture('volatile-claude-status.atom');

  it('masks the feed level updated of the archived claude-status body', () => {
    expect(applyMask(atom, [feedUpdated]).match(/\u0000masked\u0000/g)).toHaveLength(1);
  });

  it("leaves every one of that body's 25 entry updated elements in place", () => {
    expect(applyMask(atom, [feedUpdated]).match(/<updated>/g)).toHaveLength(25);
  });

  it('projects two generations of claude-status differing only in that line to the same key', () => {
    const moved = atom.replace('<updated>2026-08-31T21:49:50Z</updated>', '<updated>2026-08-31T23:59:59Z</updated>');
    expect(moved).not.toBe(atom);
    expect(applyMask(moved, [feedUpdated])).toBe(applyMask(atom, [feedUpdated]));
  });

  it('still reports an entry timestamp moving', () => {
    const moved = atom.replace('<updated>2026-08-31T20:36:00Z</updated>', '<updated>2026-09-01T00:00:00Z</updated>');
    // Without this the assertion below passes on a stale anchor that replaced
    // nothing, which is the vacuous form of exactly this test.
    expect(moved).not.toBe(atom);
    expect(applyMask(moved, [feedUpdated])).not.toBe(applyMask(atom, [feedUpdated]));
  });

  it('replaces every occurrence of a pattern, not only the first', () => {
    expect(applyMask('a1b1c', ['1'])).toBe('a\u0000masked\u0000b\u0000masked\u0000c');
  });

  // Empty-string replacement would let `<a/><b/>` and `<ab/>` collide.
  it('replaces with a marker rather than nothing, so masked regions cannot fuse', () => {
    expect(applyMask('xy', ['x', 'y'])).toBe('\u0000masked\u0000\u0000masked\u0000');
  });

  it('anchors ^ to a line rather than to the document', () => {
    expect(applyMask('keep\ndrop', ['^drop$'])).toBe('keep\n\u0000masked\u0000');
  });
});

describe('project', () => {
  it('hands a bytes source its whole decoded body', () => {
    expect(project(sourceFor('openrouter-models'), bytes('{"data":[]}'))).toEqual({
      ok: true,
      key: '{"data":[]}',
    });
  });

  it('reports an uncompilable mask pattern rather than throwing', () => {
    const s = { ...sourceFor('claude-status'), predicate: { type: 'mask' as const, patterns: ['('] } };
    const got = project(s, bytes('<feed/>'));
    expect(got.ok).toBe(false);
    expect(!got.ok && got.reason).toContain('mask pattern failed');
  });

  // A lenient decoder, deliberately. A single bad byte anywhere in a 5 MB body
  // would otherwise throw out of the predicate and be reported as a source
  // failure, which is not what one invalid byte means.
  it('decodes an invalid utf-8 byte to the replacement character rather than throwing', () => {
    const got = project(sourceFor('openrouter-models'), new Uint8Array([0x61, 0xff, 0x62]));
    expect(got).toEqual({ ok: true, key: 'a�b' });
  });

  it('decodes an invalid utf-8 byte the same way on the extracted path', () => {
    const got = project(sourceFor('openrouter-sitemap'), new Uint8Array([...bytes('<urlset><url><loc>a'), 0xff, ...bytes('</loc></url></urlset>')]));
    expect(got).toEqual({ ok: true, key: 'a�' });
  });

  it('succeeds on a mask source whose patterns compile', () => {
    const got = project(sourceFor('claude-status'), bytes('<feed><updated>X</updated></feed>'));
    expect(got).toEqual({ ok: true, key: '<feed>\u0000masked\u0000</feed>' });
  });

  it('routes anthropic-sitemap to sitemapDated', () => {
    const body = bytes('<urlset><url><loc>https://x/a</loc><lastmod>T</lastmod></url></urlset>');
    expect(project(sourceFor('anthropic-sitemap'), body)).toEqual({ ok: true, key: 'https://x/a\tT' });
  });

  it('routes openai-status to atomStatus', () => {
    const body = bytes('<feed><updated>FEED</updated><entry><id>i</id><updated>E</updated></entry></feed>');
    expect(project(sourceFor('openai-status'), body)).toEqual({ ok: true, key: 'i\tE\t' });
  });
});

describe('changedUnderPredicate', () => {
  const models = sourceFor('openrouter-models');
  const sitemap = sourceFor('openrouter-sitemap');

  it('calls the first fetch of a source a change, because it is the seed', () => {
    expect(changedUnderPredicate(models, bytes('anything'), null)).toEqual({ ok: true, changed: true });
  });

  it('calls identical bytes unchanged', () => {
    expect(changedUnderPredicate(models, bytes('same'), bytes('same'))).toEqual({ ok: true, changed: false });
  });

  it('calls differing bytes a change under a bytes predicate', () => {
    expect(changedUnderPredicate(models, bytes('a'), bytes('b'))).toEqual({ ok: true, changed: true });
  });

  it('calls a body of the same length but different content a change', () => {
    expect(changedUnderPredicate(models, bytes('ab'), bytes('ba'))).toEqual({ ok: true, changed: true });
  });

  it('calls differing bytes with an equal projection unchanged', () => {
    const one = bytes('<urlset><url><loc>https://x</loc><lastmod>2026-01-01</lastmod></url></urlset>');
    const two = bytes('<urlset><url><loc>https://x</loc><lastmod>2026-02-02</lastmod></url></urlset>');
    expect(changedUnderPredicate(sitemap, one, two)).toEqual({ ok: true, changed: false });
  });

  it('calls differing bytes with a differing projection a change', () => {
    const one = bytes('<urlset><url><loc>https://x</loc></url></urlset>');
    const two = bytes('<urlset><url><loc>https://y</loc></url></urlset>');
    expect(changedUnderPredicate(sitemap, one, two)).toEqual({ ok: true, changed: true });
  });

  // Not `changed: false`. Unchanged is the answer that lets a broken extractor
  // sit silently on a live source for months.
  it('hands up a failed projection of the new body rather than calling it unchanged', () => {
    const arena = sourceFor('arena-leaderboard');
    const got = changedUnderPredicate(arena, bytes('<html>reshaped</html>'), bytes('<html>old</html>'));
    expect(got).toEqual({ ok: false, reason: `arena projection found 0 records, floor is ${ARENA_MIN_RECORDS}` });
  });

  // Which side failed matters: reporting the stored body's reason for a new
  // body that broke would send an operator to the wrong artifact.
  it("reports the new body's reason when only the new body fails to project", () => {
    const arena = sourceFor('arena-leaderboard');
    const good =
      '<html>' +
      Array.from({ length: ARENA_MIN_RECORDS }, (_, i) => `"modelKey":"m${i}","votes":${i}`).join(',') +
      '</html>';
    const got = changedUnderPredicate(arena, bytes('<html>reshaped</html>'), bytes(good));
    expect(got).toEqual({ ok: false, reason: `arena projection found 0 records, floor is ${ARENA_MIN_RECORDS}` });
  });

  it('hands up a failed projection of the stored body too', () => {
    const arena = sourceFor('arena-leaderboard');
    const good =
      `<html>` +
      Array.from({ length: ARENA_MIN_RECORDS }, (_, i) => `\\"modelKey\\":\\"m${i}\\",\\"votes\\":${i}`).join(',') +
      `</html>`;
    const got = changedUnderPredicate(arena, bytes(good), bytes('<html>old</html>'));
    expect(got.ok).toBe(false);
  });
});

describe('src/predicate.ts stays pure', () => {
  const imports = (): string[] =>
    [...fs.readFileSync('src/predicate.ts', 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!).sort();

  it('imports exactly one module, and it is a type source', () => {
    expect(imports()).toEqual(['./config.js']);
  });

  // The list above is the strong claim; this one keeps the intent legible if
  // the list is ever widened for a legitimate reason.
  it('imports nothing that touches a disk, a process, a network or a repository', () => {
    const forbidden = ['node:fs', 'node:child_process', './fetch.js', './git.js'];
    expect(imports().filter((i) => forbidden.includes(i))).toEqual([]);
  });
});
