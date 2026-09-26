/**
 * `liveness`: is the archive still collecting, and is every source healthy?
 *
 * The impure shell around src/liveness.ts. It reads meta/status.json, asks git
 * for the newest commit that touched raw/, and prints a report. Exit 0 means
 * nothing critical; exit 1 means the workflow should open an issue.
 *
 * WRITTEN TO STDOUT AND TO $GITHUB_OUTPUT. The workflow needs two things from
 * this: whether to shout, and what to say. Passing the body through a file
 * rather than through a shell variable keeps newlines and backticks intact.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseStatusFile } from './status.js';
import { loadSources } from './config.js';
import { lastCommitInstant } from './git.js';
import { assessLiveness, renderLiveness } from './liveness.js';

const cwd = process.cwd();

function readStatus(): ReturnType<typeof parseStatusFile> {
  const p = path.join(cwd, 'meta/status.json');
  if (!fs.existsSync(p)) return null;
  try {
    return parseStatusFile(fs.readFileSync(p, 'utf8'));
  } catch {
    // Unreadable is reported by assessLiveness as a critical problem, which is
    // the point: a status file that cannot be parsed is not a healthy archive.
    return null;
  }
}

/**
 * The ids the collector actually fetches. Read here rather than defaulted
 * inside assessLiveness, so that a missing or unreadable sources file falls
 * back to judging everything in the status file rather than judging nothing:
 * an alarm that goes quiet because its config failed to load is worse than one
 * that shouts about a source it should have skipped.
 */
function activeIds(): string[] | undefined {
  const p = path.join(cwd, 'meta/sources.json');
  if (!fs.existsSync(p)) return undefined;
  try {
    return loadSources(JSON.parse(fs.readFileSync(p, 'utf8')))
      .sources.filter((s) => s.status === 'active')
      .map((s) => s.id);
  } catch {
    return undefined;
  }
}

const report = assessLiveness({
  now: new Date().toISOString(),
  status: readStatus(),
  lastCaptureAt: lastCommitInstant(cwd, 'raw'),
  activeIds: activeIds(),
});

const body = renderLiveness(report);
console.log(body);

const out = process.env['GITHUB_OUTPUT'];
if (out !== undefined && out !== '') {
  fs.appendFileSync(out, `ok=${report.ok ? 'true' : 'false'}\n`);
  fs.writeFileSync(path.join(cwd, 'liveness-body.md'), body + '\n');
}

process.exit(report.ok ? 0 : 1);
