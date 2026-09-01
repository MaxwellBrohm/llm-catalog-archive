/**
 * Records to files. Pure: buildSite returns the bytes, it does not write them.
 * writeSite is the only function here that touches a disk.
 */

import fs from 'node:fs';
import path from 'node:path';
import { STYLESHEET } from './css.js';
import { WALL_JS } from './wall-js.js';
import { WALL_JS_PATH } from './wall.js';
import {
  labPagePath,
  renderAboutPage,
  renderApiPage,
  exampleModelId,
  renderChangePage,
  renderChangelogPage,
  renderEverythingFeed,
  renderEverythingPage,
  renderFeed,
  renderLabPage,
  renderLeaksPage,
  TYPE_LABEL,
  LEAKS_FEED_PATH,
  typeFeedPath,
  renderLedgerPage,
  renderRedirect,
  renderSourcePage,
  renderThreadPage,
  renderThreadsIndex,
  renderTypePage,
  threadPagePath,
  typePagePath,
  ABOUT_PATH,
  API_PATH,
  CHANGELOG_INDEX_PATH,
  EVERYTHING_FEED_PATH,
  LEAKS_INDEX_PATH,
  LEDGER_PATH,
  THREADS_INDEX_PATH,
} from './render.js';
import {
  changePagePath,
  legacyPagePath,
  legacyRedirectTarget,
  SITE_URL,
  sortByStampDesc,
  sourcePagePath,
  type ChangeRecord,
} from './record.js';
import { ALL_TYPES, labsInFeed, type FeedItem } from '../derive/feed.js';
import type { ThreadSet } from '../derive/threads.js';
import type { LeakItem, LeakRefusal } from '../derive/leaks.js';
import type { LedgerClaim } from './ledger.js';

/**
 * `contents` is bytes OR text. It was text only until the fonts were vendored:
 * a woff2 read as a utf8 string and written back is corrupt, so the type has to
 * admit binary rather than the writer guessing an encoding.
 */
export type SiteFile = { path: string; contents: string | Uint8Array };

/**
 * Ordering happens HERE, once, so every page and the feed agree. The renderers
 * take the order they are given and the source pages read `records[0]` as the
 * latest change, so a caller that sorted differently for one page would leave
 * the feed disagreeing with the index about what the newest change is.
 *
 * `.nojekyll` is emitted because GitHub Pages otherwise runs Jekyll over what
 * it publishes, and Jekyll drops files and directories whose names begin with
 * an underscore. Nothing here is named that way today, which is exactly why the
 * file has to be emitted now rather than after something is. The output
 * directory IS the deployed root, so this one copy is the copy Pages looks at.
 */
export function buildSite(
  input: ChangeRecord[],
  siteUrl: string = SITE_URL,
  threads: ThreadSet = { threads: [], held: [] },
  leaks: LeakItem[] = [],
  ledger: LedgerClaim[] = [],
  feed: FeedItem[] = [],
  refusals: LeakRefusal[] = [],
): SiteFile[] {
  const records = sortByStampDesc(input);
  // The documentation's worked examples are written against a model that
  // actually has a thread, chosen here rather than typed into the page. See
  // exampleModelId. Null only when the archive holds no model thread at all,
  // in which case the examples fall back and the API page test catches it.
  const apiExampleId = exampleModelId(threads.threads);

  const files: SiteFile[] = [
    { path: '.nojekyll', contents: '' },
    { path: 'style.css', contents: STYLESHEET },
    // The front door's browser module. Emitted unconditionally, next to the
    // stylesheet, because it is an asset of the same kind: index.html asks for
    // it by a fixed name, and a name that resolves on some builds and 404s on
    // others is the failure mode this file exists to not have.
    { path: WALL_JS_PATH, contents: WALL_JS },
    // The front page is EVERYTHING, and the changelog moved one directory down
    // rather than staying here. index.html is a front door and not a permalink;
    // every permalinked page in the publication, which is every change page,
    // source page and thread page, is at the address it always was.
    { path: 'index.html', contents: renderEverythingPage(feed, threads) },
    { path: EVERYTHING_FEED_PATH, contents: renderEverythingFeed(feed, siteUrl) },
    { path: ABOUT_PATH, contents: renderAboutPage() },
    // The API's own documentation page. It takes siteUrl because every curl
    // example on it is written against the real base URL: an example a reader
    // has to edit before it runs is an example nobody has run.
    { path: API_PATH, contents: renderApiPage(siteUrl, undefined, undefined, apiExampleId) },
    { path: CHANGELOG_INDEX_PATH, contents: renderChangelogPage(records, feed) },
    // feed.xml is UNCHANGED and still one item per artifact change. Repointing
    // it at the new stream would silently replace every existing subscriber's
    // feed with a different publication, so the new stream got a new address.
    { path: 'feed.xml', contents: renderFeed(records, siteUrl) },
  ];

  // Every micro-category gets a page whether or not it holds anything, for the
  // same reason the desk keeps an empty signal heading: a category that
  // disappeared when it was empty would make a quiet week and a broken
  // extractor render identically. A lab page is emitted only where the archive
  // actually carries that lab, because an empty lab page is a claim to be
  // watching a lab we have nothing on.
  for (const type of ALL_TYPES) {
    files.push({ path: typePagePath(type), contents: renderTypePage(type, feed) });
    // One feed per micro-category, beside its page. Emitted even when empty,
    // for the same reason the page is: a feed that appeared only once a
    // category had items would make a quiet week and a broken extractor look
    // identical to anyone subscribed.
    files.push({
      path: typeFeedPath(type),
      contents: renderEverythingFeed(
        feed.filter((i) => i.type === type),
        siteUrl,
        {
          title: `llm-catalog-archive: ${type}`,
          path: typeFeedPath(type),
          description: `${TYPE_LABEL[type]}. Every item of this kind, newest first.`,
        },
      ),
    });
  }
  for (const lab of labsInFeed(feed)) {
    files.push({ path: labPagePath(lab), contents: renderLabPage(lab, feed) });
  }

  for (const record of records) {
    files.push({ path: changePagePath(record.sha), contents: renderChangePage(record) });
  }

  const sourceIds = [...new Set(records.flatMap((r) => r.artifacts.map((a) => a.sourceId)))].sort();
  for (const id of sourceIds) {
    files.push({ path: sourcePagePath(id), contents: renderSourcePage(id, records) });
  }

  // The threads layer, over the same commits. The per-commit pages above are
  // not replaced by it: they are the evidence every claim on a thread links
  // back to, and a thread with no resolvable evidence under it is an opinion.
  files.push({ path: THREADS_INDEX_PATH, contents: renderThreadsIndex(threads) });
  for (const thread of threads.threads) {
    files.push({ path: threadPagePath(thread.slug), contents: renderThreadPage(thread) });
  }

  // The leaks desk and its ledger. Emitted unconditionally, empty or not: a
  // page that disappears when it has nothing on it makes "no reveals this week"
  // and "the extractor broke" render identically, and the second is the failure
  // this project exists not to hide.
  files.push({ path: LEAKS_INDEX_PATH, contents: renderLeaksPage(leaks, ledger, refusals) });
  // The desk's own feed. Following rumors and leaks used to mean subscribing to
  // everything and filtering by hand in a reader.
  files.push({
    path: LEAKS_FEED_PATH,
    contents: renderEverythingFeed(
      feed.filter((i) => i.kind === 'leak'),
      siteUrl,
      {
        title: 'llm-catalog-archive: rumors and leaks',
        path: LEAKS_FEED_PATH,
        description:
          'The leaks desk. Every line describes a stored artifact and is linked at the commit that stored it. The sourcing tier is about the artifact, not about confidence.',
      },
    ),
  });
  files.push({ path: LEDGER_PATH, contents: renderLedgerPage(ledger, leaks.length) });

  // The old address of every page, forwarding to the new one.
  //
  // The site moved up one directory when Pages stopped publishing it out of
  // docs/ on a branch, and spec section 10 makes a change page's URL a
  // permalink. A single stub at site/index.html would answer the front door and
  // leave every permalink under it dead, so the mirror is per page. Only HTML
  // is mirrored: a meta refresh inside feed.xml would be malformed RSS rather
  // than a redirect, and a stub served as style.css is not a stylesheet.
  for (const f of [...files]) {
    if (!f.path.endsWith('.html')) continue;
    files.push({ path: legacyPagePath(f.path), contents: renderRedirect(legacyRedirectTarget(f.path)) });
  }

  // Last, so the sitemap lists every page the build actually emitted rather
  // than a list maintained beside it that can fall behind.
  files.push(...indexFiles(files, siteUrl));

  return files;
}

/**
 * A file's contents as text, refusing rather than coercing when it is binary.
 * Every JSON and HTML product of the generator is text; the vendored typefaces
 * are not, and a test that silently stringified one would assert on mojibake.
 */
export function textContents(file: SiteFile): string {
  if (typeof file.contents !== 'string') {
    throw new Error(`${file.path} holds bytes, not text`);
  }
  return file.contents;
}

/**
 * robots.txt and sitemap.xml, built from the page list this generator already
 * walked rather than from a crawl.
 *
 * The robots half is close to inert on its own: an absent robots.txt already
 * permits everything, so this exists to POINT AT THE SITEMAP, which is the part
 * that carries information. The archive is densely interlinked, so a crawler
 * finds most of it anyway; what a sitemap adds is the pages that are reachable
 * only through a capped list, which is every thread past the twelfth.
 *
 * Redirect stubs are excluded. They carry a meta refresh to their real address,
 * and listing both spellings of one page is how a sitemap teaches a crawler
 * that a site has twice as many pages as it does.
 */
export function indexFiles(pages: readonly SiteFile[], siteUrl: string): SiteFile[] {
  const urls = pages
    .filter((f) => f.path.endsWith('.html') && !f.path.startsWith('site/'))
    .map((f) => f.path)
    .sort();

  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((p) => `<url><loc>${escapeXml(`${siteUrl}/${p}`)}</loc></url>`),
    '</urlset>',
    '',
  ].join('\n');

  const robots = [
    '# The whole archive is public and every page is meant to be read.',
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${siteUrl}/sitemap.xml`,
    '',
  ].join('\n');

  return [
    { path: 'robots.txt', contents: robots },
    { path: 'sitemap.xml', contents: sitemap },
  ];
}

/** The five XML metacharacters. A path can carry an ampersand. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function writeSite(outDir: string, files: SiteFile[]): void {
  for (const f of files) {
    const abs = path.join(outDir, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.contents);
  }
}
