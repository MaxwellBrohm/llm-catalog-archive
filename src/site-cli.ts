/**
 * `npm run build:site`. Regenerates docs/site/ from git history over raw/.
 *
 * Read-only against git. It never commits: the workflow decides whether the
 * regenerated output is worth a commit, because a generator that commits its
 * own output is a generator that can push a broken page into a history R7
 * forbids rewriting.
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildSite, writeSite } from './site/build.js';
import { readChangeRecords, readContentChanges } from './site/history.js';
import { SITE_URL } from './site/record.js';
import { parseRetractions } from './site/retractions.js';
import { loadSources } from './config.js';
import { eventsFromChange, type Tier } from './derive/events.js';
import { buildThreads } from './derive/threads.js';

const cwd = process.cwd();
const outDir = path.join(cwd, 'docs/site');

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

const events = readContentChanges(cwd, tierOf).flatMap(eventsFromChange);
const threads = buildThreads(events);

const files = buildSite(records, siteUrl, threads);
writeSite(outDir, files);

// A second .nojekyll, at docs/ rather than at docs/site/.
//
// GitHub Pages looks for it in the ROOT of whatever it publishes, and the
// branch source can publish the repository root or /docs and nothing else. With
// /docs as the source, the copy inside docs/site/ is just a file Jekyll would
// happily process past. docs/ also holds the specs, so leaving Jekyll on would
// have it render Markdown that is meant to be read as source.
fs.writeFileSync(path.join(cwd, 'docs/.nojekyll'), '');

const retracted = records.filter((r) => r.retraction !== null).length;
console.log(`site: ${records.length} changes, ${files.length} files, ${retractions.length} retraction(s) in the ledger, ${retracted} matched`);
console.log(
  `derive: ${events.length} events, ${threads.threads.length} threads, ${threads.held.length} held`,
);
