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
import { readChangeRecords } from './site/history.js';
import { SITE_URL } from './site/record.js';
import { parseRetractions } from './site/retractions.js';

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
const files = buildSite(records, siteUrl);
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
