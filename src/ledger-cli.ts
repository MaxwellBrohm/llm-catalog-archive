/**
 * `ledger`: append what the archive has learned about its own predictions.
 *
 * THE ONLY WRITER THE ACCURACY LEDGER HAS EVER HAD. meta/leaks-ledger.jsonl was
 * built, tested and append-only from day one, and it held zero lines, because a
 * ledger claim is a PREDICTION and the copy rule forbids the derivation from
 * predicting. See src/derive/expiry-ledger.ts for the one prediction that is
 * already in the bytes and therefore scoreable without a guess.
 *
 * RUN BY THE DAILY COLLECTOR, NOT BY THE SITE BUILD. The site build is a pure
 * function that commits nothing, by design; the collector is the process that
 * already owns writing and committing. Putting the append here also means the
 * ledger only ever gains lines on a run that actually fetched, so a build
 * replayed over an unchanged archive cannot manufacture a resolution.
 *
 * IT ONLY EVER APPENDS. Not as a convention: expiryLedgerLines is given what the
 * file already holds and refuses to emit a claim or a resolution twice, and the
 * write below is an append with no read-modify-write anywhere. The workflow in
 * .github/workflows/append-only.yml fails any diff that removes or edits a line,
 * and tools/append-only.sh is executed by the suite.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readContentChanges } from './site/history.js';
import { artifactPermalink } from './site/record.js';
import { parseLedger } from './site/ledger.js';
import { loadSources } from './config.js';
import { deriveEvents, type Tier } from './derive/events.js';
import { buildFeed } from './derive/feed.js';
import { expiryLedgerLines, renderLedgerLines } from './derive/expiry-ledger.js';
import { commitPaths, pushWithRebase } from './git.js';

const cwd = process.cwd();
const LEDGER = 'meta/leaks-ledger.jsonl';
const CATALOG_BODY = 'raw/openrouter-models/response.json';
const CATALOG_HEADERS = 'raw/openrouter-models/headers.json';

const sourcesPath = path.join(cwd, 'meta/sources.json');
const tiers = new Map<string, Tier>(
  fs.existsSync(sourcesPath)
    ? loadSources(JSON.parse(fs.readFileSync(sourcesPath, 'utf8'))).sources.map((s) => [s.id, s.tier])
    : [],
);

const feed = buildFeed(deriveEvents(readContentChanges(cwd, (id) => tiers.get(id) ?? 'daily')), []);

/**
 * The newest accepted catalogue capture. Absent means there is nothing to
 * resolve against, and resolving against a guess is worse than not resolving.
 */
const bodyPath = path.join(cwd, CATALOG_BODY);
const headersPath = path.join(cwd, CATALOG_HEADERS);
if (!fs.existsSync(bodyPath) || !fs.existsSync(headersPath)) {
  console.log('no catalogue capture stored; nothing to score');
  process.exit(0);
}

const catalogJson = JSON.parse(fs.readFileSync(bodyPath, 'utf8')) as { data?: { id?: unknown }[] };
const ids = new Set<string>(
  (catalogJson.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string'),
);
const headers = JSON.parse(fs.readFileSync(headersPath, 'utf8')) as Record<string, string | null>;
// origin_date is when the PROVIDER generated the bytes; observed_at is when we
// saw them. The later of the two is not the question: what matters is that the
// capture is genuinely after the expiry day, and origin_date is the earlier and
// therefore the safer of the two to judge that on.
const observedAt = headers['origin_date'] ?? headers['observed_at'] ?? null;
if (observedAt === null) {
  console.log('the stored catalogue capture carries no instant; refusing to score against it');
  process.exit(0);
}
const stamp = `${observedAt} (${headers['origin_date'] === null || headers['origin_date'] === undefined ? 'observed_at' : 'origin_date'})`;

const ledgerPath = path.join(cwd, LEDGER);
const existingText = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : '';
const existing = parseLedger(existingText);
const claimIds = new Set(existing.map((c) => c.id));
const resolvedIds = new Set(existing.filter((c) => c.outcome !== 'open').map((c) => c.id));

const today = new Date().toISOString().slice(0, 10);
const lines = expiryLedgerLines(feed, { ids, stamp, observedAt }, today, { claimIds, resolvedIds }, (item) =>
  artifactPermalink(item.sha, item.path),
);

if (lines.length === 0) {
  console.log('ledger: nothing new to record');
  process.exit(0);
}

for (const l of lines) {
  console.log(l.kind === 'claim' ? `claim   ${l.id}` : `resolve ${l.claim_id} -> ${l.outcome}`);
}

// APPEND. Never a read-modify-write: the existing bytes are not rewritten, so
// there is no path here that can lose or edit a line.
fs.appendFileSync(ledgerPath, renderLedgerLines(lines));

// Parsed back before committing. A malformed line stops the SITE build, and a
// build that stops is a site that stops deploying, so the failure is worth
// catching in the process that wrote it rather than in the one that reads it.
parseLedger(fs.readFileSync(ledgerPath, 'utf8'));

const claims = lines.filter((l) => l.kind === 'claim').length;
const resolutions = lines.length - claims;
commitPaths(cwd, [LEDGER], `ledger: ${claims} claim(s), ${resolutions} resolution(s)`);
if (process.env['LCA_NO_PUSH'] !== '1') pushWithRebase(cwd, process.env['LCA_BRANCH'] ?? 'main');
