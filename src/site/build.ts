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

export type SiteFile = { path: string; contents: string };

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
    { path: CHANGELOG_INDEX_PATH, contents: renderChangelogPage(records) },
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

  return files;
}

export function writeSite(outDir: string, files: SiteFile[]): void {
  for (const f of files) {
    const abs = path.join(outDir, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.contents);
  }
}
