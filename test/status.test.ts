import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  applyOutcome,
  meaningfulFields,
  parseStatusFile,
  shouldCommitStatus,
  exitCodeFor,
  type StatusFile,
  type SourceStatus,
  type Outcome,
} from '../src/status.js';

/** Fifteen minutes apart, which is the fast tier's real cadence. */
const T = (n: number) => new Date(Date.parse('2026-08-26T00:00:00Z') + n * 900000).toISOString();

const okOutcome = {
  health: 'ok' as const,
  countsAsFailure: false,
  httpStatus: 200,
  bytes: 100,
  changed: false,
  originDate: null,
  held: null,
};
const failOutcome = { ...okOutcome, health: 'failed' as const, countsAsFailure: true, httpStatus: 503, bytes: null };
const staleOutcome = { ...okOutcome, health: 'stale' as const, countsAsFailure: false };

const file = (sources: Record<string, SourceStatus>): StatusFile => ({ version: 1, updatedAt: T(0), sources });

/** n consecutive failures, each one a separate run. */
function afterFailures(n: number): SourceStatus {
  let s: SourceStatus | undefined;
  for (let i = 0; i < n; i++) s = applyOutcome(s, failOutcome, T(i));
  return s!;
}

describe('applyOutcome', () => {
  it('counts two consecutive failures as two', () => {
    expect(afterFailures(2).consecutiveFailures).toBe(2);
  });

  it('resets the counter on success', () => {
    expect(applyOutcome(afterFailures(2), okOutcome, T(2)).consecutiveFailures).toBe(0);
  });

  it('a stale verdict does not advance the failure counter', () => {
    expect(applyOutcome(undefined, staleOutcome, T(0)).consecutiveFailures).toBe(0);
  });

  // Stale must survive as its own state and not be laundered into ok. An
  // operator reading the file decides "is anything broken" off this word.
  it('records a stale verdict as stale', () => {
    expect(applyOutcome(undefined, staleOutcome, T(0)).health).toBe('stale');
  });

  /**
   * Stale clears a standing count, because a stale verdict means the fetch
   * itself succeeded and the provider is merely quiet. The counter answers "is
   * this source reachable", not "did it have news", and only a `failed` verdict
   * is evidence against reachability.
   */
  it('a stale verdict clears a failure count already standing', () => {
    expect(applyOutcome(afterFailures(3), staleOutcome, T(3)).consecutiveFailures).toBe(0);
  });

  it('a hold does not advance the failure counter', () => {
    expect(
      applyOutcome(undefined, { ...okOutcome, held: { at: T(0), reason: 'would remove 91.0 pct of units' } }, T(0))
        .consecutiveFailures,
    ).toBe(0);
  });

  it('records why a hold was taken', () => {
    const s = applyOutcome(undefined, { ...okOutcome, held: { at: T(0), reason: 'would remove 91.0 pct of units' } }, T(0));
    expect(s.held?.reason).toBe('would remove 91.0 pct of units');
  });

  it('is not failing at one consecutive failure', () => {
    expect(afterFailures(1).failing).toBe(false);
  });

  it('becomes failing at two consecutive failures', () => {
    expect(afterFailures(2).failing).toBe(true);
  });

  it('recovers on the first success, without waiting for a second', () => {
    expect(applyOutcome(afterFailures(2), okOutcome, T(2)).failing).toBe(false);
  });

  it('stamps the success clock on a success', () => {
    expect(applyOutcome(undefined, okOutcome, T(3)).lastSuccessAt).toBe(T(3));
  });

  // A relocation is a good body served from a url the config has wrong, so it
  // is a success for liveness purposes.
  it('stamps the success clock on a relocation', () => {
    expect(applyOutcome(undefined, { ...okOutcome, health: 'relocated' }, T(3)).lastSuccessAt).toBe(T(3));
  });

  it('keeps the previous success clock through a failure rather than clearing it', () => {
    const ok = applyOutcome(undefined, okOutcome, T(3));
    expect(applyOutcome(ok, failOutcome, T(4)).lastSuccessAt).toBe(T(3));
  });

  it('stamps the change clock only when the content changed', () => {
    expect(applyOutcome(undefined, { ...okOutcome, changed: true }, T(5)).lastChangeAt).toBe(T(5));
  });

  it('leaves the change clock alone on a run that changed nothing', () => {
    const changed = applyOutcome(undefined, { ...okOutcome, changed: true }, T(5));
    expect(applyOutcome(changed, okOutcome, T(6)).lastChangeAt).toBe(T(5));
  });

  // A failed fetch reports no byte count. Overwriting the last known size with
  // null would make the size band's own history unreadable.
  it('keeps the last known byte count through a failure that reports none', () => {
    expect(applyOutcome(applyOutcome(undefined, okOutcome, T(0)), failOutcome, T(1)).bytes).toBe(100);
  });

  it('moves the heartbeat on every run, successful or not', () => {
    expect(applyOutcome(applyOutcome(undefined, okOutcome, T(0)), failOutcome, T(1)).lastAttemptAt).toBe(T(1));
  });

  // A hold is a verdict about ONE run. Carrying it forward would leave a
  // resolved hold in the file until something else happened to clear it.
  it('clears a hold once the next run does not hold', () => {
    const held = applyOutcome(undefined, { ...okOutcome, held: { at: T(0), reason: 'r' } }, T(0));
    expect(applyOutcome(held, okOutcome, T(1)).held).toBeNull();
  });
});

describe('shouldCommitStatus', () => {
  it('commits unconditionally on the daily run', () => {
    const f = file({ a: applyOutcome(undefined, okOutcome, T(0)) });
    expect(shouldCommitStatus(f, f, true)).toBe(true);
  });

  /**
   * The two fixture checks that make the test below mean what its name says.
   * If applyOutcome ever stopped moving these, "only the clocks moved" would be
   * a run in which nothing moved at all, and the assertion would pass without
   * exercising the exclusion at all.
   */
  it('the heartbeat really does move between two identical healthy runs', () => {
    const a = applyOutcome(undefined, okOutcome, T(0));
    const b = applyOutcome(a, okOutcome, T(1));
    expect(b.lastAttemptAt).not.toBe(a.lastAttemptAt);
  });

  it('and so does the success clock, because every healthy run is a success', () => {
    const a = applyOutcome(undefined, okOutcome, T(0));
    const b = applyOutcome(a, okOutcome, T(1));
    expect(b.lastSuccessAt).not.toBe(a.lastSuccessAt);
  });

  /**
   * The load-bearing half of the whole design. A clock that ticks every run
   * makes every field comparison trivially true, which turns this straight back
   * into commit-every-run. This one assertion dies if EITHER clock is put back
   * into the comparison: two identical healthy runs differ in lastAttemptAt and
   * lastSuccessAt and in nothing else.
   */
  it('does not commit when only the self-ticking clocks moved', () => {
    const a = applyOutcome(undefined, okOutcome, T(0));
    const b = applyOutcome(a, okOutcome, T(1));
    expect(shouldCommitStatus(file({ a }), file({ a: b }), false)).toBe(false);
  });

  // The third clock. Date minus Age moves when the edge regenerates, not when
  // the content changes, and openrouter-models is the fast tier's only source.
  it('does not commit when only the origin generation moved', () => {
    const a = applyOutcome(undefined, { ...okOutcome, originDate: T(0) }, T(0));
    const b = applyOutcome(a, { ...okOutcome, originDate: T(1) }, T(1));
    expect(shouldCommitStatus(file({ a }), file({ a: b }), false)).toBe(false);
  });

  it('and that origin generation really did move', () => {
    const a = applyOutcome(undefined, { ...okOutcome, originDate: T(0) }, T(0));
    const b = applyOutcome(a, { ...okOutcome, originDate: T(1) }, T(1));
    expect(b.originDate).not.toBe(a.originDate);
  });

  /**
   * The counter moving, ISOLATED. Between runs 1 and 2 the hysteresis flag
   * flips as well, so a comparison that read `failing` alone would also commit
   * and the test could not tell the two apart. Runs 2 and 3 differ in
   * consecutiveFailures and in nothing else.
   */
  it('commits when the failure counter alone moves, so an outage advances it every run', () => {
    const two = afterFailures(2);
    const three = applyOutcome(two, failOutcome, T(2));
    expect(shouldCommitStatus(file({ a: two }), file({ a: three }), false)).toBe(true);
  });

  it('and those two runs differ in nothing except the counter', () => {
    const two = afterFailures(2);
    const three = applyOutcome(two, failOutcome, T(2));
    const differing = Object.keys(three).filter((k) => {
      const key = k as keyof SourceStatus;
      return JSON.stringify(two[key]) !== JSON.stringify(three[key]);
    });
    expect(differing.sort()).toEqual(['consecutiveFailures', 'lastAttemptAt']);
  });

  it('commits when byte count changes', () => {
    const a = applyOutcome(undefined, okOutcome, T(0));
    const b = applyOutcome(a, { ...okOutcome, bytes: 999 }, T(1));
    expect(shouldCommitStatus(file({ a }), file({ a: b }), false)).toBe(true);
  });

  it('commits when the health state changes without any counter moving', () => {
    const a = applyOutcome(undefined, okOutcome, T(0));
    const b = applyOutcome(a, { ...staleOutcome, bytes: 100 }, T(1));
    expect(shouldCommitStatus(file({ a }), file({ a: b }), false)).toBe(true);
  });

  it('commits when a source appears', () => {
    const a = applyOutcome(undefined, okOutcome, T(0));
    expect(shouldCommitStatus(file({}), file({ a }), false)).toBe(true);
  });

  it('commits when a source disappears', () => {
    const a = applyOutcome(undefined, okOutcome, T(0));
    expect(shouldCommitStatus(file({ a }), file({}), false)).toBe(true);
  });

  it('commits when there is no committed copy at all', () => {
    expect(shouldCommitStatus(null, file({ a: applyOutcome(undefined, okOutcome, T(0)) }), false)).toBe(true);
  });

  // Same count of sources, different names. `a.length !== b.length` would say
  // these are the same set, and then the loop over b's keys would compare a
  // source against nothing.
  it('commits when one source is swapped for another of the same count', () => {
    const a = applyOutcome(undefined, okOutcome, T(0));
    expect(shouldCommitStatus(file({ a }), file({ b: a }), false)).toBe(true);
  });
});

describe('meaningfulFields', () => {
  /**
   * The exact set, not a substring scan. `toContain('bytes')` is satisfied by
   * the word inside any other key or value, and a scan for absence is satisfied
   * by a typo in the key being scanned for.
   */
  it('is exactly the fields that drive a decision, and no clock', () => {
    const m = meaningfulFields(applyOutcome(undefined, okOutcome, T(0))) as Record<string, unknown>;
    expect(Object.keys(m).sort()).toEqual([
      'bytes',
      'consecutiveFailures',
      'failing',
      'health',
      'httpStatus',
      'lastChangeAt',
      'held',
    ].sort());
  });

  it('carries the counter through by value, not merely by name', () => {
    const m = meaningfulFields(afterFailures(3)) as Record<string, unknown>;
    expect(m['consecutiveFailures']).toBe(3);
  });

  it('leaves the source status itself untouched', () => {
    const s = applyOutcome(undefined, okOutcome, T(0));
    meaningfulFields(s);
    expect(s.lastAttemptAt).toBe(T(0));
  });
});

describe('exitCodeFor', () => {
  it('is zero while under the threshold', () => {
    expect(exitCodeFor(file({ a: afterFailures(2) }), ['a'], 8)).toBe(0);
  });

  it('is non-zero at the threshold', () => {
    expect(exitCodeFor(file({ a: afterFailures(8) }), ['a'], 8)).toBe(1);
  });

  it('is non-zero past the threshold', () => {
    expect(exitCodeFor(file({ a: afterFailures(9) }), ['a'], 8)).toBe(1);
  });

  it('ignores sources outside this tier', () => {
    expect(exitCodeFor(file({ other: afterFailures(8) }), ['a'], 8)).toBe(0);
  });

  // The fast tier must not be silent because the daily tier is healthy. One
  // tripped source among many is the whole alarm.
  it('trips on one failing source standing among healthy ones', () => {
    const healthy = applyOutcome(undefined, okOutcome, T(0));
    expect(exitCodeFor(file({ a: healthy, b: afterFailures(8), c: healthy }), ['a', 'b', 'c'], 8)).toBe(1);
  });

  it('is zero for a tier whose sources are all healthy', () => {
    const healthy = applyOutcome(undefined, okOutcome, T(0));
    expect(exitCodeFor(file({ a: healthy, b: healthy }), ['a', 'b'], 8)).toBe(0);
  });

  it('is zero for a source id the file has never heard of', () => {
    expect(exitCodeFor(file({}), ['a'], 8)).toBe(0);
  });

  /**
   * Forty runs of stale, which is more than a month of daily quiet, and still
   * zero. A daily failure email about good news is how an alerting channel gets
   * muted, after which nothing else in this file works.
   */
  it('a stale source never trips the exit code, at any count', () => {
    let s: SourceStatus | undefined;
    for (let i = 0; i < 40; i++) s = applyOutcome(s, staleOutcome, T(i));
    expect(exitCodeFor(file({ a: s! }), ['a'], 8)).toBe(0);
  });
});

describe('parseStatusFile', () => {
  const good: StatusFile = file({ a: applyOutcome(undefined, okOutcome, T(0)) });
  const text = JSON.stringify(good, null, 2) + '\n';

  it('reads back a file this module wrote', () => {
    expect(parseStatusFile(text)).toEqual(good);
  });

  it('returns null rather than throwing on bytes that are not json at all', () => {
    expect(parseStatusFile('<<<<<<< HEAD\n{}\n')).toBeNull();
  });

  it('returns null on an empty file, which is what a half-written commit leaves', () => {
    expect(parseStatusFile('')).toBeNull();
  });

  it('returns null on valid json of the wrong shape', () => {
    expect(parseStatusFile('[]')).toBeNull();
  });

  // NaN counters in a public archive are permanent under R7, so a counter that
  // arrives as a string is a rejection, not a coercion.
  it('returns null when a counter is not a number', () => {
    const bad = JSON.parse(text) as { sources: Record<string, Record<string, unknown>> };
    bad.sources['a']!['consecutiveFailures'] = '7';
    expect(parseStatusFile(JSON.stringify(bad))).toBeNull();
  });

  it('returns null when a source entry is missing a field', () => {
    const bad = JSON.parse(text) as { sources: Record<string, Record<string, unknown>> };
    delete bad.sources['a']!['failing'];
    expect(parseStatusFile(JSON.stringify(bad))).toBeNull();
  });

  it('returns null on a version this code does not know', () => {
    expect(parseStatusFile(JSON.stringify({ ...good, version: 2 }))).toBeNull();
  });

  it('preserves the counter, which is the one value that cannot be recomputed', () => {
    const outage = file({ a: afterFailures(5) });
    expect(parseStatusFile(JSON.stringify(outage))?.sources['a']?.consecutiveFailures).toBe(5);
  });
});

/**
 * Purity, asserted rather than described.
 *
 * The counter lives only in the committed file, so this module is the one place
 * that must be reasonable about state it never touches. An import of `node:fs`
 * or `./git.js` here would move a decision into a place no test can drive
 * without a real repository.
 */
describe('src/status.ts stays pure', () => {
  const imports = () =>
    [...fs.readFileSync('src/status.ts', 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!).sort();

  it('imports exactly two modules, and they are a type source and a validator', () => {
    expect(imports()).toEqual(['./health.js', 'zod']);
  });

  // The list above is the strong claim; this one keeps the intent legible if
  // the list is ever widened for a legitimate reason.
  it('imports nothing that touches a disk, a process, a network or a repository', () => {
    const forbidden = ['node:fs', 'node:child_process', './fetch.js', './git.js'];
    expect(imports().filter((i) => forbidden.includes(i))).toEqual([]);
  });
});

/**
 * A HOLD IS DATED WHEN IT BEGAN, NOT WHEN IT WAS LAST OBSERVED.
 *
 * `held` used to be restamped from the run's own clock every time, so the field
 * answered "when did we last notice this" while being named, rendered and read
 * as "when did this start". Measured on the real archive: one unbroken
 * xai-llms-txt hold with an identical reason carried three different `at`
 * values across four consecutive commits, and src/liveness.ts renders it as
 * "held out of the archive since X".
 *
 * It also made meta/status.json churn. `held` is not in SELF_TICKING, so a
 * moving `at` was a meaningful change on every run, which for a held fast-tier
 * source is 96 commits a day forever.
 */
describe('a hold carries the instant it began', () => {
  const heldOutcome = (reason: string): Outcome => ({
    health: 'failed',
    changed: false,
    countsAsFailure: false,
    httpStatus: 200,
    bytes: null,
    originDate: null,
    held: { at: 'IGNORED', reason },
  });

  const T1 = '2026-09-01T00:00:00.000Z';
  const T2 = '2026-09-01T00:15:00.000Z';
  const T3 = '2026-09-02T00:15:00.000Z';

  it('stamps the first hold with the run that found it', () => {
    const first = applyOutcome(undefined, { ...heldOutcome('credential gate: xai-api-key'), held: { at: T1, reason: 'credential gate: xai-api-key' } }, T1);
    expect(first.held?.at).toBe(T1);
  });

  it('does not move the instant while the reason is unchanged', () => {
    let s = applyOutcome(undefined, { ...heldOutcome('gate: key'), held: { at: T1, reason: 'gate: key' } }, T1);
    s = applyOutcome(s, { ...heldOutcome('gate: key'), held: { at: T2, reason: 'gate: key' } }, T2);
    s = applyOutcome(s, { ...heldOutcome('gate: key'), held: { at: T3, reason: 'gate: key' } }, T3);
    expect(s.held?.at).toBe(T1);
  });

  /** A hold for a different reason is a different hold, so it gets its own instant. */
  it('moves the instant when the reason changes', () => {
    let s = applyOutcome(undefined, { ...heldOutcome('gate: key'), held: { at: T1, reason: 'gate: key' } }, T1);
    s = applyOutcome(s, { ...heldOutcome('gate: token'), held: { at: T2, reason: 'gate: token' } }, T2);
    expect(s.held?.at).toBe(T2);
    expect(s.held?.reason).toBe('gate: token');
  });

  it('clears the hold entirely when the source stops being held', () => {
    let s = applyOutcome(undefined, { ...heldOutcome('gate: key'), held: { at: T1, reason: 'gate: key' } }, T1);
    s = applyOutcome(s, { health: 'ok', changed: false, countsAsFailure: false, httpStatus: 200, bytes: 10, originDate: null, held: null }, T2);
    expect(s.held).toBeNull();
  });

  /**
   * The churn half. Two consecutive held runs with the same reason must be
   * indistinguishable to meaningfulFields, or a held fast-tier source commits
   * meta/status.json on every run for as long as the hold lasts.
   */
  it('makes two consecutive held runs meaningfully identical, so the file stops churning', () => {
    const a = applyOutcome(undefined, { ...heldOutcome('gate: key'), held: { at: T1, reason: 'gate: key' } }, T1);
    const b = applyOutcome(a, { ...heldOutcome('gate: key'), held: { at: T2, reason: 'gate: key' } }, T2);
    expect(JSON.stringify(meaningfulFields(b))).toBe(JSON.stringify(meaningfulFields(a)));
  });

  it('a hold whose reason changed IS a meaningful change, so it does commit', () => {
    const a = applyOutcome(undefined, { ...heldOutcome('gate: key'), held: { at: T1, reason: 'gate: key' } }, T1);
    const b = applyOutcome(a, { ...heldOutcome('gate: token'), held: { at: T2, reason: 'gate: token' } }, T2);
    expect(JSON.stringify(meaningfulFields(b))).not.toBe(JSON.stringify(meaningfulFields(a)));
  });
});
