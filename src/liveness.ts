/**
 * Is this archive still alive, and does anybody know if it is not?
 *
 * WHY THIS EXISTS. The whole project is a scheduled job that appends to git.
 * When that job stops, nothing anywhere goes red: the site keeps serving the
 * last good build, the API keeps answering, every page still resolves, and the
 * only symptom is that the newest timestamp stops moving. An archive that
 * quietly stopped collecting three weeks ago looks exactly like an archive
 * where nothing happened for three weeks.
 *
 * THE 60 DAY CLIFF MAKES IT UNRECOVERABLE. GitHub disables scheduled workflows
 * after 60 days of repository inactivity. The collector's own commits are what
 * keep that clock reset, so a collector that stops is also a collector that
 * cannot restart itself: at day 60 the schedule is switched off, and from then
 * on the failure is permanent and still silent. That is why the escalation
 * below is keyed to days-since-capture rather than to a run failing.
 *
 * PURE. The arguments are the parsed status file, the newest capture instant and
 * a clock. No fs, no git, no network. tools/liveness.mjs supplies all three and
 * the workflow acts on the exit code.
 */

import type { StatusFile } from './status.js';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/**
 * Defaults chosen against the real cadences. The daily tier runs at 00:20 and
 * the fast tier every 15 minutes, so 36 hours is more than a full daily period
 * of slack and still catches a collector that missed a day. GitHub's cliff is
 * 60 days; 45 leaves a fortnight to notice and act, which is the point of
 * warning early rather than at 59.
 */
export const DEFAULT_THRESHOLDS = {
  quietHours: 36,
  disableWarningDays: 45,
  disableCliffDays: 60,
} as const;

export type Thresholds = {
  quietHours: number;
  disableWarningDays: number;
  disableCliffDays: number;
};

export type LivenessInput = {
  /** ISO instant to judge against. Injected so this is testable without a clock. */
  now: string;
  /** meta/status.json, parsed. Null when it is missing or unreadable. */
  status: StatusFile | null;
  /** The newest commit instant touching raw/, ISO. Null when there is none. */
  lastCaptureAt: string | null;
  thresholds?: Thresholds;
};

export type Severity = 'critical' | 'warning';

export type Problem = { severity: Severity; message: string };

export type LivenessReport = {
  ok: boolean;
  /** Critical first, then warnings, each group in the order they were found. */
  problems: Problem[];
  /** Whole hours since the last stored capture. Null when there has never been one. */
  hoursSinceCapture: number | null;
};

function hoursBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.floor((to - from) / HOUR_MS);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Every reason this archive should be shouted about, or none.
 *
 * A source that is HELD is reported as a warning rather than a failure on
 * purpose: the credential gate holding a snapshot out of the archive is the
 * gate working, not the collector breaking. It still gets said out loud,
 * because a source silently held forever is indistinguishable from a source
 * silently forgotten.
 */
export function assessLiveness(input: LivenessInput): LivenessReport {
  const t = input.thresholds ?? DEFAULT_THRESHOLDS;
  const critical: Problem[] = [];
  const warning: Problem[] = [];

  const hoursSinceCapture =
    input.lastCaptureAt === null ? null : hoursBetween(input.lastCaptureAt, input.now);

  if (input.lastCaptureAt === null) {
    critical.push({
      severity: 'critical',
      message: 'The archive holds no capture at all. The collector has never stored anything.',
    });
  } else if (hoursSinceCapture === null) {
    critical.push({
      severity: 'critical',
      message: `The newest capture instant ${input.lastCaptureAt} could not be read as a date, so liveness cannot be judged.`,
    });
  } else {
    const days = Math.floor(hoursSinceCapture / 24);
    if (days >= t.disableCliffDays) {
      critical.push({
        severity: 'critical',
        message:
          `Nothing has been stored for ${plural(days, 'day')}. GitHub disables scheduled workflows after ` +
          `${t.disableCliffDays} days of repository inactivity, so the schedules are likely already off and ` +
          'will not restart on their own. Re-enable them in the Actions tab and dispatch collect-daily by hand.',
      });
    } else if (days >= t.disableWarningDays) {
      critical.push({
        severity: 'critical',
        message:
          `Nothing has been stored for ${plural(days, 'day')}. GitHub disables scheduled workflows at ` +
          `${t.disableCliffDays} days of repository inactivity, which is ${plural(t.disableCliffDays - days, 'day')} away. ` +
          'After that the collector cannot restart itself.',
      });
    } else if (hoursSinceCapture >= t.quietHours) {
      critical.push({
        severity: 'critical',
        message: `Nothing has been stored for ${plural(hoursSinceCapture, 'hour')}, past the ${t.quietHours} hour threshold.`,
      });
    }
  }

  if (input.status === null) {
    critical.push({
      severity: 'critical',
      message: 'meta/status.json is missing or unreadable, so per-source health cannot be judged.',
    });
    return { ok: critical.length === 0, problems: critical, hoursSinceCapture };
  }

  const staleStatus = hoursBetween(input.status.updatedAt, input.now);
  if (staleStatus !== null && staleStatus >= t.quietHours) {
    critical.push({
      severity: 'critical',
      message:
        `meta/status.json was last written ${plural(staleStatus, 'hour')} ago, so the collector is not running ` +
        'even to record that it tried.',
    });
  }

  for (const [id, s] of Object.entries(input.status.sources).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (s.failing) {
      critical.push({
        severity: 'critical',
        message: `Source ${id} is failing: ${plural(s.consecutiveFailures, 'consecutive failure')}, health ${s.health}.`,
      });
    }
    if (s.held !== null) {
      warning.push({
        severity: 'warning',
        message: `Source ${id} is held out of the archive since ${s.held.at}: ${s.held.reason}`,
      });
    }
  }

  const problems = [...critical, ...warning];
  return { ok: critical.length === 0, problems, hoursSinceCapture };
}

/** The report as the body of an issue, or as a run log. */
export function renderLiveness(report: LivenessReport): string {
  if (report.problems.length === 0) {
    const age = report.hoursSinceCapture === null ? 'unknown' : `${report.hoursSinceCapture}h`;
    return `The archive is alive. Newest capture ${age} ago, every source healthy, nothing held.`;
  }
  const lines = report.problems.map((p) => `- **${p.severity}**: ${p.message}`);
  return [
    report.ok
      ? 'The archive is collecting, but something needs a look.'
      : 'The archive has stopped collecting, or a source has stopped working.',
    '',
    ...lines,
    '',
    'This issue is opened and updated by .github/workflows/liveness.yml. It closes itself when the',
    'next run finds nothing wrong.',
  ].join('\n');
}
