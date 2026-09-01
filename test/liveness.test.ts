import { describe, expect, it } from 'vitest';
import { assessLiveness, renderLiveness, DEFAULT_THRESHOLDS, type LivenessInput } from '../src/liveness.js';
import type { StatusFile, SourceStatus } from '../src/status.js';

const NOW = '2026-09-01T12:00:00.000Z';

const healthy = (over: Partial<SourceStatus> = {}): SourceStatus => ({
  lastAttemptAt: NOW,
  lastSuccessAt: NOW,
  lastChangeAt: null,
  consecutiveFailures: 0,
  failing: false,
  health: 'ok',
  httpStatus: 200,
  bytes: 10,
  originDate: null,
  held: null,
  ...over,
});

const statusAt = (updatedAt: string, sources: Record<string, SourceStatus>): StatusFile => ({
  version: 1,
  updatedAt,
  sources,
});

const input = (over: Partial<LivenessInput> = {}): LivenessInput => ({
  now: NOW,
  status: statusAt(NOW, { a: healthy() }),
  lastCaptureAt: NOW,
  ...over,
});

describe('a healthy archive', () => {
  it('is ok', () => {
    expect(assessLiveness(input()).ok).toBe(true);
  });

  it('reports no problems at all', () => {
    expect(assessLiveness(input()).problems).toEqual([]);
  });

  it('says so in words a human reads', () => {
    expect(renderLiveness(assessLiveness(input()))).toContain('The archive is alive');
  });
});

describe('a collector that has gone quiet', () => {
  /** 36h is the threshold: more than a full daily period of slack. */
  it('is still ok just inside the threshold', () => {
    const captured = new Date(Date.parse(NOW) - 35 * 3_600_000).toISOString();
    expect(assessLiveness(input({ lastCaptureAt: captured, status: statusAt(captured, { a: healthy() }) })).ok).toBe(true);
  });

  it('is not ok once past it', () => {
    const captured = new Date(Date.parse(NOW) - 40 * 3_600_000).toISOString();
    const r = assessLiveness(input({ lastCaptureAt: captured, status: statusAt(captured, { a: healthy() }) }));
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.message.includes('Nothing has been stored'))).toBe(true);
  });

  /**
   * The reason this check exists at all. The collector's own commits are what
   * reset GitHub's inactivity clock, so a collector that stops is a collector
   * that cannot restart itself once the schedules are switched off.
   */
  it('warns about the 60 day workflow-disable cliff before reaching it', () => {
    const captured = new Date(Date.parse(NOW) - 46 * 86_400_000).toISOString();
    const r = assessLiveness(input({ lastCaptureAt: captured, status: statusAt(captured, { a: healthy() }) }));
    expect(r.ok).toBe(false);
    expect(r.problems[0]?.message).toContain('60 days');
    expect(r.problems[0]?.message).toContain('14 days away');
  });

  it('says the schedules are probably already off past the cliff', () => {
    const captured = new Date(Date.parse(NOW) - 61 * 86_400_000).toISOString();
    const r = assessLiveness(input({ lastCaptureAt: captured, status: statusAt(captured, { a: healthy() }) }));
    expect(r.problems[0]?.message).toContain('likely already off');
    expect(r.problems[0]?.message).toContain('dispatch collect-daily by hand');
  });

  it('is critical when there has never been a capture', () => {
    const r = assessLiveness(input({ lastCaptureAt: null }));
    expect(r.ok).toBe(false);
    expect(r.problems[0]?.message).toContain('no capture at all');
  });

  it('refuses to judge rather than guessing when the instant is unparseable', () => {
    const r = assessLiveness(input({ lastCaptureAt: 'not-a-date' }));
    expect(r.ok).toBe(false);
    expect(r.problems[0]?.message).toContain('could not be read as a date');
  });
});

describe('the status file itself', () => {
  it('is critical when missing, because per-source health becomes unknowable', () => {
    const r = assessLiveness(input({ status: null }));
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.message.includes('meta/status.json is missing'))).toBe(true);
  });

  /** The collector not even recording that it tried is worse than a failed fetch. */
  it('is critical when it has not been written for longer than the threshold', () => {
    const old = new Date(Date.parse(NOW) - 40 * 3_600_000).toISOString();
    const r = assessLiveness(input({ status: statusAt(old, { a: healthy() }) }));
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.message.includes('not running'))).toBe(true);
  });
});

describe('per-source health', () => {
  it('is critical when a source is failing, and names it', () => {
    const r = assessLiveness(
      input({ status: statusAt(NOW, { 'openai-llms-txt': healthy({ failing: true, consecutiveFailures: 4, health: 'failed' }) }) }),
    );
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.message.includes('openai-llms-txt') && p.message.includes('4 consecutive failures'))).toBe(true);
  });

  /**
   * A held source is the credential gate WORKING, not the collector breaking,
   * so it is a warning. It is still said out loud, because a source silently
   * held forever is indistinguishable from one silently forgotten.
   */
  it('warns rather than failing when a source is held, and still says why', () => {
    const r = assessLiveness(
      input({ status: statusAt(NOW, { 'xai-llms-txt': healthy({ held: { at: NOW, reason: 'credential gate: xai-api-key' } }) }) }),
    );
    expect(r.ok).toBe(true);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]?.severity).toBe('warning');
    expect(r.problems[0]?.message).toContain('credential gate');
  });

  it('puts every critical before every warning', () => {
    const r = assessLiveness(
      input({
        status: statusAt(NOW, {
          held: healthy({ held: { at: NOW, reason: 'gate' } }),
          broken: healthy({ failing: true, consecutiveFailures: 2 }),
        }),
      }),
    );
    const severities = r.problems.map((p) => p.severity);
    expect(severities).toEqual([...severities].sort((a, b) => (a === 'critical' && b === 'warning' ? -1 : a === b ? 0 : 1)));
    expect(severities[0]).toBe('critical');
  });

  it('names sources in a stable order, so the issue body does not churn', () => {
    const sources = { zebra: healthy({ failing: true }), alpha: healthy({ failing: true }) };
    const r = assessLiveness(input({ status: statusAt(NOW, sources) }));
    expect(r.problems[0]?.message).toContain('alpha');
    expect(r.problems[1]?.message).toContain('zebra');
  });
});

describe('the rendered body', () => {
  it('distinguishes stopped-collecting from needs-a-look', () => {
    const stopped = assessLiveness(input({ lastCaptureAt: new Date(Date.parse(NOW) - 40 * 3_600_000).toISOString() }));
    expect(renderLiveness(stopped)).toContain('has stopped collecting');

    const held = assessLiveness(
      input({ status: statusAt(NOW, { x: healthy({ held: { at: NOW, reason: 'gate' } }) }) }),
    );
    expect(renderLiveness(held)).toContain('needs a look');
  });

  it('says how the issue closes itself, so nobody closes it by hand and loses the signal', () => {
    const stopped = assessLiveness(input({ lastCaptureAt: null }));
    expect(renderLiveness(stopped)).toContain('closes itself');
  });
});

describe('the defaults', () => {
  it('warns a fortnight before the cliff it is protecting against', () => {
    expect(DEFAULT_THRESHOLDS.disableCliffDays - DEFAULT_THRESHOLDS.disableWarningDays).toBe(15);
  });

  it('allows more than a full daily period of slack before shouting', () => {
    expect(DEFAULT_THRESHOLDS.quietHours).toBeGreaterThan(24);
  });
});
