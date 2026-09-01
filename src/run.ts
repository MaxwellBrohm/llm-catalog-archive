import type { Source } from './config.js';
import type { FetchOutcome } from './fetch.js';
import { checkHealth } from './health.js';
import { buildSidecar, originDateMs } from './headers.js';
import { changedUnderPredicate } from './predicate.js';
import { shrinkVerdict } from './magnitude.js';
import { secretVerdict } from './secrets.js';
import {
  applyOutcome,
  exitCodeFor,
  shouldCommitStatus,
  type Outcome,
  type SourceStatus,
  type StatusFile,
} from './status.js';

export type RunDeps = {
  cwd: string;
  nowIso: () => string;
  fetchOne: (s: Source) => Promise<FetchOutcome>;
  readFile: (p: string) => Uint8Array | null;
  writeFile: (p: string, b: Uint8Array) => void;
  commitPaths: (paths: string[], message: string) => boolean;
  push: () => void;
  log: (line: string) => void;
  /**
   * Milliseconds elapsed, from a monotonic source. Optional: absent means no
   * deadline, which is what every unit test wants. src/cli.ts supplies it.
   */
  elapsedMs?: () => number;
  /**
   * How long the loop may spend fetching before it stops starting new sources
   * and goes to write its heartbeat. Absent means unbounded.
   *
   * THIS EXISTS BECAUSE THE JOB CAP IS NOT A BUDGET, IT IS A GUILLOTINE. The
   * daily tier's own worst case is 17 active sources times their timeout times
   * retries, which is 3,570 seconds, against a workflow timeout-minutes of 15.
   * A run that hits the cap is killed mid-loop, and because the status file is
   * written after the loop, it commits NOTHING: no heartbeat, no counters, no
   * captures it had already made. Measured on a clone with three sources
   * pointed at a blackhole and SIGTERM at 45 seconds: HEAD unchanged, the
   * status blob unchanged, the working tree clean.
   *
   * That is the exact failure the module's own header says must never happen,
   * because the run that must not skip its heartbeat is the run in which
   * everything is failing, and skipping it re-arms GitHub's 60-day
   * inactivity clock at the worst possible moment.
   */
  budgetMs?: number;
};

export type RunResult = { exitCode: number; status: StatusFile | null; trace: string[] };

/**
 * Consecutive failures before a tier's job exits non-zero, which is what sends
 * the email. Each job evaluates its OWN tier: a check that lived only in the
 * daily job would let a totally dead fast tier stay silent for 24 hours.
 *
 * Different numbers because the tiers count in different units. Eight fast runs
 * is two hours; three daily runs is three days.
 */
const THRESHOLD = { fast: 8, daily: 3 } as const;

const STATUS_PATH = 'meta/status.json';

const headersPathFor = (s: Source) => `raw/${s.id}/headers.json`;

/** What a run that never got a response can honestly say about a source. */
const unreachable = (): Outcome => ({
  health: 'failed',
  countsAsFailure: true,
  httpStatus: null,
  bytes: null,
  changed: false,
  originDate: null,
  held: null,
});

/**
 * The pipeline, in the one order it can have:
 *
 *   fetch -> health check -> change predicate -> write -> commit -> push
 *   -> evaluate counters -> exit code
 *
 * A response that fails the health check is never written and never committed,
 * so the last-good bytes on disk are never clobbered by a challenge page, a
 * soft 404 or a redirect stub. The health check reads the size of the stored
 * artifact to compute its band, which is why the stored bytes are loaded
 * before the verdict rather than after it; reading is not writing and the
 * order above still holds.
 *
 * The status file is written and committed at the END of the loop and BEFORE
 * the exit code is computed. That order is the point of the whole module.
 * GitHub disables a scheduled workflow after 60 days of repository inactivity,
 * so the run that must not skip its heartbeat commit is exactly the run in
 * which everything is failing. Evaluating counters first, or aborting on the
 * first exception, re-arms that clock at the worst possible moment.
 *
 * The change predicate, the credential gate and the magnitude guard all sit
 * between the health verdict and the write, in that order, and all three
 * withhold the write without clobbering what is already archived. They fail in
 * opposite directions on purpose. A predicate that cannot project is a
 * FAILURE, because "unchanged" is the answer that lets a broken extractor sit
 * silently on a live source for months. The other two are NOT failures: the
 * response was healthy and may well be correct, it is simply not something to
 * land unreviewed in a history R7 forbids rewriting, so the run records the
 * hold and exits zero.
 *
 * The credential gate is a hold rather than a failure for a reason worth
 * saying out loud. When a provider publishes their own API key in their own
 * docs, the source is working perfectly and the collector is working
 * perfectly. Nothing here can be fixed by retrying, and mailing an operator a
 * failure every day about it is how an alerting channel gets muted.
 */
export async function runTier(
  sources: Source[],
  tier: 'fast' | 'daily',
  prevStatus: StatusFile | null,
  deps: RunDeps,
): Promise<RunResult> {
  const now = deps.nowIso();
  const trace: string[] = [];

  // Seeded from the committed copy, so a fast run does not erase the daily
  // tier's entries and vice versa. Both tiers share one file.
  const nextSources: Record<string, SourceStatus> = { ...(prevStatus?.sources ?? {}) };

  for (const s of sources) {
    // The caller already filters on status, and this repeats it on purpose. A
    // pending source is one that would commit megabytes of non-content on
    // every run into a history R7 forbids rewriting. Two locks, because only
    // one of them is permanent.
    if (s.status !== 'active') {
      deps.log(`${s.id}: pending, skipped`);
      continue;
    }

    // Checked BEFORE starting a fetch, never during one: a source that has
    // begun is allowed to finish, so a capture is never half-written. Stopping
    // early costs this run the remaining sources; being killed costs it every
    // source AND the heartbeat.
    if (deps.budgetMs !== undefined && deps.elapsedMs !== undefined && deps.elapsedMs() >= deps.budgetMs) {
      const line = `budget of ${Math.round(deps.budgetMs / 1000)}s reached, stopping before ${s.id} to commit the heartbeat`;
      deps.log(line);
      trace.push(`budget:${s.id}`);
      break;
    }

    const prev = prevStatus?.sources[s.id];
    let outcome: Outcome;

    try {
      const got = await deps.fetchOne(s);
      if (!got.ok) {
        deps.log(`${s.id}: fetch failed after ${got.attempts} attempts: ${got.error}`);
        outcome = unreachable();
      } else {
        const stored = deps.readFile(s.path);

        const health = checkHealth(
          s,
          got.observed,
          // lastChangeAt lets the content-freshness guard ask how long the
          // STORED bytes have gone unchanged, which is the only form the
          // question takes for a source that carries no dates of its own.
          { bytes: stored === null ? null : stored.byteLength, lastChangeAt: prev?.lastChangeAt ?? null },
          Date.parse(now),
        );
        if (!health.writeAllowed) {
          // Not written, not committed. The bytes already in the archive are the
          // last ones that passed, and an error page served at 200 must not be
          // the thing that replaces them in a history R7 forbids rewriting.
          //
          // countsAsFailure comes from the verdict rather than from the state,
          // because `stale` also lands here and a quiet feed is good news. A
          // daily failure email about good news is how a channel gets muted.
          deps.log(`${s.id}: ${health.state}, not written: ${health.reason}`);
          trace.push(`${health.state}:${s.id}`);
          outcome = {
            health: health.state,
            countsAsFailure: health.countsAsFailure,
            httpStatus: got.observed.status,
            bytes: null,
            changed: false,
            originDate: null,
            held: null,
          };
        } else {
          if (health.state === 'relocated') {
            // Writable, and worth saying out loud: the bytes are good and it is
            // the url in meta/sources.json that has gone stale.
            deps.log(`${s.id}: relocated, ${health.reason}`);
          }

          const originMs = originDateMs(got.headers);
          const originIso = originMs === null ? null : new Date(originMs).toISOString();

          const verdict = changedUnderPredicate(s, got.observed.body, stored);
          // The credential gate runs first, and its answer wins. Both gates
          // withhold the write, so on a body that is both collapsed and
          // carrying a key the operator gets told the actionable one.
          const secret = verdict.ok && verdict.changed
            ? secretVerdict(got.observed.body)
            : ({ held: false } as const);
          const hold = secret.held
            ? secret
            : verdict.ok && verdict.changed
              ? shrinkVerdict(s, got.observed.body, stored)
              : ({ held: false } as const);

          if (!verdict.ok) {
            // Loud, and specifically not "unchanged". A projection that cannot
            // be computed is an extractor that has stopped describing its
            // source, and the quiet spelling of that is a live source that
            // reports no change for ever while it ships.
            deps.log(`${s.id}: predicate failed, not written: ${verdict.reason}`);
            trace.push(`predicate-failed:${s.id}`);
            outcome = {
              health: 'failed',
              countsAsFailure: true,
              httpStatus: got.observed.status,
              bytes: null,
              changed: false,
              originDate: originIso,
              held: null,
            };
          } else if (hold.held) {
            // Healthy, changed, and withheld. Not a failure and not a change:
            // nothing is written, so the archived bytes stay the last accepted
            // ones and the next run measures against those rather than against
            // a collapse nobody looked at.
            deps.log(`${s.id}: held for review, not written: ${hold.reason}`);
            trace.push(`held:${s.id}`);
            outcome = {
              health: health.state,
              countsAsFailure: false,
              httpStatus: got.observed.status,
              bytes: null,
              changed: false,
              originDate: originIso,
              held: { at: now, reason: hold.reason },
            };
          } else if (!verdict.changed) {
            outcome = {
              health: health.state,
              countsAsFailure: false,
              httpStatus: got.observed.status,
              bytes: got.observed.body.byteLength,
              changed: false,
              originDate: originIso,
              held: null,
            };
          } else {
            // Verbatim. The bytes written are the bytes received, always.
            deps.writeFile(s.path, got.observed.body);
            deps.writeFile(
              headersPathFor(s),
              new TextEncoder().encode(JSON.stringify(buildSidecar(got.headers), null, 2) + '\n'),
            );
            deps.commitPaths(
              [s.path, headersPathFor(s)],
              `${s.id}: changed (${got.observed.body.byteLength} bytes, HTTP ${got.observed.status})`,
            );
            trace.push(`changed:${s.id}`);
            deps.log(`${s.id}: changed, ${got.observed.body.byteLength} bytes`);
            outcome = {
              health: health.state,
              countsAsFailure: false,
              httpStatus: got.observed.status,
              bytes: got.observed.body.byteLength,
              changed: true,
              originDate: originIso,
              held: null,
            };
          }
        }
      }
    } catch (e) {
      // One unreachable source must never stop the other twelve, and must never
      // cost the run its heartbeat commit either.
      deps.log(`${s.id}: threw: ${String(e instanceof Error ? e.message : e)}`);
      outcome = unreachable();
    }

    nextSources[s.id] = applyOutcome(prev, outcome, now);
  }

  const nextStatus: StatusFile = { version: 1, updatedAt: now, sources: nextSources };

  // Before the push and before the exit code, unconditionally on a daily run.
  // The counter lives only in this file, because the runner is ephemeral: a run
  // that computes 2 and does not commit it hands the next run a 1.
  if (shouldCommitStatus(prevStatus, nextStatus, tier === 'daily')) {
    deps.writeFile(STATUS_PATH, new TextEncoder().encode(JSON.stringify(nextStatus, null, 2) + '\n'));
    deps.commitPaths(
      [STATUS_PATH],
      tier === 'daily' ? `status: daily heartbeat ${now.slice(0, 10)}` : 'status: source state changed',
    );
  }

  deps.push();

  const exitCode = exitCodeFor(
    nextStatus,
    sources.map((s) => s.id),
    THRESHOLD[tier],
  );
  return { exitCode, status: nextStatus, trace };
}
