/**
 * `collect --tier fast|daily`.
 *
 * FETCHING IS SERIAL, AND THE WORST CASE DOES NOT FIT THE JOB.
 *
 * An older version of this comment said "thirteen sources at a 60 second
 * timeout is under fifteen minutes in the worst case". All three numbers were
 * wrong: there are 17 daily-active sources, three of them above 60 seconds, and
 * it ignored retries entirely. Measured properly, the sum of
 * `timeoutS * (retries + 1)` over the daily tier is 3,570 seconds, which is
 * 59.5 minutes against a workflow `timeout-minutes: 15`. A single hung socket
 * costs 190 seconds on the shipped claude-llms-txt config.
 *
 * The everyday cost of that is zero, because sources answer in milliseconds.
 * The outage cost was total: a run killed at the cap commits NOTHING, losing
 * its heartbeat, its counters and every capture it had already made, which is
 * the one thing src/run.ts's header says must never happen.
 *
 * So the loop is given a budget below the job cap and stops starting new
 * sources when it runs out, falling through to the status write. Sources are
 * still serial and still polite; what changed is that running out of time is
 * now an ordinary end to the loop rather than a kill.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSources, activeSourcesForTier } from './config.js';
import { fetchSource } from './fetch.js';
import { runTier } from './run.js';
import { commitPaths, pushWithRebase } from './git.js';
import { parseStatusFile } from './status.js';

const cwd = process.cwd();
const i = process.argv.indexOf('--tier');
const tier = i === -1 ? undefined : process.argv[i + 1];
if (tier !== 'fast' && tier !== 'daily') {
  console.error('usage: collect --tier fast|daily');
  process.exit(2);
}

const readFile = (p: string): Uint8Array | null => {
  const abs = path.join(cwd, p);
  return fs.existsSync(abs) ? new Uint8Array(fs.readFileSync(abs)) : null;
};
const writeFile = (p: string, b: Uint8Array): void => {
  const abs = path.join(cwd, p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, b);
};

const file = loadSources(JSON.parse(fs.readFileSync(path.join(cwd, 'meta/sources.json'), 'utf8')));

/**
 * The committed counters. This read is the reason the counters exist: the
 * runner is ephemeral, so a failure count that is not read back from the
 * archive starts at zero on every run and the source never reaches its
 * threshold.
 *
 * An unreadable file is reported and treated as absent rather than thrown on. A
 * throw here kills the collector before it can commit anything, and no commits
 * is what starts GitHub's 60-day inactivity clock. Saying so out loud matters:
 * one rejection costs a counter reset and heals on the next daily write, while
 * a rejection on EVERY run is a counter pinned at zero forever and only this
 * line would show it.
 */
const rawStatus = readFile('meta/status.json');
const prevStatus = rawStatus === null ? null : parseStatusFile(new TextDecoder().decode(rawStatus));
if (rawStatus !== null && prevStatus === null) {
  console.log('meta/status.json is present but not readable as a status file; counters restart from zero this run');
}

/**
 * Eleven minutes against a `timeout-minutes: 15` job, leaving four for npm ci,
 * the checkout, the last in-flight fetch and the commit and push that follow
 * the loop. Both collector workflows use the same cap.
 */
const BUDGET_MS = 11 * 60 * 1000;
const startedAt = performance.now();

const result = await runTier(activeSourcesForTier(file, tier), tier, prevStatus, {
  cwd,
  nowIso: () => new Date().toISOString(),
  fetchOne: (s) => fetchSource(s, { userAgent: file.userAgent, nowIso: () => new Date().toISOString() }),
  readFile,
  writeFile,
  commitPaths: (paths, message) => commitPaths(cwd, paths, message),
  push: () => {
    if (process.env['LCA_NO_PUSH'] !== '1') pushWithRebase(cwd, process.env['LCA_BRANCH'] ?? 'main');
  },
  log: (l) => console.log(l),
  elapsedMs: () => Math.round(performance.now() - startedAt),
  budgetMs: BUDGET_MS,
});

process.exit(result.exitCode);
