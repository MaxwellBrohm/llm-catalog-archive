import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The counter read-back, at the only level that can see it.
 *
 * `src/cli.ts` is the single place the committed counter re-enters `runTier`.
 * Changing that argument to `null` typechecks cleanly and killed ZERO tests:
 * every counter test above it passes `prevStatus` in by hand, so the wire from
 * the archive back into the run was never held by anything.
 *
 * That is the eight-days-late defect verbatim. The runner is ephemeral, so a
 * count that is not read back from the archive restarts at zero every run and
 * no source ever reaches its threshold: the collector would look healthy for
 * ever while being completely dead.
 *
 * Two real runs against a real directory is the only shape that states it. One
 * run cannot: the first run always writes 1 whether or not it read anything.
 */

const REPO = process.cwd();
const temps: string[] = [];

afterAll(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

// Isolated from this machine's git config for the same reasons test/scaffold.
// test.ts is: an inherited GIT_DIR silently aims the whole test at the real
// repository.
const env = {
  ...process.env,
  LCA_NO_PUSH: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

/**
 * One source, pointed at a closed port so the fetch really fails rather than
 * being stubbed. `retries: 0` keeps it to a single attempt with no backoff.
 */
const sourcesFile = {
  version: 1,
  userAgent: 'llm-catalog-archive/1.0 (+https://example.invalid)',
  contact: 'https://example.invalid/issues',
  sources: [
    {
      id: 'unreachable',
      url: 'https://127.0.0.1:9/nope',
      tier: 'daily',
      status: 'active',
      path: 'raw/unreachable/response.txt',
      contentType: 'text',
      expectedRoot: null,
      invariants: {
        minBytes: 1,
        requiredKeyPath: null,
        minRecords: null,
        canary: 'never reached',
        sizeBand: [0.5, 2.0],
      },
      freshness: { kind: 'none', maxQuietDays: null },
      predicate: { type: 'bytes' },
      timeoutS: 5,
      retries: 0,
      maxRedirects: 3,
      rateLimit: { maxAutoEventsPerDay: 8 },
      magnitudeGuard: { maxShrinkPct: 25 },
      notes: 'A closed port, so the failure is real rather than stubbed.',
    },
  ],
};

function archive(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-cli-'));
  temps.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env });
  fs.mkdirSync(path.join(dir, 'meta'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta/sources.json'), JSON.stringify(sourcesFile, null, 2));
  execFileSync('git', ['add', 'meta/sources.json'], { cwd: dir, env });
  execFileSync('git', ['commit', '-qm', 'sources'], { cwd: dir, env });
  return dir;
}

function collect(dir: string): void {
  try {
    execFileSync('npx', ['tsx', path.join(REPO, 'src/cli.ts'), '--tier', 'daily'], {
      cwd: dir,
      env,
      encoding: 'utf8',
    });
  } catch {
    // A non-zero exit is the threshold speaking, not a harness failure. This
    // test is about what lands in the file, and the file is asserted directly.
  }
}

/** The counter as it stands ON DISK, read back out of the committed file. */
function counter(dir: string): unknown {
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'meta/status.json'), 'utf8')) as {
    sources?: Record<string, { consecutiveFailures?: unknown } | undefined>;
  };
  return file.sources?.['unreachable']?.consecutiveFailures;
}

/**
 * Memoised the way `shipped()` is in test/config.test.ts. Each `it` still
 * makes exactly one claim; what is shared is the expensive setup, not the
 * assertion. Three real collector runs, not five.
 */
let oneRunDir: string | null = null;
const oneRun = (): string => {
  if (oneRunDir === null) {
    oneRunDir = archive();
    collect(oneRunDir);
  }
  return oneRunDir;
};

let twoRunDir: string | null = null;
const twoRuns = (): string => {
  if (twoRunDir === null) {
    twoRunDir = archive();
    collect(twoRunDir);
    collect(twoRunDir);
  }
  return twoRunDir;
};

describe('the collector run end to end', () => {
  it('writes a status file on the very first run', () => {
    expect(fs.existsSync(path.join(oneRun(), 'meta/status.json'))).toBe(true);
  });

  it('counts one failure after one run', () => {
    expect(counter(oneRun())).toBe(1);
  });

  it('commits the status file rather than leaving it in the working tree', () => {
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: oneRun(), env, encoding: 'utf8' })).toBe('');
  });

  // The claim. A run that does not read the committed counter back writes 1
  // here too, and every other counter test in this suite still passes.
  it('reads the committed counter back, so a second failing run counts two', () => {
    expect(counter(twoRuns())).toBe(2);
  });

  it('does not leave the second run uncommitted either', () => {
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: twoRuns(), env, encoding: 'utf8' })).toBe('');
  });
}, 120_000);
