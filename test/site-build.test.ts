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
  it('emits exactly the pages, feed, stylesheet and .nojekyll', () => {
    expect(buildSite(unsorted).map((f) => f.path).sort()).toEqual([
      '.nojekyll',
      'changes/0e91a0fbf78e6302670dc61a8c28502e418d01a1.html',
      'changes/a0a9e12e5287b8ce564e6de63a280498413484cf.html',
      'feed.xml',
      'index.html',
      'sources/claude-status.html',
      'sources/openai-llms-txt.html',
      'style.css',
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

  it('names a change page after the full commit sha', () => {
    expect(buildSite([newer])[4]?.path).toBe('changes/a0a9e12e5287b8ce564e6de63a280498413484cf.html');
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

  it('emits only the four fixed files for an archive with no changes yet', () => {
    expect(buildSite([]).map((f) => f.path)).toEqual(['.nojekyll', 'style.css', 'index.html', 'feed.xml']);
  });
});

describe('buildSite: the feed base URL', () => {
  // The /site segment is load-bearing: GitHub Pages' branch source publishes
  // the repository root or /docs, so docs/site/ is reached one level down.
  it('defaults to the Pages path docs/site is actually served at', () => {
    expect(at(buildSite([newer]), 'feed.xml')).toContain(
      '<link>https://maxwellbrohm.github.io/llm-catalog-archive/site/index.html</link>',
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

describe('buildSite: ordering', () => {
  it('puts the newest change first on the index however the records arrive', () => {
    const html = at(buildSite(unsorted), 'index.html');
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

  it('keeps the retracted change on the index', () => {
    expect(at(retracted, 'index.html')).toContain('changes/a0a9e12e5287b8ce564e6de63a280498413484cf.html');
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
