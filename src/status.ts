/**
 * The status store: per-source liveness, and the rule that decides when it is
 * written into the archive.
 *
 * Pure by construction. No filesystem, no process, no network, no git. The
 * runner is ephemeral and this module is the only thing that knows what a
 * counter means, so it has to be reasonable about state it never reads or
 * writes itself. `test/status.test.ts` asserts the import list rather than
 * trusting this paragraph.
 *
 * GitHub disables scheduled workflows after 60 days of repository inactivity.
 * Under commit-only-on-change a broken collector stops committing, which IS the
 * inactivity that triggers the disable, which makes the break permanent and
 * silent. Absence of commits otherwise means both "nothing changed" and "I am
 * dead", and this file exists to separate the two.
 */

import { z } from 'zod';
import type { HealthState } from './health.js';

export type Outcome = {
  health: HealthState;
  countsAsFailure: boolean;
  httpStatus: number | null;
  bytes: number | null;
  changed: boolean;
  originDate: string | null;
  held: { at: string; reason: string } | null;
};

export type SourceStatus = {
  /** Heartbeat only. Deliberately excluded from meaningfulFields. */
  lastAttemptAt: string;
  lastSuccessAt: string | null;
  lastChangeAt: string | null;
  consecutiveFailures: number;
  /** Hysteresis state, not a raw counter read. */
  failing: boolean;
  health: HealthState;
  httpStatus: number | null;
  bytes: number | null;
  originDate: string | null;
  held: { at: string; reason: string } | null;
};

export type StatusFile = { version: 1; updatedAt: string; sources: Record<string, SourceStatus> };

/** A source is FAILING at two consecutive failures, and OK on the first success. */
const FAILING_AT = 2;

export function applyOutcome(prev: SourceStatus | undefined, o: Outcome, nowIso: string): SourceStatus {
  const consecutiveFailures = o.countsAsFailure ? (prev?.consecutiveFailures ?? 0) + 1 : 0;
  return {
    lastAttemptAt: nowIso,
    lastSuccessAt: o.health === 'ok' || o.health === 'relocated' ? nowIso : (prev?.lastSuccessAt ?? null),
    lastChangeAt: o.changed ? nowIso : (prev?.lastChangeAt ?? null),
    consecutiveFailures,
    failing: consecutiveFailures >= FAILING_AT,
    health: o.health,
    httpStatus: o.httpStatus,
    bytes: o.bytes ?? (prev?.bytes ?? null),
    originDate: o.originDate ?? (prev?.originDate ?? null),
    /*
     * A HOLD IS DATED WHEN IT BEGAN, NOT WHEN IT WAS LAST OBSERVED.
     *
     * This used to be `o.held ?? null`, so every run restamped `at` with its own
     * clock and the field answered "when did we last notice this hold" while
     * being named, rendered and read as "when did this hold start". Measured on
     * the real archive: one unbroken xai-llms-txt hold with an identical reason
     * carried three different `at` values across four consecutive commits, and
     * src/liveness.ts renders that value as "held out of the archive since X".
     * A dead man's switch that reports a fresh date for a month-old hold is
     * worse than one that reports nothing.
     *
     * It also made the file churn. `held` is not in SELF_TICKING, so a moving
     * `at` is a meaningful-field change on every run, and a held fast-tier
     * source therefore committed meta/status.json 96 times a day forever. That
     * is the instruction against committing status.json every fast run, broken
     * by a field nobody thought of as a clock.
     *
     * Carried forward only while the REASON is unchanged. A hold for a new
     * reason is a new hold and gets the new instant, which is why this compares
     * the reason rather than merely checking that a hold existed.
     */
    held: o.held === null || o.held === undefined
      ? null
      : prev?.held != null && prev.held.reason === o.held.reason
        ? prev.held
        : o.held,
  };
}

/**
 * The clocks that advance on their own, whatever the source did.
 *
 * Any one of them left in the comparison below makes it trivially true on every
 * run, which is commit-every-run wearing a comparison's clothes. All three are
 * measured, not assumed:
 *
 *   lastAttemptAt  moves every run by construction. This is the heartbeat.
 *   lastSuccessAt  moves on every HEALTHY run, because every healthy run is a
 *                  success. Two identical runs of a working source differ in
 *                  this field and in nothing else.
 *   originDate     is Date minus Age, so it moves whenever the edge regenerates
 *                  rather than whenever the content changes. Measured on the
 *                  live archive: openai-llms-txt serves Age 0, so its origin is
 *                  its Date and ticks every single run, and openrouter-models,
 *                  the only fast-tier source, served Age 216 against a 300s TTL,
 *                  so at a 15 minute cadence it regenerates between every pair
 *                  of runs.
 *
 * Excluding them costs no change detection. A recovery moves `health`, the
 * counter and `failing`; a content change moves `bytes` and `lastChangeAt` and
 * commits a body anyway; a new cache generation carrying identical content is
 * not news. Their committed values are refreshed by the unconditional daily
 * commit, so they are at worst a day old, which is the staleness of the whole
 * file.
 */
const SELF_TICKING = ['lastAttemptAt', 'lastSuccessAt', 'originDate'] as const satisfies readonly (keyof SourceStatus)[];

/** Everything a decision reads, and nothing that ticks on its own. */
export function meaningfulFields(s: SourceStatus): unknown {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (!(SELF_TICKING as readonly string[]).includes(k)) out[k] = v;
  }
  return out;
}

/**
 * Commit whenever the meaningful fields differ from the committed copy, plus an
 * unconditional daily commit for liveness.
 *
 * Revision 1 of this design committed on transitions only, so the counter could
 * never pass 1: fail at 00:15 and commit 1; fail at 00:30, read 1, compute 2,
 * not a transition, nothing commits, and the 2 dies with the runner; 00:45
 * reads 1 again. During an outage the counter moves, so the content differs, so
 * this commits every run and the counter advances. In steady health nothing
 * meaningful moves and it commits once a day.
 */
export function shouldCommitStatus(prev: StatusFile | null, next: StatusFile, isDailyRun: boolean): boolean {
  if (isDailyRun) return true;
  if (prev === null) return true;

  const a = Object.keys(prev.sources).sort();
  const b = Object.keys(next.sources).sort();
  if (a.join(' ') !== b.join(' ')) return true;

  for (const id of b) {
    if (JSON.stringify(meaningfulFields(prev.sources[id]!)) !== JSON.stringify(meaningfulFields(next.sources[id]!))) {
      return true;
    }
  }
  return false;
}

/**
 * Each job evaluates its OWN tier. Putting the check only in the daily job
 * meant a totally dead fast tier produced no email for up to 24 hours.
 */
export function exitCodeFor(f: StatusFile, ids: string[], threshold: number): number {
  for (const id of ids) {
    const s = f.sources[id];
    if (s && s.consecutiveFailures >= threshold) return 1;
  }
  return 0;
}

const SourceStatusSchema = z.strictObject({
  lastAttemptAt: z.string(),
  lastSuccessAt: z.string().nullable(),
  lastChangeAt: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  failing: z.boolean(),
  health: z.enum(['ok', 'relocated', 'failed', 'stale']),
  httpStatus: z.number().int().nullable(),
  bytes: z.number().int().nullable(),
  originDate: z.string().nullable(),
  held: z.strictObject({ at: z.string(), reason: z.string() }).nullable(),
});

const StatusFileSchema = z.strictObject({
  version: z.literal(1),
  updatedAt: z.string(),
  sources: z.record(z.string(), SourceStatusSchema),
});

/**
 * The committed status file, or null when there is not a usable one.
 *
 * Null rather than a throw, and null rather than a partial salvage. This is
 * read at the top of every run, so a `JSON.parse` that throws is a collector
 * that dies before it can commit anything, which is precisely the silent death
 * the 60-day defence exists to prevent. A half-salvaged file is worse than
 * none: a `consecutiveFailures` that arrived as a string would produce NaN
 * counters and land them in a public archive that R7 forbids rewriting.
 *
 * Strict on the shape, so the cost of a rejection is bounded and self-healing:
 * the run that rejects a file rewrites it in the current shape, and the
 * counters restart from zero exactly once. The caller must say so out loud,
 * because a file rejected on EVERY run is a counter pinned at zero forever.
 */
export function parseStatusFile(text: string): StatusFile | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = StatusFileSchema.safeParse(json);
  return parsed.success ? (parsed.data as StatusFile) : null;
}
