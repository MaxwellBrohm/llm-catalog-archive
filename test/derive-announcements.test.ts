import { describe, expect, it } from 'vitest';
import { eventsFromChange, claimSentence, type DerivedEvent } from '../src/derive/events.js';
import { announcementUrls, incidentEntries, postEntries, ANNOUNCEMENT_PATHS } from '../src/derive/announcements.js';
import { change } from './derive-fixtures.js';

/**
 * THE HALF OF "AI NEWS" THE ARCHIVE COLLECTED AND THREW AWAY.
 *
 * Every source is a catalogue, a docs index, a sitemap, a status feed or a PR
 * search, and the derivation read only the first two kinds. Measured on the
 * live archive: anthropic-sitemap stores 438 URLs under /news/, /research/ and
 * /engineering/, and claude-status stores 25 parsed incidents, and NOT ONE of
 * them reached a page. A developer asking what happened this week got price
 * changes.
 */
const sitemap = (urls: string[]) =>
  `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;

const smChange = (before: string, after: string) =>
  change({ sourceId: 'anthropic-sitemap', path: 'raw/anthropic-sitemap/response.xml', before, after });

const NEWS = 'https://www.anthropic.com/news/improving-alignment-security-efforts';
const RESEARCH = 'https://www.anthropic.com/research/some-paper';
const PRICING = 'https://www.anthropic.com/pricing';

describe('a post appearing in a sitemap', () => {
  const events = eventsFromChange(smChange(sitemap([PRICING]), sitemap([PRICING, NEWS])));

  it('is one event', () => {
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('post_listed');
  });

  /**
   * A sitemap carries no title, so the sentence quotes the URL and nothing
   * else. Reading a headline out of a slug would be an inference; the URL is
   * the fact, and for these paths it is a legible one.
   */
  it('quotes the URL and invents no headline from the slug', () => {
    const sentence = claimSentence(events[0] as DerivedEvent);
    expect(sentence).toBe(`The anthropic-sitemap index listed a URL it had not listed before: "${NEWS}".`);
    expect(sentence).not.toContain('improving alignment');
  });

  it('names the index as the subject, never the company', () => {
    expect(claimSentence(events[0] as DerivedEvent).startsWith('The anthropic-sitemap')).toBe(true);
  });

  it('ignores a URL outside the announcement paths, so a pricing page is not news', () => {
    const e = eventsFromChange(smChange(sitemap([NEWS]), sitemap([NEWS, PRICING])));
    expect(e).toEqual([]);
  });

  it('counts research and engineering as announcements too', () => {
    const e = eventsFromChange(smChange(sitemap([]), sitemap([RESEARCH])));
    expect(e).toHaveLength(1);
  });

  it('emits nothing when a URL merely disappears', () => {
    expect(eventsFromChange(smChange(sitemap([NEWS]), sitemap([])))).toEqual([]);
  });

  /**
   * THE LOC SET ONLY, NEVER lastmod. anthropic-sitemap's per-URL lastmod
   * oscillates between edge caches, measured at 24 of 516 values differing
   * across two fetches four seconds apart. Keying on it would publish a story
   * every time a CDN node disagreed with itself.
   */
  it('emits nothing when only lastmod changed', () => {
    const withMod = (mod: string) =>
      `<?xml version="1.0"?><urlset><url><loc>${NEWS}</loc><lastmod>${mod}</lastmod></url></urlset>`;
    expect(eventsFromChange(smChange(withMod('2026-08-01'), withMod('2026-08-31')))).toEqual([]);
  });

  it('emits nothing on a baseline, because 438 stored URLs are not 438 stories today', () => {
    const baseline = change({
      sourceId: 'anthropic-sitemap',
      path: 'raw/anthropic-sitemap/response.xml',
      kind: 'added',
      before: null,
      after: sitemap([NEWS, RESEARCH]),
    });
    expect(eventsFromChange(baseline)).toEqual([]);
  });
});

const atom = (entries: { id: string; title: string; href: string; published?: string }[]) =>
  `<?xml version="1.0"?><feed>${entries
    .map(
      (e) =>
        `<entry><id>${e.id}</id><published>${e.published ?? '2026-08-31T20:36:00Z'}</published>` +
        `<link rel="alternate" href="${e.href}"/><title>${e.title}</title></entry>`,
    )
    .join('')}</feed>`;

const stChange = (before: string, after: string) =>
  change({ sourceId: 'claude-status', path: 'raw/claude-status/response.atom', before, after });

const INC = {
  id: 'tag:status.claude.com,2005:Incident/31320063',
  title: 'Degraded performance on claude.ai and Claude Code',
  href: 'https://status.claude.com/incidents/r82kdk0m7vqh',
};

describe('an incident appearing in a status feed', () => {
  const events = eventsFromChange(stChange(atom([]), atom([INC])));

  it('is one event carrying the title the feed published', () => {
    expect(events).toHaveLength(1);
    const e = events[0] as Extract<DerivedEvent, { type: 'incident_opened' }>;
    expect(e.type).toBe('incident_opened');
    expect(e.title).toBe(INC.title);
    expect(e.url).toBe(INC.href);
  });

  it('quotes the third-party title rather than composing prose around it', () => {
    expect(claimSentence(events[0] as DerivedEvent)).toBe(
      `The claude-status feed listed an incident titled "${INC.title}" at "${INC.href}".`,
    );
  });

  /**
   * KEYED ON THE ENTRY ID. A provider EDITS an incident as it develops,
   * appending "Monitoring" then "Resolved" to the same entry, so keying on the
   * title or the content would report one outage three times.
   */
  it('does not report the same incident again when its content is edited', () => {
    const before = atom([INC]);
    const after = atom([{ ...INC, title: `${INC.title} (Resolved)` }]);
    expect(eventsFromChange(stChange(before, after))).toEqual([]);
  });

  it('reports a genuinely new incident beside an existing one', () => {
    const second = { id: 'tag:status.claude.com,2005:Incident/999', title: 'API errors', href: 'https://x/2' };
    const e = eventsFromChange(stChange(atom([INC]), atom([INC, second])));
    expect(e).toHaveLength(1);
    expect((e[0] as Extract<DerivedEvent, { type: 'incident_opened' }>).title).toBe('API errors');
  });

  it('skips an entry with no title rather than publishing an empty headline', () => {
    const e = eventsFromChange(stChange(atom([]), atom([{ ...INC, title: '' }])));
    expect(e).toEqual([]);
  });

  it('emits nothing on a baseline', () => {
    const baseline = change({
      sourceId: 'claude-status',
      path: 'raw/claude-status/response.atom',
      kind: 'added',
      before: null,
      after: atom([INC]),
    });
    expect(eventsFromChange(baseline)).toEqual([]);
  });
});

describe('the extractors, against the real stored bytes', () => {
  it('finds the announcement URLs the live sitemap carries', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    if (!fs.existsSync('raw/anthropic-sitemap/response.xml')) return;
    const urls = announcementUrls(
      fs.readFileSync('raw/anthropic-sitemap/response.xml', 'utf8'),
      ANNOUNCEMENT_PATHS['anthropic-sitemap'] as string[],
    );
    expect(urls.size).toBeGreaterThan(100);
    for (const u of urls) expect(u).toMatch(/\/(news|research|engineering)\//);
  });

  it('parses the live status feed into entries with titles and links', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    if (!fs.existsSync('raw/claude-status/response.atom')) return;
    const entries = incidentEntries(fs.readFileSync('raw/claude-status/response.atom', 'utf8'));
    expect(entries.length).toBeGreaterThan(5);
    for (const e of entries) {
      expect(e.id).not.toBe('');
      expect(e.title).not.toBe('');
    }
  });

  it('decodes the entities an Atom title carries, so a headline is not mojibake', () => {
    const e = incidentEntries('<entry><id>x</id><title>A &amp; B &quot;C&quot;</title></entry>');
    expect(e[0]?.title).toBe('A & B "C"');
  });
});

/**
 * openai-status wraps its titles in CDATA and claude-status does not, so one
 * provider rendered clean and the other published
 * `<![CDATA[Elevated errors in ChatGPT conversations...]]>` markers and all, on
 * a site whose whole claim is that it prints what the artifact says.
 */
describe('a title wrapped in CDATA', () => {
  it('is unwrapped, not published with its markers', () => {
    const e = incidentEntries('<entry><id>x</id><title><![CDATA[Elevated errors]]></title></entry>');
    expect(e[0]?.title).toBe('Elevated errors');
  });

  it('leaves an unwrapped title exactly alone', () => {
    const e = incidentEntries('<entry><id>x</id><title>Degraded performance</title></entry>');
    expect(e[0]?.title).toBe('Degraded performance');
  });

  it('does not strip a stray bracket that is not a CDATA wrapper', () => {
    const e = incidentEntries('<entry><id>x</id><title>Issue [P1] resolved</title></entry>');
    expect(e[0]?.title).toBe('Issue [P1] resolved');
  });
});

const rss = (items: { title: string; link: string; date?: string }[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><lastBuildDate>Tue, 01 Sep 2026 15:58:32 GMT</lastBuildDate>${items
    .map(
      (i) =>
        `<item><title><![CDATA[${i.title}]]></title><link>${i.link}</link>` +
        `<pubDate>${i.date ?? 'Mon, 31 Aug 2026 07:00:00 GMT'}</pubDate></item>`,
    )
    .join('')}</channel></rss>`;

const feedChange = (before: string, after: string) =>
  change({ sourceId: 'openai-news-feed', path: 'raw/openai-news-feed/response.xml', before, after });

const POST = {
  title: 'OpenAI supports California’s bill to advance youth AI safety',
  link: 'https://openai.com/index/supporting-california-bill-advance-ai-youth-safety',
};

/**
 * A sitemap reports "a URL appeared", which is news only to a reader who
 * already knows what the slug means. A feed carries the provider's own
 * headline, and that is the difference between a change archive and a news
 * site. Both types exist because they support different claims.
 */
describe('a post published in an announcement feed', () => {
  const events = eventsFromChange(feedChange(rss([]), rss([POST])));

  it('is one event carrying the headline the provider wrote', () => {
    expect(events).toHaveLength(1);
    const e = events[0] as Extract<DerivedEvent, { type: 'post_published' }>;
    expect(e.type).toBe('post_published');
    expect(e.title).toBe(POST.title);
    expect(e.url).toBe(POST.link);
  });

  it('quotes the headline rather than composing prose around it', () => {
    expect(claimSentence(events[0] as DerivedEvent)).toBe(
      `The openai-news-feed published a post titled "${POST.title}" at "${POST.link}".`,
    );
  });

  /**
   * The id already ends in what the artifact is, so the sentence must not add
   * the noun again: "The openai-news-feed feed published" repeats a word, and
   * that has now shipped in two separate claim forms. test/derive-claims.test.ts
   * guards the whole set against it.
   */
  it('names the feed as the subject, never the company, and does not repeat the noun', () => {
    const sentence = claimSentence(events[0] as DerivedEvent);
    expect(sentence.startsWith('The openai-news-feed published')).toBe(true);
    expect(sentence).not.toContain('feed feed');
  });

  it('emits nothing when only the channel build stamp moved', () => {
    const a = rss([POST]);
    const b = a.replace('Tue, 01 Sep 2026 15:58:32 GMT', 'Wed, 02 Sep 2026 09:00:00 GMT');
    expect(eventsFromChange(feedChange(a, b))).toEqual([]);
  });

  /**
   * Identity is the LINK, not a guid and not the title. A provider correcting a
   * typo in a headline is stored but is not a second story, and a CMS migration
   * that rewrites guids must not republish the whole back catalogue.
   */
  it('emits nothing when only the title was corrected', () => {
    const before = rss([POST]);
    const after = rss([{ ...POST, title: 'OpenAI supports California’s bill on youth AI safety' }]);
    expect(eventsFromChange(feedChange(before, after))).toEqual([]);
  });

  it('reports a genuinely new post beside an existing one', () => {
    const second = { title: 'A second post', link: 'https://openai.com/index/second' };
    const e = eventsFromChange(feedChange(rss([POST]), rss([POST, second])));
    expect(e).toHaveLength(1);
    expect((e[0] as Extract<DerivedEvent, { type: 'post_published' }>).title).toBe('A second post');
  });

  it('emits nothing on a baseline, because 1,159 stored posts are not 1,159 stories today', () => {
    const baseline = change({
      sourceId: 'openai-news-feed',
      path: 'raw/openai-news-feed/response.xml',
      kind: 'added',
      before: null,
      after: rss([POST]),
    });
    expect(eventsFromChange(baseline)).toEqual([]);
  });

  it('skips an item with no link, which cannot be identified or linked', () => {
    const noLink = '<?xml version="1.0"?><rss><channel><item><title>x</title></item></channel></rss>';
    expect(eventsFromChange(feedChange('<rss></rss>', noLink))).toEqual([]);
  });
});

describe('the feed parser, against the real stored bytes', () => {
  it.each(['openai-news-feed', 'deepmind-blog-feed', 'huggingface-blog-feed'])(
    'reads %s into posts that all have a title and a link',
    (id) => {
      const fs = require('node:fs') as typeof import('node:fs');
      const p = `raw/${id}/response.xml`;
      if (!fs.existsSync(p)) return;
      const posts = postEntries(fs.readFileSync(p, 'utf8'));
      expect(posts.length).toBeGreaterThan(50);
      for (const post of posts) {
        expect(post.title, id).not.toBe('');
        expect(post.url, id).toMatch(/^https?:\/\//);
      }
    },
  );

  it('unwraps the CDATA that every one of these feeds wraps its titles in', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    if (!fs.existsSync('raw/openai-news-feed/response.xml')) return;
    const posts = postEntries(fs.readFileSync('raw/openai-news-feed/response.xml', 'utf8'));
    for (const post of posts) expect(post.title).not.toContain('CDATA');
  });
});
