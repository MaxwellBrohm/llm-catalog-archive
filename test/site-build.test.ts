import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSite, writeSite } from '../src/site/build.js';
import { artifact, record, sidecar, OTHER_SHA, SHA } from './site-fixtures.js';

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

const older = record({
  sha: OTHER_SHA,
  artifacts: [
    artifact({
      sourceId: 'claude-status',
      path: 'raw/claude-status/response.atom',
      sidecar: sidecar({ originDate: '2026-08-26T20:25:00.000Z' }),
    }),
  ],
});
const newer = record();

/** Deliberately oldest-first, so the sort inside buildSite is what orders it. */
const unsorted = [older, newer];

const at = (files: { path: string; contents: string }[], p: string): string => {
  const hit = files.find((f) => f.path === p);
  if (hit === undefined) throw new Error(`no file at ${p}`);
  return hit.contents;
};

describe('buildSite: the file set', () => {
  it('emits exactly the pages, feeds, stylesheet, .nojekyll and one stub per page', () => {
    expect(buildSite(unsorted).map((f) => f.path).sort()).toEqual([
      '.nojekyll',
      'about.html',
      'api.html',
      'changelog/index.html',
      'changes/0e91a0fbf78e6302670dc61a8c28502e418d01a1.html',
      'changes/a0a9e12e5287b8ce564e6de63a280498413484cf.html',
      'everything.xml',
      'feed.xml',
      'index.html',
      'leaks/index.html',
      'leaks/ledger.html',
      'site/about.html',
      'site/api.html',
      'site/changelog/index.html',
      'site/changes/0e91a0fbf78e6302670dc61a8c28502e418d01a1.html',
      'site/changes/a0a9e12e5287b8ce564e6de63a280498413484cf.html',
      'site/index.html',
      'site/leaks/index.html',
      'site/leaks/ledger.html',
      'site/sources/claude-status.html',
      'site/sources/openai-llms-txt.html',
      'site/threads/index.html',
      'site/type/alias-retargeted.html',
      'site/type/codename-entered.html',
      'site/type/codename-unmasked.html',
      'site/type/context-changed.html',
      'site/type/doc-added.html',
      'site/type/doc-removed.html',
      'site/type/expiration-scheduled.html',
      'site/type/expiration-set.html',
      'site/type/model-added.html',
      'site/type/model-removed.html',
      'site/type/price-changed.html',
      'site/type/retirement-floor.html',
      'site/type/stealth-listing.html',
      'site/type/upstream-pr-merged.html',
      'site/type/upstream-pr-opened.html',
      'sources/claude-status.html',
      'sources/openai-llms-txt.html',
      'style.css',
      'threads/index.html',
      'type/alias-retargeted.html',
      'type/codename-entered.html',
      'type/codename-unmasked.html',
      'type/context-changed.html',
      'type/doc-added.html',
      'type/doc-removed.html',
      'type/expiration-scheduled.html',
      'type/expiration-set.html',
      'type/model-added.html',
      'type/model-removed.html',
      'type/price-changed.html',
      'type/retirement-floor.html',
      'type/stealth-listing.html',
      'type/upstream-pr-merged.html',
      'type/upstream-pr-opened.html',
    ]);
  });

  it('emits .nojekyll, which stops GitHub Pages running Jekyll over the directory', () => {
    expect(buildSite(unsorted).some((f) => f.path === '.nojekyll')).toBe(true);
  });

  it('emits one change page per record', () => {
    expect(buildSite(unsorted).filter((f) => f.path.startsWith('changes/'))).toHaveLength(2);
  });

  it('emits one source page per source seen in history', () => {
    expect(buildSite(unsorted).filter((f) => f.path.startsWith('sources/'))).toHaveLength(2);
  });

  it('emits no page for a source that never changed', () => {
    expect(buildSite(unsorted).some((f) => f.path === 'sources/mistral-llms-txt.html')).toBe(false);
  });

  // By path rather than by position in the array: the fixed pages ahead of the
  // change pages grew when the publication did, and an index-based assertion
  // silently became an assertion about about.html.
  it('names a change page after the full commit sha', () => {
    expect(buildSite([newer]).map((f) => f.path)).toContain(
      'changes/a0a9e12e5287b8ce564e6de63a280498413484cf.html',
    );
  });

  it('ships the stylesheet the pages link', () => {
    expect(at(buildSite(unsorted), 'style.css')).toContain('--orange: #ff6a00;');
  });

  // Empty on purpose. GitHub Pages keys on the file existing, and any content
  // would be served as a file at /.nojekyll.
  it('writes .nojekyll with no contents', () => {
    expect(at(buildSite(unsorted), '.nojekyll')).toBe('');
  });

  it('lists the source pages alphabetically', () => {
    const paths = buildSite(unsorted).map((f) => f.path).filter((p) => p.startsWith('sources/'));
    expect(paths).toEqual(['sources/claude-status.html', 'sources/openai-llms-txt.html']);
  });

  it('emits one source page for a source that changed twice, not two', () => {
    const twice = [record(), record({ sha: OTHER_SHA })];
    expect(buildSite(twice).filter((f) => f.path.startsWith('sources/'))).toHaveLength(1);
  });

  // The threads index is fixed too, and it is emitted for an empty archive on
  // purpose: a page saying nothing has been derived yet is a claim about the
  // deriver, and the alternative is a navigation link that 404s on a quiet day.
  // Every fixed page, plus its stub, for an archive with nothing in it yet.
  //
  // EVERY MICRO-CATEGORY IS HERE WITH NOTHING BEHIND IT, which is the point. A
  // category page that appeared only once the archive held one of its items
  // would make "no reveals this week" and "the extractor broke three weeks ago"
  // render as the same missing link, and the second is the failure this project
  // is organised around not hiding. A LAB page is the deliberate exception: it
  // is emitted only where the archive carries that lab, because an empty lab
  // page is a claim to be watching a lab we have nothing on.
  it('emits every fixed page and its stub for an archive with no changes yet', () => {
    expect(buildSite([]).map((f) => f.path)).toEqual([
      '.nojekyll',
      'style.css',
      'index.html',
      'everything.xml',
      'about.html',
      'api.html',
      'changelog/index.html',
      'feed.xml',
      'type/model-added.html',
      'type/model-removed.html',
      'type/price-changed.html',
      'type/context-changed.html',
      'type/expiration-set.html',
      'type/alias-retargeted.html',
      'type/retirement-floor.html',
      'type/doc-added.html',
      'type/doc-removed.html',
      'type/codename-entered.html',
      'type/codename-unmasked.html',
      'type/upstream-pr-opened.html',
      'type/upstream-pr-merged.html',
      'type/stealth-listing.html',
      'type/expiration-scheduled.html',
      'threads/index.html',
      'leaks/index.html',
      'leaks/ledger.html',
      'site/index.html',
      'site/about.html',
      'site/api.html',
      'site/changelog/index.html',
      'site/type/model-added.html',
      'site/type/model-removed.html',
      'site/type/price-changed.html',
      'site/type/context-changed.html',
      'site/type/expiration-set.html',
      'site/type/alias-retargeted.html',
      'site/type/retirement-floor.html',
      'site/type/doc-added.html',
      'site/type/doc-removed.html',
      'site/type/codename-entered.html',
      'site/type/codename-unmasked.html',
      'site/type/upstream-pr-opened.html',
      'site/type/upstream-pr-merged.html',
      'site/type/stealth-listing.html',
      'site/type/expiration-scheduled.html',
      'site/threads/index.html',
      'site/leaks/index.html',
      'site/leaks/ledger.html',
    ]);
  });
});

describe('buildSite: the feed base URL', () => {
  // No /site segment. The build directory is uploaded as the Pages artifact
  // root, so the site is served at the root of the repository's Pages domain.
  it('defaults to the Pages root the artifact is deployed at', () => {
    expect(at(buildSite([newer]), 'feed.xml')).toContain(
      '<link>https://maxwellbrohm.github.io/llm-catalog-archive/index.html</link>',
    );
  });

  it('uses a caller-supplied base instead when one is given', () => {
    expect(at(buildSite([newer], 'https://example.test/archive'), 'feed.xml')).toContain(
      '<link>https://example.test/archive/index.html</link>',
    );
  });

  it('builds item links from the same base', () => {
    expect(at(buildSite([newer], 'https://example.test/archive'), 'feed.xml')).toContain(
      '<guid isPermaLink="true">https://example.test/archive/changes/a0a9e12e5287b8ce564e6de63a280498413484cf.html#openai-llms-txt</guid>',
    );
  });
});

/**
 * The site moved up one directory when Pages stopped publishing it from the
 * branch's /docs folder, and spec section 10 makes a change page's URL a
 * permalink. These assert the old URLs still resolve, and resolve to the right
 * page rather than merely to something.
 */
describe('buildSite: the pages that moved', () => {
  const files = buildSite(unsorted);

  it('points the old front door at the new root', () => {
    expect(at(files, 'site/index.html')).toContain('<meta http-equiv="refresh" content="0; url=../index.html">');
  });

  it('points an old change URL at the same change at its new address', () => {
    expect(at(files, 'site/changes/a0a9e12e5287b8ce564e6de63a280498413484cf.html')).toContain(
      '<meta http-equiv="refresh" content="0; url=../../changes/a0a9e12e5287b8ce564e6de63a280498413484cf.html">',
    );
  });

  it('names the new address as canonical for crawlers that ignore a refresh', () => {
    expect(at(files, 'site/sources/claude-status.html')).toContain(
      '<link rel="canonical" href="../../sources/claude-status.html">',
    );
  });

  it('forwards rather than duplicating the page it forwards to', () => {
    expect(at(files, 'site/changes/a0a9e12e5287b8ce564e6de63a280498413484cf.html')).not.toContain('<table');
  });

  // A meta refresh inside feed.xml is malformed RSS, not a redirect, and a stub
  // served as style.css is not a stylesheet. Only HTML is mirrored.
  it('mirrors no stub for the feed', () => {
    expect(files.some((f) => f.path === 'site/feed.xml')).toBe(false);
  });

  it('mirrors no stub for the stylesheet', () => {
    expect(files.some((f) => f.path === 'site/style.css')).toBe(false);
  });

  it('mirrors every HTML page it emits and no more', () => {
    const pages = files.filter((f) => f.path.endsWith('.html') && !f.path.startsWith('site/'));
    const stubs = files.filter((f) => f.path.startsWith('site/'));
    expect(stubs.map((f) => f.path).sort()).toEqual(pages.map((f) => `site/${f.path}`).sort());
  });
});

describe('buildSite: ordering', () => {
  // The changelog, not index.html: the front page is now the derived feed, and
  // these two fixture records support no derived event at all, so the day
  // headings this asserts on live on the changelog.
  it('puts the newest change first on the changelog however the records arrive', () => {
    const html = at(buildSite(unsorted), 'changelog/index.html');
    expect(html.indexOf('2026-08-28')).toBeLessThan(html.indexOf('2026-08-26'));
  });

  it('puts the newest change first in the feed', () => {
    const xml = at(buildSite(unsorted), 'feed.xml');
    expect(xml.indexOf('openai-llms-txt:')).toBeLessThan(xml.indexOf('claude-status:'));
  });

  it("reads the newest change as the source page's latest", () => {
    const html = at(buildSite(unsorted), 'sources/openai-llms-txt.html');
    expect(html).toContain('<dt>Latest recorded change</dt><dd><time datetime="2026-08-28T08:08:22.000Z">');
  });
});

describe('buildSite: the retraction path', () => {
  const retracted = buildSite([record({ retraction: { sha: SHA, path: null, reason: 'fixture' } })]);

  it('still emits the change page at its permalink', () => {
    expect(retracted.some((f) => f.path === 'changes/a0a9e12e5287b8ce564e6de63a280498413484cf.html')).toBe(true);
  });

  it('marks that page retracted', () => {
    expect(at(retracted, 'changes/a0a9e12e5287b8ce564e6de63a280498413484cf.html')).toContain(
      '<span class="badge badge-retracted">retracted</span>',
    );
  });

  it('keeps the retracted change on the changelog', () => {
    expect(at(retracted, 'changelog/index.html')).toContain(
      '../changes/a0a9e12e5287b8ce564e6de63a280498413484cf.html',
    );
  });

  it('keeps the retracted change in the feed', () => {
    expect(at(retracted, 'feed.xml')).toContain('RETRACTED. ');
  });
});

describe('writeSite', () => {
  it('writes a file at its path inside the output directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-out-'));
    temps.push(dir);
    writeSite(dir, [{ path: 'index.html', contents: 'hello' }]);
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe('hello');
  });

  it('creates the nested directory a change page needs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-out-'));
    temps.push(dir);
    writeSite(dir, [{ path: 'changes/abc.html', contents: 'page' }]);
    expect(fs.readFileSync(path.join(dir, 'changes/abc.html'), 'utf8')).toBe('page');
  });

  it('overwrites a page from a previous build rather than appending to it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-out-'));
    temps.push(dir);
    writeSite(dir, [{ path: 'index.html', contents: 'first' }]);
    writeSite(dir, [{ path: 'index.html', contents: 'second' }]);
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe('second');
  });
});
