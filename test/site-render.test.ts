import { describe, it, expect } from 'vitest';
import { renderChangePage, renderChangelogPage, renderFeed, renderSourcePage } from '../src/site/render.js';
import { MAX_DIFF_LINES, MAX_LINE_CHARS } from '../src/site/record.js';
import { artifact, record, sidecar, OTHER_SHA, SHA } from './site-fixtures.js';

const ORIGIN_CELL =
  '<time datetime="2026-08-28T08:08:22.000Z">28 August 2026 08:08 UTC</time> <span class="badge badge-origin">origin</span>';
const OBSERVED_CELL =
  '<time datetime="2026-08-28T11:23:40.960Z">28 August 2026 11:23 UTC</time> <span class="badge badge-observed">observed</span>';
const PERMALINK =
  'https://github.com/MaxwellBrohm/llm-catalog-archive/blob/a0a9e12e5287b8ce564e6de63a280498413484cf/raw/openai-llms-txt/response.txt';

describe('renderChangePage: the artifact permalink', () => {
  it('links the artifact at the commit that changed it', () => {
    expect(renderChangePage(record())).toContain(`<a href="${PERMALINK}">raw/openai-llms-txt/response.txt</a>`);
  });

  it('never links the artifact at HEAD', () => {
    expect(renderChangePage(record())).not.toContain('/blob/HEAD/');
  });

  it('never links the artifact at a branch name', () => {
    expect(renderChangePage(record())).not.toContain('/blob/main/');
  });

  it('links a different commit for the same path when the sha differs', () => {
    expect(renderChangePage(record({ sha: OTHER_SHA }))).toContain(
      'https://github.com/MaxwellBrohm/llm-catalog-archive/blob/0e91a0fbf78e6302670dc61a8c28502e418d01a1/raw/openai-llms-txt/response.txt',
    );
  });

  it('prints the full sha, not only the abbreviation in the heading', () => {
    expect(renderChangePage(record())).toContain('a0a9e12e5287b8ce564e6de63a280498413484cf');
  });
});

describe('renderChangePage: which timestamp it shows', () => {
  it('shows origin_date and labels it origin when the provider sent an Age header', () => {
    expect(renderChangePage(record())).toContain(ORIGIN_CELL);
  });

  it('does not show observed_at as the timestamp when origin_date exists', () => {
    expect(renderChangePage(record())).not.toContain(
      '<time datetime="2026-08-28T11:23:40.960Z">28 August 2026 11:23 UTC</time> <span class="badge badge-origin">',
    );
  });

  it('falls back to observed_at and labels it observed when origin_date is null', () => {
    const r = record({ artifacts: [artifact({ sidecar: sidecar({ originDate: null }) })] });
    expect(renderChangePage(r)).toContain(OBSERVED_CELL);
  });

  it('never labels the fallback origin', () => {
    const r = record({ artifacts: [artifact({ sidecar: sidecar({ originDate: null }) })] });
    expect(renderChangePage(r)).not.toContain('badge-origin');
  });

  it('says so rather than inventing a timestamp when no sidecar was stored', () => {
    const r = record({ artifacts: [artifact({ sidecar: null })] });
    expect(renderChangePage(r)).toContain('<span class="badge badge-observed">no sidecar</span>');
  });

  it('still shows both raw sidecar timestamps in the headers table', () => {
    expect(renderChangePage(record())).toContain('<tr><th>observed_at</th><td>2026-08-28T11:23:40.960Z</td></tr>');
  });
});

describe('renderChangePage: the recorded headers table', () => {
  // Every label against its own field, in one assertion, because a table of
  // labels is exactly the thing that is right in the first row and wrong in the
  // seventh, and one sampled row cannot see that.
  it('pairs every spec section 9 header with the field it came from', () => {
    const html = renderChangePage(record());
    const table = html.slice(html.indexOf('<table class="kv">'), html.indexOf('</table>'));
    expect(table).toBe(`<table class="kv">
<tr><th>observed_at</th><td>2026-08-28T11:23:40.960Z</td></tr>
<tr><th>origin_date</th><td>2026-08-28T08:08:22.000Z</td></tr>
<tr><th>status</th><td>200</td></tr>
<tr><th>final URL</th><td>https://developers.openai.com/api/docs/llms.txt</td></tr>
<tr><th>etag</th><td>W/&quot;2aa51de06cc463589d265a6e160614ea&quot;</td></tr>
<tr><th>last-modified</th><td>Fri, 28 Aug 2026 08:08:22 GMT</td></tr>
<tr><th>date</th><td>Fri, 28 Aug 2026 11:23:40 GMT</td></tr>
<tr><th>age</th><td>11718</td></tr>
<tr><th>cache-control</th><td>public, max-age=0, must-revalidate</td></tr>
<tr><th>cf-cache-status</th><td>null</td></tr>
<tr><th>content-encoding</th><td>br</td></tr>
<tr><th>content-length</th><td>null</td></tr>
`);
  });

  it('prints an absent header as null rather than as an empty cell', () => {
    expect(renderChangePage(record())).toContain('<tr><th>content-length</th><td>null</td></tr>');
  });

  it('says so rather than printing an empty table when no sidecar was stored', () => {
    const r = record({ artifacts: [artifact({ sidecar: null })] });
    expect(renderChangePage(r)).toContain(
      '<p class="note">No headers.json was stored beside this artifact at this commit.</p>',
    );
  });

  it('offers no headers table at all when no sidecar was stored', () => {
    const r = record({ artifacts: [artifact({ sidecar: null })] });
    expect(renderChangePage(r)).not.toContain('<table class="kv">');
  });
});

describe('renderChangePage: retractions', () => {
  const retracted = record({ retraction: { sha: SHA, path: null, reason: 'source url was wrong' } });

  it('still renders the page rather than omitting it', () => {
    expect(renderChangePage(retracted)).toContain('a0a9e12e5287b8ce564e6de63a280498413484cf');
  });

  it('still renders the diff rather than blanking it', () => {
    expect(renderChangePage(retracted)).toContain('- [Assistants migration guide](https://x/migration.md)');
  });

  it('still links the raw artifact, so the audit trail stays resolvable', () => {
    expect(renderChangePage(retracted)).toContain(PERMALINK);
  });

  it('marks the change retracted', () => {
    expect(renderChangePage(retracted)).toContain('<span class="badge badge-retracted">retracted</span>');
  });

  it('prints the recorded reason', () => {
    expect(renderChangePage(retracted)).toContain('<p class="reason">reason: source url was wrong</p>');
  });

  it('does not mark an unretracted change', () => {
    expect(renderChangePage(record())).not.toContain('badge-retracted');
  });

  // Nothing at all between the commit subject and the first artifact, so the
  // retraction block is absent rather than present and empty.
  it('puts nothing between the subject and the first artifact when unretracted', () => {
    expect(renderChangePage(record())).toContain(
      '<p class="subject">openai-llms-txt: changed (33743 bytes, HTTP 200)</p>\n\n<section class="artifact"',
    );
  });

  it('closes the note straight after the scope sentence when no reason was recorded', () => {
    const noReason = record({ retraction: { sha: SHA, path: null, reason: null } });
    expect(renderChangePage(noReason)).toContain(
      'nothing is deleted.</p>\n<p class="note">Recorded in <code>meta/retractions.jsonl</code>.</p>',
    );
  });

  it('marks only the named artifact when the retraction names a path', () => {
    const scoped = record({
      artifacts: [artifact(), artifact({ sourceId: 'claude-status', path: 'raw/claude-status/response.atom' })],
      retraction: { sha: SHA, path: 'raw/claude-status/response.atom', reason: null },
    });
    const html = renderChangePage(scoped);
    const first = html.indexOf('<section class="artifact" id="openai-llms-txt">');
    const second = html.indexOf('<section class="artifact" id="claude-status">');
    expect(html.slice(first, second)).not.toContain('badge-retracted');
  });

  it('marks the named artifact heading itself', () => {
    const scoped = record({
      artifacts: [artifact(), artifact({ sourceId: 'claude-status', path: 'raw/claude-status/response.atom' })],
      retraction: { sha: SHA, path: 'raw/claude-status/response.atom', reason: null },
    });
    expect(renderChangePage(scoped)).toContain(
      '<h2 class="path">raw/claude-status/response.atom <span class="badge badge-modified">modified</span> <span class="badge badge-retracted">retracted</span></h2>',
    );
  });

  it('names the artifact in the note when the retraction is scoped to a path', () => {
    const scoped = record({ retraction: { sha: SHA, path: 'raw/openai-llms-txt/response.txt', reason: null } });
    expect(renderChangePage(scoped)).toContain(
      'The artifact <code>raw/openai-llms-txt/response.txt</code> in this change is retracted.',
    );
  });

  it('says the whole change is retracted when the retraction names no path', () => {
    const whole = record({ retraction: { sha: SHA, path: null, reason: null } });
    expect(renderChangePage(whole)).toContain('This change is retracted.');
  });

  it('prints no reason paragraph when the ledger recorded none', () => {
    const noReason = record({ retraction: { sha: SHA, path: null, reason: null } });
    expect(renderChangePage(noReason)).not.toContain('<p class="reason">');
  });

  it('escapes a reason that carries markup', () => {
    const hostile = record({ retraction: { sha: SHA, path: null, reason: '<img src=x onerror=alert(1)>' } });
    expect(renderChangePage(hostile)).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('renderChangePage: escaping third-party bytes', () => {
  const hostileDiff = record({
    artifacts: [
      artifact({
        diff: [{ kind: 'add', text: '<script>alert("pwned")</script>', truncated: false }],
      }),
    ],
  });

  it('escapes a script tag arriving in a diff line', () => {
    expect(renderChangePage(hostileDiff)).toContain('&lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt;');
  });

  it('leaves no executable script anywhere in the page', () => {
    expect(renderChangePage(hostileDiff)).not.toContain('<script');
  });

  it('escapes a hostile commit subject', () => {
    const r = record({ subject: 'x: changed <img onerror="alert(1)">' });
    expect(renderChangePage(r)).toContain('x: changed &lt;img onerror=&quot;alert(1)&quot;&gt;');
  });

  it('escapes a hostile artifact path', () => {
    const r = record({ artifacts: [artifact({ path: 'raw/x/"><b>.txt' })] });
    expect(renderChangePage(r)).toContain('raw/x/&quot;&gt;&lt;b&gt;.txt');
  });

  it('escapes a quote inside the recorded etag', () => {
    expect(renderChangePage(record())).toContain(
      '<tr><th>etag</th><td>W/&quot;2aa51de06cc463589d265a6e160614ea&quot;</td></tr>',
    );
  });

  it('escapes a hostile final URL from the sidecar', () => {
    const r = record({ artifacts: [artifact({ sidecar: sidecar({ finalUrl: 'https://x/"><b>' }) })] });
    expect(renderChangePage(r)).toContain('https://x/&quot;&gt;&lt;b&gt;');
  });

  it('escapes a hostile source id', () => {
    const r = record({ artifacts: [artifact({ sourceId: '"><b>' })] });
    expect(renderChangePage(r)).toContain('&quot;&gt;&lt;b&gt;');
  });

  it('needs no client JavaScript to read', () => {
    expect(renderChangePage(record())).not.toContain('<script');
  });
});

describe('renderChangePage: the numbers', () => {
  it('shows the added-line count from the record', () => {
    expect(renderChangePage(record())).toContain('<span class="plus">+1</span>');
  });

  it('shows the removed-line count from the record', () => {
    expect(renderChangePage(record())).toContain('<span class="minus">-6</span>');
  });

  it('shows the stored byte size with thousands separators', () => {
    expect(renderChangePage(record())).toContain(
      '<dt>Stored bytes at this commit</dt><dd>33,743</dd>',
    );
  });

  it('says the size was not recorded rather than showing a zero', () => {
    const r = record({ artifacts: [artifact({ bytes: null })] });
    expect(renderChangePage(r)).toContain('<dt>Stored bytes at this commit</dt><dd>not recorded</dd>');
  });

  it('labels a first capture added', () => {
    const r = record({ artifacts: [artifact({ kind: 'added' })] });
    expect(renderChangePage(r)).toContain('<span class="badge badge-added">added</span>');
  });

  it('labels a later capture modified', () => {
    expect(renderChangePage(record())).toContain('<span class="badge badge-modified">modified</span>');
  });

  it('says the display stopped when the diff ran past the line budget', () => {
    const r = record({ artifacts: [artifact({ diffTruncated: true })] });
    expect(renderChangePage(r)).toContain(`Diff display stops at ${MAX_DIFF_LINES} lines.`);
  });

  // The whole note, not a fragment. Each clause is a separate branch, and a
  // `toContain` on the first sentence passes with the rest missing.
  it('states the whole truncation note when the diff ran past the line budget', () => {
    const r = record({ artifacts: [artifact({ diffTruncated: true })] });
    expect(renderChangePage(r)).toContain(
      '<p class="note">Diff display stops at 400 lines. The line counts above are from the whole diff. The raw artifact at this commit is linked above.</p>',
    );
  });

  it('states the whole note when only a line was cut', () => {
    const r = record({ artifacts: [artifact({ diff: [{ kind: 'add', text: 'x', truncated: true }] })] });
    expect(renderChangePage(r)).toContain(
      '<p class="note">1 line shown here cut at 300 characters. The raw artifact at this commit is linked above.</p>',
    );
  });

  it('carries no note paragraph at all on an untruncated page with a sidecar', () => {
    expect(renderChangePage(record())).not.toContain('<p class="note">');
  });

  // Nothing at all after the diff, so the note is absent rather than present
  // and empty.
  it('closes the artifact section straight after the diff when nothing was truncated', () => {
    expect(renderChangePage(record())).toContain('</div>\n\n</section>');
  });

  it('says how many lines were cut at the character budget', () => {
    const r = record({
      artifacts: [artifact({ diff: [{ kind: 'add', text: 'x', truncated: true }] })],
    });
    expect(renderChangePage(r)).toContain(`1 line shown here cut at ${MAX_LINE_CHARS} characters.`);
  });

  it('adds no truncation note to a diff that was shown whole', () => {
    expect(renderChangePage(record())).not.toContain('Diff display stops at');
  });
});

describe('renderChangePage: the artifact heading and the page title', () => {
  it('heads the artifact with its path and its git status', () => {
    expect(renderChangePage(record())).toContain(
      '<h2 class="path">raw/openai-llms-txt/response.txt <span class="badge badge-modified">modified</span></h2>',
    );
  });

  it('titles the page with the abbreviated sha', () => {
    expect(renderChangePage(record())).toContain('<title>a0a9e12 - llm-catalog-archive</title>');
  });

  it('heads the page with the abbreviated sha', () => {
    expect(renderChangePage(record())).toContain('<h1 class="sha-title">a0a9e12</h1>');
  });

  it('says so rather than printing an empty box when the commit recorded no diff', () => {
    const r = record({ artifacts: [artifact({ diff: [] })] });
    expect(renderChangePage(r)).toContain(
      '<p class="note">This commit recorded no textual diff for this artifact.</p>',
    );
  });

  it('adds no cut note when no line was cut', () => {
    expect(renderChangePage(record())).not.toContain('cut at');
  });

  it('adds no artifact-link note when nothing was truncated', () => {
    expect(renderChangePage(record())).not.toContain('The raw artifact at this commit is linked above.');
  });
});

describe('renderChangePage: the diff gutters', () => {
  it('gives an added line the add gutter', () => {
    const r = record({ artifacts: [artifact({ diff: [{ kind: 'add', text: 'hello', truncated: false }] })] });
    expect(renderChangePage(r)).toContain('<div class="dl dl-add"><span class="g">+</span><code>hello</code></div>');
  });

  it('gives a removed line the remove gutter', () => {
    const r = record({ artifacts: [artifact({ diff: [{ kind: 'remove', text: 'gone', truncated: false }] })] });
    expect(renderChangePage(r)).toContain('<div class="dl dl-remove"><span class="g">-</span><code>gone</code></div>');
  });

  it('marks a cut line in the rendered diff', () => {
    const r = record({ artifacts: [artifact({ diff: [{ kind: 'add', text: 'hello', truncated: true }] })] });
    expect(renderChangePage(r)).toContain('<code>hello<span class="cut">&#8230;</span></code>');
  });
});

/**
 * The changelog, which used to be the front page and is now a section at
 * changelog/index.html. It moved one directory down, so every link out of it
 * carries `../`; the change and source pages it points at did NOT move,
 * because those are permalinks.
 */
describe('renderChangelogPage', () => {
  const two = [
    record(),
    record({ sha: OTHER_SHA, artifacts: [artifact({ sidecar: sidecar({ originDate: '2026-08-26T20:25:00.000Z' }) })] }),
  ];

  it('links each change page by its full sha', () => {
    expect(renderChangelogPage(two)).toContain('href="../changes/a0a9e12e5287b8ce564e6de63a280498413484cf.html"');
  });

  it('files each change under the UTC day of the timestamp it shows', () => {
    expect(renderChangelogPage(two)).toContain('<h2>2026-08-28</h2>');
  });

  it('gives a second day its own heading', () => {
    expect(renderChangelogPage(two)).toContain('<h2>2026-08-26</h2>');
  });

  it('counts the changes', () => {
    expect(renderChangelogPage(two)).toContain('2 changes across 1 source');
  });

  it('counts the sources', () => {
    const mixed = [record(), record({ sha: OTHER_SHA, artifacts: [artifact({ sourceId: 'claude-status', path: 'raw/claude-status/response.atom' })] })];
    expect(renderChangelogPage(mixed)).toContain('2 changes across 2 sources');
  });

  it('links each source page from the source card', () => {
    expect(renderChangelogPage(two)).toContain('<a href="../sources/openai-llms-txt.html">openai-llms-txt</a>');
  });

  it('marks a retracted row', () => {
    const r = [record({ retraction: { sha: SHA, path: null, reason: null } })];
    expect(renderChangelogPage(r)).toContain('<span class="badge badge-retracted">retracted</span>');
  });

  it('files a change with no sidecar under its own heading rather than a wrong day', () => {
    expect(renderChangelogPage([record({ artifacts: [artifact({ sidecar: null })] })])).toContain(
      '<h2>no timestamp recorded</h2>',
    );
  });

  it('escapes a hostile artifact path in a row', () => {
    const r = [record({ artifacts: [artifact({ path: 'raw/x/"><b>.txt' })] })];
    expect(renderChangelogPage(r)).toContain('raw/x/&quot;&gt;&lt;b&gt;.txt');
  });

  /**
   * The changelog now loads the client-side filter, so it is no longer
   * script-free. The claim that matters was never "no script tag", it was that
   * the page is COMPLETE without one, so this asserts that instead: strip every
   * script and the rows, the sources and the sentences are all still there.
   * The filter's input is created by the script and is deliberately absent from
   * the markup, so a reader with JavaScript off sees no control that does
   * nothing.
   */
  it('is complete with every script stripped, which is the claim that matters', () => {
    const html = renderChangelogPage(two);
    const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/g, '');
    // Some artifact path from the fixture, whatever it is, must survive.
    expect(withoutScripts).toMatch(/raw\/[a-z0-9-]+\/response\./);
    expect((withoutScripts.match(/<tr>/g) ?? []).length).toBeGreaterThan(1);
    expect(withoutScripts).not.toContain('class="filter-input"');
  });

  /**
   * The claim is ORIGIN, not count. The changelog now also loads wall.js, which
   * carries the capture graph: one node per commit, one lane per source. Both
   * scripts are relative paths into this deployment, which is what "nothing
   * from another origin" is actually asserting.
   */
  it('loads only same-origin scripts, and nothing from another origin', () => {
    const scripts = [...renderChangelogPage(two).matchAll(/<script[^>]*src="([^"]*)"/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const src of scripts) {
      expect(src, `${src} is not a relative path`).toMatch(/^\.\.?\//);
      expect(src).not.toContain('://');
    }
  });

  it('carries the graph module and its data island', () => {
    const html = renderChangelogPage(two);
    expect(html).toContain('data-graph-stage');
    expect(html).toContain('data-graph-nodes');
    expect(html).toContain('../wall.js');
  });

  // The path cell and nothing else, so an unretracted row carries no leftover
  // marker where the retracted badge would go.
  it('closes the artifact cell straight after the path when the row is not retracted', () => {
    expect(renderChangelogPage(two)).toContain('<td class="mono">raw/openai-llms-txt/response.txt</td>');
  });

  it('prints the line counts in the row', () => {
    expect(renderChangelogPage(two)).toContain(
      '<td class="mono"><span class="count-add">+1</span> <span class="count-remove">-6</span></td>',
    );
  });

  it('abbreviates the sha in the change column', () => {
    expect(renderChangelogPage(two)).toContain(
      '<td class="mono"><a href="../changes/a0a9e12e5287b8ce564e6de63a280498413484cf.html">a0a9e12</a></td>',
    );
  });

  it('counts the changes on each source card', () => {
    const mixed = [record(), record({ sha: OTHER_SHA }), record({ sha: '0'.repeat(40), artifacts: [artifact({ sourceId: 'claude-status', path: 'raw/claude-status/response.atom' })] })];
    expect(renderChangelogPage(mixed)).toContain('<a href="../sources/openai-llms-txt.html">openai-llms-txt</a>\n<p>2 changes</p>');
  });

  it('says one change in the singular on a card with one', () => {
    const mixed = [record(), record({ sha: OTHER_SHA, artifacts: [artifact({ sourceId: 'claude-status', path: 'raw/claude-status/response.atom' })] })];
    expect(renderChangelogPage(mixed)).toContain('<a href="../sources/claude-status.html">claude-status</a>\n<p>1 change</p>');
  });

  it('lists the source cards alphabetically', () => {
    const mixed = [record(), record({ sha: OTHER_SHA, artifacts: [artifact({ sourceId: 'claude-status', path: 'raw/claude-status/response.atom' })] })];
    const html = renderChangelogPage(mixed);
    expect(html.indexOf('sources/claude-status.html')).toBeLessThan(html.indexOf('sources/openai-llms-txt.html'));
  });

  it('titles the changelog page after its own section', () => {
    expect(renderChangelogPage(two)).toContain('<title>Changelog - llm-catalog-archive</title>');
  });

  it('puts two changes on one day under one heading', () => {
    const sameDay = [record(), record({ sha: OTHER_SHA })];
    expect(renderChangelogPage(sameDay).split('<h2>2026-08-28</h2>')).toHaveLength(2);
  });

  // Both rows, not just one heading. A bucket that replaces its contents rather
  // than appending renders one heading and loses a change.
  it('keeps both changes of a shared day in the table', () => {
    const sameDay = [record(), record({ sha: OTHER_SHA })];
    const html = renderChangelogPage(sameDay);
    expect([
      html.includes('../changes/a0a9e12e5287b8ce564e6de63a280498413484cf.html'),
      html.includes('changes/0e91a0fbf78e6302670dc61a8c28502e418d01a1.html'),
    ]).toEqual([true, true]);
  });

  it('renders one row per change on a shared day', () => {
    const sameDay = [record(), record({ sha: OTHER_SHA })];
    expect(renderChangelogPage(sameDay).split('<tr>\n<td class="mono">')).toHaveLength(3);
  });
});

describe('renderSourcePage', () => {
  const two = [
    record(),
    record({ sha: OTHER_SHA, artifacts: [artifact({ sourceId: 'claude-status', path: 'raw/claude-status/response.atom' })] }),
  ];

  it("counts only that source's changes", () => {
    expect(renderSourcePage('openai-llms-txt', two)).toContain('<dt>Recorded changes</dt><dd class="big">1</dd>');
  });

  it("leaves another source's artifact off the page", () => {
    expect(renderSourcePage('openai-llms-txt', two)).not.toContain('raw/claude-status/response.atom');
  });

  it('shows the latest recorded timestamp for the source', () => {
    expect(renderSourcePage('openai-llms-txt', two)).toContain(ORIGIN_CELL);
  });

  it('shows the final URL recorded in the latest sidecar', () => {
    expect(renderSourcePage('openai-llms-txt', two)).toContain('https://developers.openai.com/api/docs/llms.txt');
  });

  it('says the final URL was not recorded rather than printing null', () => {
    const r = [record({ artifacts: [artifact({ sidecar: sidecar({ finalUrl: null }) })] })];
    expect(renderSourcePage('openai-llms-txt', r)).toContain('<dt>Final URL at the latest change</dt><dd>not recorded</dd>');
  });

  it('links its change pages one directory up', () => {
    expect(renderSourcePage('openai-llms-txt', two)).toContain(
      'href="../changes/a0a9e12e5287b8ce564e6de63a280498413484cf.html"',
    );
  });

  it('reports zero changes for a source with none', () => {
    expect(renderSourcePage('mistral-llms-txt', two)).toContain('<dt>Recorded changes</dt><dd class="big">0</dd>');
  });

  it('lists the stored path', () => {
    expect(renderSourcePage('openai-llms-txt', two)).toContain(
      '<dt>Stored path</dt><dd>raw/openai-llms-txt/response.txt</dd>',
    );
  });

  it('titles the page after the source', () => {
    expect(renderSourcePage('openai-llms-txt', two)).toContain('<title>openai-llms-txt - llm-catalog-archive</title>');
  });

  it('says no sidecar rather than a timestamp when the latest change stored none', () => {
    const r = [record({ artifacts: [artifact({ sidecar: null })] })];
    expect(renderSourcePage('openai-llms-txt', r)).toContain(
      '<dt>Latest recorded change</dt><dd><span class="badge badge-observed">no sidecar</span></dd>',
    );
  });
});

describe('renderFeed', () => {
  it('titles an item with the artifact and its line counts', () => {
    expect(renderFeed([record()])).toContain(
      '<title>openai-llms-txt: raw/openai-llms-txt/response.txt modified, 1 line added, 6 lines removed</title>',
    );
  });

  it('dates an item from origin_date in RFC 822', () => {
    expect(renderFeed([record()])).toContain('<pubDate>Fri, 28 Aug 2026 08:08:22 GMT</pubDate>');
  });

  it('dates an item from observed_at when origin_date is null', () => {
    const r = record({ artifacts: [artifact({ sidecar: sidecar({ originDate: null }) })] });
    expect(renderFeed([r])).toContain('<pubDate>Fri, 28 Aug 2026 11:23:40 GMT</pubDate>');
  });

  it('omits pubDate rather than inventing one when no sidecar was stored', () => {
    const r = record({ artifacts: [artifact({ sidecar: null })] });
    expect(renderFeed([r])).not.toContain('<pubDate>');
  });

  // The guid closes straight onto the description, so the missing pubDate
  // leaves nothing behind where it would have been.
  it('leaves nothing where the pubDate would have been', () => {
    const r = record({ artifacts: [artifact({ sidecar: null })] });
    expect(renderFeed([r])).toContain('</guid>\n<description>');
  });

  it('gives each item a guid at the change page anchored on the artifact', () => {
    expect(renderFeed([record()], 'https://example.test')).toContain(
      '<guid isPermaLink="true">https://example.test/changes/a0a9e12e5287b8ce564e6de63a280498413484cf.html#openai-llms-txt</guid>',
    );
  });

  it('puts the raw artifact permalink in the description', () => {
    expect(renderFeed([record()])).toContain(PERMALINK);
  });

  it('marks a retracted change in the description', () => {
    const r = record({ retraction: { sha: SHA, path: null, reason: null } });
    expect(renderFeed([r])).toContain('<description>RETRACTED. ');
  });

  it('escapes markup arriving through an artifact path', () => {
    const r = record({ artifacts: [artifact({ path: 'raw/x/<b>.txt' })] });
    expect(renderFeed([r])).toContain('raw/x/&lt;b&gt;.txt');
  });

  it('describes the change in the same templated form the pages use', () => {
    expect(renderFeed([record()])).toContain(
      '<description>raw/openai-llms-txt/response.txt modified: 1 line added, 6 lines removed. Timestamp 28 August 2026 08:08 UTC (origin). Raw artifact at this commit: ' +
        PERMALINK +
        '</description>',
    );
  });

  it('says the timestamp was not recorded rather than leaving the field blank', () => {
    const r = record({ artifacts: [artifact({ sidecar: null })] });
    expect(renderFeed([r])).toContain('Timestamp no timestamp recorded.');
  });

  it('labels an observed timestamp as observed in the description', () => {
    const r = record({ artifacts: [artifact({ sidecar: sidecar({ originDate: null }) })] });
    expect(renderFeed([r])).toContain('Timestamp 28 August 2026 11:23 UTC (observed).');
  });

  it('does not mark an unretracted change', () => {
    expect(renderFeed([record()])).not.toContain('RETRACTED');
  });

  it('links the feed to the index at the given base', () => {
    expect(renderFeed([record()], 'https://example.test/archive')).toContain(
      '<link>https://example.test/archive/index.html</link>',
    );
  });

  it('leaves an unparseable timestamp in the pubDate rather than printing Invalid Date', () => {
    const r = record({ artifacts: [artifact({ sidecar: sidecar({ originDate: 'not a date' }) })] });
    expect(renderFeed([r])).toContain('<pubDate>not a date</pubDate>');
  });

  it('caps the feed at fifty items', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      record({ sha: String(i).padStart(40, '0') }),
    );
    expect(renderFeed(many).split('<item>')).toHaveLength(51);
  });
});
