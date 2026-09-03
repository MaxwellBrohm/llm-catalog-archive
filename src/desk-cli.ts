/**
 * `npm run desk`. Builds the posting queue and prints it as JSON.
 *
 * Read-only, like the site generator: it touches git through the same history
 * reader, writes nothing, and posts nothing. The scheduled routine runs this,
 * pushes the JSON to the review desk, and does not get to decide anything.
 *
 * Separating "decide what is worth posting" from "post it" is deliberate. This
 * command is the only place the decision is made, it is a pure function of the
 * archive plus the ledger, and it can be run by hand at any time to see exactly
 * what the routine would have offered.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readContentChanges } from './site/history.js';
import { isShallow } from './git.js';
import { SITE_URL } from './site/record.js';
import { loadSources } from './config.js';
import { deriveEvents, type Tier } from './derive/events.js';
import { deriveLeaks } from './derive/leaks.js';
import { buildFeed } from './derive/feed.js';
import { buildQueue } from './desk/queue.js';
import { parsePosted } from './desk/ledger.js';
import { POST_FLOOR_BITS } from './desk/surprise.js';

const cwd = process.cwd();
const siteUrl = process.env['LCA_SITE_URL'] ?? SITE_URL;

const sourcesPath = path.join(cwd, 'meta/sources.json');
const tiers = new Map<string, Tier>(
  fs.existsSync(sourcesPath)
    ? loadSources(JSON.parse(fs.readFileSync(sourcesPath, 'utf8'))).sources.map((s) => [s.id, s.tier])
    : [],
);
// REFUSE A TRUNCATED ARCHIVE. See isShallow: the score of every candidate is
// computed from the distribution of event types over the whole history, so a
// shallow clone silently produces a confident ranking of the wrong thing. It is
// a one-line fix at the call site and an unfindable bug if it is not checked
// here, because the output looks entirely normal.
if (isShallow(cwd)) {
  throw new Error(
    'this is a shallow clone, so the archive it can see is truncated and every score would be computed over the wrong distribution; run `git fetch --unshallow` first',
  );
}

const contentChanges = readContentChanges(cwd, (id: string) => tiers.get(id) ?? 'daily');
const feed = buildFeed(deriveEvents(contentChanges), deriveLeaks(contentChanges));

// Absent is empty and that is correct here, unlike the retraction ledger: on
// the first run nothing has been posted, and a routine that refused to start
// until someone created an empty file would be ceremony. It is created by the
// first successful post.
const postedPath = path.join(cwd, 'meta/posted.jsonl');
const posted = fs.existsSync(postedPath) ? parsePosted(fs.readFileSync(postedPath, 'utf8')) : [];

const floor = Number(process.env['LCA_POST_FLOOR'] ?? POST_FLOOR_BITS);
const queue = buildQueue(feed, posted, new Date(), siteUrl, floor);

console.log(
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      floor_bits: floor,
      funnel: queue.funnel,
      candidates: queue.candidates.map((c) => ({
        id: c.item.id,
        type: c.item.type,
        sentence: c.item.sentence,
        source: c.item.sourceId,
        stamp: c.item.stamp,
        bits: Number(c.score.bits.toFixed(2)),
        why: c.score.components.map((k) => `${k.label}: ${k.bits >= 0 ? '+' : ''}${k.bits.toFixed(2)} bits`),
        entities: c.entities,
        facts: c.item.facts,
        drafts: c.drafts,
        shortfalls: c.shortfalls,
      })),
    },
    null,
    2,
  ),
);
