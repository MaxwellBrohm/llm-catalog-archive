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

  it('reports a new entry', () => {
    const a = extractAtomStatus(`<feed>${entry('i', 'u', ['API'])}</feed>`);
    const b = extractAtomStatus(`<feed>${entry('i', 'u', ['API'])}${entry('j', 'u', ['API'])}</feed>`);
    expect(a).not.toBe(b);
  });
});

describe('applyMask', () => {
  const feedUpdated = '(?<!<entry[\\s>][\\s\\S]*)<updated>[^<]*</updated>';
  const atom = fs.readFileSync('raw/claude-status/response.atom', 'utf8');

  it('masks the feed level updated of the archived claude-status body', () => {
    expect(applyMask(atom, [feedUpdated]).match(/\u0000masked\u0000/g)).toHaveLength(1);
  });

  it("leaves every one of that body's 25 entry updated elements in place", () => {
    expect(applyMask(atom, [feedUpdated]).match(/<updated>/g)).toHaveLength(25);
  });

  it('projects two generations of claude-status differing only in that line to the same key', () => {
    const moved = atom.replace('<updated>2026-08-31T05:29:12Z</updated>', '<updated>2026-08-31T09:00:00Z</updated>');
    expect(moved).not.toBe(atom);
    expect(applyMask(moved, [feedUpdated])).toBe(applyMask(atom, [feedUpdated]));
  });

  it('still reports an entry timestamp moving', () => {
    const moved = atom.replace('<updated>2026-08-28T20:21:18Z</updated>', '<updated>2026-08-29T00:00:00Z</updated>');
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
