/**
 * `npm run build:site`. Regenerates build/site/ from git history over raw/.
 *
 * Read-only against git, and it never commits, because the output is never
 * committed at all. The site is a pure function of the history under raw/, so
 * storing it in that history added a second copy of the same facts and made
 * every push collide on 156 regenerated files. .github/workflows/pages.yml
 * runs this at deploy time and uploads build/site/ as the Pages artifact.
 *
 * build/ is gitignored. Nothing in this file writes outside it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildSite, writeSite } from './site/build.js';
import { vendorFiles } from './site/vendor.js';
import { buildApi } from './api/build.js';
import { readChangeRecords, readContentChanges } from './site/history.js';
import { SITE_URL } from './site/record.js';
import { parseRetractions } from './site/retractions.js';
import { parseLedger } from './site/ledger.js';
import { deriveLeakRefusals, deriveLeaks } from './derive/leaks.js';
import { loadSources } from './config.js';
import { deriveEvents, precisionBySource, type Tier } from './derive/events.js';
import { buildThreads } from './derive/threads.js';
import { buildFeed } from './derive/feed.js';

const cwd = process.cwd();
/**
 * Gitignored on purpose: see the header. Overridable so a caller can build a
 * copy somewhere else without disturbing the one the deploy uploads.
 */
const outDir = path.resolve(cwd, process.env['LCA_SITE_OUT'] ?? 'build/site');

/**
 * The absolute base the feed's links are built from. Overridable because it is
 * the one thing in the generator that depends on how the repository's Pages
 * source is configured, which is a repository setting and not code.
 */
const siteUrl = process.env['LCA_SITE_URL'] ?? SITE_URL;

const ledger = path.join(cwd, 'meta/retractions.jsonl');
// Absent is not the same as empty and is not tolerated: the ledger is created
// in A1 and the append-only workflow already fails when it goes missing. A
// generator that shrugged at a missing ledger would publish every retracted
// change unmarked.
if (!fs.existsSync(ledger)) throw new Error('meta/retractions.jsonl is missing; refusing to build a site that cannot mark retractions');
const retractions = parseRetractions(fs.readFileSync(ledger, 'utf8'));

const records = readChangeRecords(cwd, retractions);

// The tier decides an event's first-seen precision, and the precision decides
// whether a date may render at all (spec section 10.1). It is read from the
// same meta/sources.json the collector runs from, so a source moved between
// tiers moves its events' precision with it.
//
// Absent, or absent from the file, defaults to `daily`, and that is NOT the
// same shrug the ledger above refuses. Daily precision is wider than a day, so
// the default renders fewer dates rather than more: it can cost a reader a
// date they were entitled to, and it cannot produce a date the archive has not
// earned. A missing ledger is the opposite, publishing a retracted change
// unmarked, which is why that one stops the build and this one does not.
const sourcesPath = path.join(cwd, 'meta/sources.json');
const tiers = new Map<string, Tier>(
  fs.existsSync(sourcesPath)
    ? loadSources(JSON.parse(fs.readFileSync(sourcesPath, 'utf8'))).sources.map((s) => [s.id, s.tier])
    : [],
);
const tierOf = (sourceId: string): Tier => tiers.get(sourceId) ?? 'daily';

const contentChanges = readContentChanges(cwd, tierOf);
const events = deriveEvents(contentChanges);

// The accuracy ledger. Absent is not tolerated for the same reason the
// retraction ledger is not: it is created empty and append-only from the day
// the desk ships, and a desk that publishes a scorecard it could not read would
// be publishing an accuracy of "no claims" over claims it simply failed to
// open.
const ledgerPath = path.join(cwd, 'meta/leaks-ledger.jsonl');
if (!fs.existsSync(ledgerPath)) throw new Error('meta/leaks-ledger.jsonl is missing; refusing to build a leaks desk with no accuracy ledger behind it');
const claims = parseLedger(fs.readFileSync(ledgerPath, 'utf8'));

const leaks = deriveLeaks(contentChanges);
const refusals = deriveLeakRefusals(contentChanges);

// ONE STREAM OVER BOTH DERIVATIONS, and the threads are built over it rather
// than over the events alone. Product spec section 4: a codename leak in
// August, the launch in October and the price change in December are one
// thread, so a threads layer that only ever saw events would file two of those
// three together and leave the third on a page of its own.
const feed = buildFeed(events, leaks);
const threads = buildThreads(feed);

const files = buildSite(records, siteUrl, threads, leaks, claims, feed, refusals);

// The static JSON API, generated at deploy time alongside the site and served
// off the same Pages deployment. It is a second projection of the SAME derived
// stream the HTML pages are built from, not a second derivation: the sentences
// are copied and the records carry the same artifact permalinks, so the API and
// the site cannot disagree about what the archive holds.
const apiFiles = buildApi({ feed, threads, refusals, ledger: claims, changes: contentChanges, siteUrl });

// three.js, read off disk rather than generated. See src/site/vendor.ts for why
// it is copied instead of linked, why a missing copy stops the build, and why
// it takes no cwd: three belongs to this generator, not to the archive the
// generator is pointed at, and those are only the same directory on the deploy.
const vendor = vendorFiles();

writeSite(outDir, [...files, ...apiFiles, ...vendor]);

// There is deliberately no second .nojekyll written outside outDir. Pages looks
// for it in the ROOT of what it publishes, and what it publishes is now the
// uploaded artifact whose root IS outDir, where buildSite already emits one.

const retracted = records.filter((r) => r.retraction !== null).length;
console.log(`site: ${records.length} changes, ${files.length} files, ${retractions.length} retraction(s) in the ledger, ${retracted} matched`);
console.log(
  `derive: ${events.length} events, ${threads.threads.length} threads, ${threads.held.length} held`,
);
console.log(`api: ${apiFiles.length} files under api/v1/`);
console.log(`vendor: ${vendor.length} file(s), ${vendor.reduce((n, f) => n + f.contents.length, 0)} bytes`);
// Per type, because one total hides the case that matters: a signal that has
// silently stopped producing while the others carry the number.
const byType = new Map<string, number>();
for (const l of leaks) byType.set(l.type, (byType.get(l.type) ?? 0) + 1);
console.log(
  `leaks: ${leaks.length} items (${[...byType].sort().map(([t, n]) => `${t} ${n}`).join(', ') || 'none'}), ${claims.length} ledger claim(s), ${refusals.length} refusal(s)`,
);
// A refusal is a statement about this repository's own parser, so it is printed
// in full rather than counted. A count of refusals nobody reads is the silent
// failure the refusal exists to make loud.
for (const r of refusals) console.log(`refused: ${r.sourceId} at ${r.sha.slice(0, 7)}: ${r.reason}`);
// The measured first-seen error per source, printed because it is a published
// claim and a number nobody looks at is a number nobody notices going wrong.
for (const [sourceId, seconds] of [...precisionBySource(contentChanges)].sort()) {
  const shown = Number.isFinite(seconds) ? `${seconds}s` : 'unbounded (one capture)';
  console.log(`precision: ${sourceId} ${shown}`);
}
