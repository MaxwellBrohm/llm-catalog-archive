import { describe, it, expect } from 'vitest';
import { buildSite, textContents, type SiteFile } from '../src/site/build.js';
import { pageDescription } from '../src/site/render.js';
import { artifact, record } from './site-fixtures.js';

/**
 * 494 PAGES CARRIED NO DESCRIPTION AND NO SHARE CARD.
 *
 * Nothing unfurled as nothing: consumers fall back to <title>. What actually
 * happened is worse than nothing in one specific way, which is that EVERY link
 * showed the same six words, so a thread page about one model, the leaks desk
 * and the API documentation were indistinguishable in a chat or a reader until
 * somebody clicked.
 */
const files = buildSite([record({ artifacts: [artifact()] })]);
const pages = files.filter((f) => f.path.endsWith('.html') && !f.path.startsWith('site/'));

describe('every real page carries share and index metadata', () => {
  it('has pages to check, so this cannot pass by walking nothing', () => {
    expect(pages.length).toBeGreaterThan(10);
  });

  it.each(['<meta name="description"', 'og:title', 'og:description', 'twitter:card'])(
    'emits %s on every page',
    (needle) => {
      const missing = pages.filter((f) => !textContents(f).includes(needle)).map((f) => f.path);
      expect(missing).toEqual([]);
    },
  );

  /**
   * The redirect stubs deliberately carry none. They are a meta refresh to the
   * real address, and giving them cards would advertise two spellings of one
   * page.
   */
  it('leaves the legacy redirect stubs without cards', () => {
    const stubs = files.filter((f) => f.path.startsWith('site/') && f.path.endsWith('.html'));
    expect(stubs.length).toBeGreaterThan(0);
    for (const stub of stubs) expect(textContents(stub)).not.toContain('og:title');
  });

  it('gives different pages different descriptions', () => {
    const descriptions = new Set(
      pages.map((f) => /<meta name="description" content="([^"]*)"/.exec(textContents(f))?.[1] ?? ''),
    );
    expect(descriptions.size).toBeGreaterThan(3);
  });

  it('promises no og:image, because there is no image to point at', () => {
    for (const f of pages) expect(textContents(f)).not.toContain('og:image');
  });
});

describe('pageDescription', () => {
  it('reads the page lede rather than composing a sentence', () => {
    expect(pageDescription('<p class="lede">Two hundred items, newest first.</p>', 'fallback')).toBe(
      'Two hundred items, newest first.',
    );
  });

  it('strips markup, because a meta attribute cannot carry it', () => {
    expect(pageDescription('<p class="lede">See <a href="x">the index</a> for more.</p>', 'f')).toBe(
      'See the index for more.',
    );
  });

  it('unescapes entities the renderer put in, so the card reads as prose', () => {
    expect(pageDescription('<p class="lede">OpenRouter&#39;s catalog &quot;x&quot; &amp; more</p>', 'f')).toBe(
      'OpenRouter\'s catalog "x" & more',
    );
  });

  it('falls back when the page has no lede', () => {
    expect(pageDescription('<h1>No lede here</h1>', 'the fallback')).toBe('the fallback');
  });

  it('truncates on a word boundary rather than mid-word', () => {
    const long = `<p class="lede">${'word '.repeat(200)}</p>`;
    const out = pageDescription(long, 'f');
    expect(out.length).toBeLessThanOrEqual(304);
    expect(out.endsWith('...')).toBe(true);
    expect(out).not.toContain('wor.');
  });

  it('leaves a description already inside the limit exactly alone', () => {
    const text = 'Short enough to keep.';
    expect(pageDescription(`<p class="lede">${text}</p>`, 'f')).toBe(text);
  });
});

describe('robots.txt and sitemap.xml', () => {
  const get = (p: string): string => {
    const hit = files.find((f) => f.path === p);
    if (hit === undefined) throw new Error(`no ${p}`);
    return textContents(hit);
  };

  it('points robots at the sitemap, which is the only part that carries information', () => {
    expect(get('robots.txt')).toContain('Sitemap: https://');
  });

  it('permits the whole archive, which is public by design', () => {
    expect(get('robots.txt')).toContain('Allow: /');
  });

  it('lists exactly the real pages, and not one redirect stub', () => {
    const listed = [...get('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] as string);
    expect(listed.length).toBe(pages.length);
    expect(listed.some((u) => u.includes('/site/'))).toBe(false);
  });

  it('lists absolute URLs under the published origin', () => {
    for (const m of get('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)) {
      expect(m[1]).toMatch(/^https:\/\//);
    }
  });

  it('is well-formed enough that every loc is escaped', () => {
    expect(/&(?!(amp|lt|gt|quot|#0?39);)/.test(get('sitemap.xml'))).toBe(false);
  });
});

describe('a reader can subscribe to one micro-category', () => {
  const feeds = files.filter((f) => f.path.endsWith('.xml') && f.path !== 'sitemap.xml');

  it('publishes more than the two feeds it used to', () => {
    expect(feeds.length).toBeGreaterThan(2);
  });

  it('gives the leaks desk its own feed', () => {
    expect(files.some((f) => f.path === 'leaks/index.xml')).toBe(true);
  });

  it('advertises that feed on the desk itself, so a browser can find it', () => {
    const desk = files.find((f) => f.path === 'leaks/index.html') as SiteFile;
    expect(textContents(desk)).toContain('rumors and leaks');
    expect(textContents(desk)).toContain('leaks/index.xml');
  });

  it('gives every micro-category page a feed and advertises it there', () => {
    const typePages = files.filter((f) => f.path.startsWith('type/') && f.path.endsWith('.html'));
    expect(typePages.length).toBeGreaterThan(10);
    for (const page of typePages) {
      const feed = page.path.replace(/\.html$/, '.xml');
      expect(files.some((f) => f.path === feed), `${feed} missing`).toBe(true);
      expect(textContents(page), `${page.path} does not advertise ${feed}`).toContain(feed.replace('type/', ''));
    }
  });

  it('names each filtered feed for its own category rather than reusing the everything title', () => {
    const leaks = files.find((f) => f.path === 'leaks/index.xml') as SiteFile;
    expect(textContents(leaks)).toContain('<title>llm-catalog-archive: rumors and leaks</title>');
  });
});

/**
 * A CONFIGURED SOURCE THAT HAS NEVER STORED A BYTE HAD NO PAGE AT ALL.
 *
 * The page list was built from the directories present under raw/, so
 * xai-llms-txt, which has been configured and active for days and held out of
 * the archive by the credential gate on every single run, was invisible
 * everywhere on the site. A collection this project chose to make and cannot
 * complete is exactly what the About page's own standard says to state rather
 * than imply.
 */
describe('a source with no captures', () => {
  const configured = [
    { id: 'never-captured', url: 'https://vendor.example/llms.txt', status: 'active', notes: 'held' },
  ];
  const withConfig = buildSite([record({ artifacts: [artifact()] })], undefined, undefined, [], [], [], [], configured);
  const page = withConfig.find((f) => f.path === 'sources/never-captured.html');

  it('still gets a page', () => {
    expect(page).toBeDefined();
  });

  it('says the archive holds nothing for it, rather than showing a bare zero', () => {
    expect(textContents(page as SiteFile)).toContain('holds no capture of it at all');
  });

  it('says it is not missing by accident', () => {
    expect(textContents(page as SiteFile)).toContain('Nothing here is missing by accident');
  });

  it('names the configured URL and status, so the page is checkable', () => {
    const html = textContents(page as SiteFile);
    expect(html).toContain('https://vendor.example/llms.txt');
    expect(html).toContain('Status in meta/sources.json');
  });

  it('leaves a source that HAS captures without the empty note', () => {
    const captured = withConfig.find((f) => f.path.startsWith('sources/') && f.path !== 'sources/never-captured.html');
    expect(captured).toBeDefined();
    expect(textContents(captured as SiteFile)).not.toContain('holds no capture of it at all');
  });

  it('is listed in the sitemap like any other page', () => {
    const sitemap = withConfig.find((f) => f.path === 'sitemap.xml') as SiteFile;
    expect(textContents(sitemap)).toContain('sources/never-captured.html');
  });
});
