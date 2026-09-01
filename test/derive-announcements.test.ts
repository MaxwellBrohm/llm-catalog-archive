import { describe, expect, it } from 'vitest';
import { eventsFromChange, claimSentence, type DerivedEvent } from '../src/derive/events.js';
import { announcementUrls, incidentEntries, ANNOUNCEMENT_PATHS } from '../src/derive/announcements.js';
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
