import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderEverythingFeed, renderFeed } from '../src/site/render.js';
import { buildFeed } from '../src/derive/feed.js';
import { deriveEvents } from '../src/derive/events.js';
import { catalog, change } from './derive-fixtures.js';
import { artifact, record } from './site-fixtures.js';
import type { FeedItem } from '../src/derive/feed.js';

/**
 * NEITHER PUBLISHED FEED WAS EVER PARSED BY A TEST.
 *
 * Both feeds interpolate third-party text into XML: an event sentence carries a
 * catalogue id, and a leak sentence carries an upstream pull-request TITLE,
 * which is a string a stranger types. The escaping was present but nothing
 * exercised it, and removing escapeHtml from both description interpolations
 * added ZERO failures to a 2,365 test suite. Today's real feeds happen to carry
 * only apostrophes and quotes, both legal raw in XML text, so the bug is latent:
 * the day a title with an ampersand lands, every subscriber's reader breaks
 * while the site and CI stay green.
 *
 * Parsing is the assertion that covers title, link, guid, category and
 * description at once, which is why this asserts well-formedness rather than
 * grepping for &amp;. Node ships no XML parser, so python3's expat is used; it
 * is present on the CI runner and on any machine that can run this repo's
 * tooling.
 */
function assertWellFormed(xml: string): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-xml-'));
  const file = path.join(dir, 'feed.xml');
  try {
    fs.writeFileSync(file, xml);
    execFileSync(
      'python3',
      ['-c', 'import sys,xml.etree.ElementTree as ET; ET.parse(sys.argv[1])', file],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Every character that is a syntax error, or a smuggled tag, in XML text. */
const HOSTILE = 'Ampersand & <tag> "quoted" \'apostrophe\' ]]> <![CDATA[ x';

const changes = [
  change({
    before: catalog([{ id: 'vendor/model-a' }]),
    after: catalog([{ id: 'vendor/model-a' }, { id: `vendor/${HOSTILE}` }]),
  }),
];
const feed = buildFeed(deriveEvents(changes), []);

/** The same items with the hostile string forced into every rendered field. */
const hostileFeed: FeedItem[] = feed.map((item) => ({
  ...item,
  sentence: `${item.sentence} ${HOSTILE}`,
  sourceId: `source ${HOSTILE}`,
  path: `raw/${HOSTILE}/response.json`,
}));

describe('the everything feed is well-formed XML', () => {
  it('has items, so this cannot pass by rendering an empty channel', () => {
    expect(feed.length).toBeGreaterThan(0);
    expect(renderEverythingFeed(feed)).toContain('<item>');
  });

  it('parses on ordinary input', () => {
    expect(() => assertWellFormed(renderEverythingFeed(feed))).not.toThrow();
  });

  it('parses when every interpolated field carries XML metacharacters', () => {
    expect(() => assertWellFormed(renderEverythingFeed(hostileFeed))).not.toThrow();
  });

  it('escapes the ampersand rather than emitting it raw', () => {
    const xml = renderEverythingFeed(hostileFeed);
    // No bare & except as the start of a character entity.
    expect(/&(?!(amp|lt|gt|quot|#0?39|apos);)/.test(xml)).toBe(false);
  });

  it('does not let a smuggled tag become an element', () => {
    expect(renderEverythingFeed(hostileFeed)).not.toContain('<tag>');
  });
});

describe('the changelog feed is well-formed XML', () => {
  const records = [
    record({
      subject: `capture ${HOSTILE}`,
      artifacts: [artifact({ sourceId: `src ${HOSTILE}`, path: `raw/${HOSTILE}/response.json` })],
    }),
  ];

  it('has an item, so this cannot pass by rendering an empty channel', () => {
    expect(renderFeed(records, 'https://example.test')).toContain('<item>');
  });

  it('parses when the commit subject and artifact path carry metacharacters', () => {
    expect(() => assertWellFormed(renderFeed(records, 'https://example.test'))).not.toThrow();
  });

  it('escapes the ampersand rather than emitting it raw', () => {
    const xml = renderFeed(records, 'https://example.test');
    expect(/&(?!(amp|lt|gt|quot|#0?39|apos);)/.test(xml)).toBe(false);
  });
});

describe('the well-formedness helper itself', () => {
  /**
   * The test above is only evidence if the helper actually rejects bad XML.
   * An assertion that cannot fail proves nothing about the thing it guards.
   */
  it('throws on XML that is not well-formed', () => {
    expect(() => assertWellFormed('<rss><channel><title>a & b</title></channel></rss>')).toThrow();
  });

  it('throws on an unclosed element', () => {
    expect(() => assertWellFormed('<rss><channel></rss>')).toThrow();
  });

  it('accepts XML that is well-formed', () => {
    expect(() => assertWellFormed('<rss><channel><title>a &amp; b</title></channel></rss>')).not.toThrow();
  });
});
