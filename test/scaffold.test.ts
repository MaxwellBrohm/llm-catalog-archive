import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Read the shipped .gitattributes as a list of effective patterns: blank lines
// and comments dropped, so a commented-out rule cannot satisfy an assertion the
// way a bare substring match would.
function attributeLines(): string[] {
  return fs
    .readFileSync('.gitattributes', 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

// Isolate git from this machine's global and system config, so a personal
// core.attributesFile or commit.gpgsign cannot change what these tests observe.
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  // Not dead code, do not tidy away. These are unset rather than merely
  // overridden, because a git hook exports them and an inherited value
  // silently aims every temp-repo test below at the real repository. Measured:
  // with GIT_DIR inherited, this suite reported 6 passed while committing into
  // a different repo. Node drops env keys whose value is undefined.
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
}

const tempRepos: string[] = [];

afterAll(() => {
  for (const dir of tempRepos) fs.rmSync(dir, { recursive: true, force: true });
});

describe('scaffold', () => {
  it('marks raw/** as -text so git never rewrites stored bytes', () => {
    expect(attributeLines()).toContain('raw/** -text');
  });

  it('marks backfill/** as -text so git never rewrites stored bytes', () => {
    expect(attributeLines()).toContain('backfill/** -text');
  });

  it('ships the corrections ledger, empty', () => {
    expect(fs.readFileSync('meta/corrections.jsonl', 'utf8')).toBe('');
  });

  it('ships the retractions ledger, empty', () => {
    expect(fs.readFileSync('meta/retractions.jsonl', 'utf8')).toBe('');
  });

  it('ships the leaks accuracy ledger, empty', () => {
    expect(fs.readFileSync('meta/leaks-ledger.jsonl', 'utf8')).toBe('');
  });

  /*
   * Empty is only half of it. An append-only ledger that nothing guards is a
   * mutable file with a promise written on it, and the promise is the whole
   * product claim: a scorecard anyone can edit after the fact is not evidence
   * of having been right.
   *
   * This used to count two occurrences of one filename inside the workflow
   * YAML, which was weak in both directions: it passed when the OTHER two
   * ledgers were dropped from the guard, and it broke when the guard was
   * extracted into a script so it could finally be executed. The guard is now
   * tools/append-only.sh and test/append-only.test.ts RUNS it against real
   * temporary repositories, over all three ledgers. All this needs to assert is
   * that the wiring exists.
   */
  it('guards every ledger, in a script the suite can execute', () => {
    const script = fs.readFileSync('tools/append-only.sh', 'utf8');
    for (const ledger of ['meta/corrections.jsonl', 'meta/retractions.jsonl', 'meta/leaks-ledger.jsonl']) {
      expect(script).toContain(ledger);
    }
  });

  it('calls that script from the workflow rather than duplicating it', () => {
    expect(fs.readFileSync('.github/workflows/append-only.yml', 'utf8')).toContain('tools/append-only.sh');
  });
});

describe('stored bytes stay diffable', () => {
  // -text must switch off EOL normalization WITHOUT switching off diffing.
  // Writing `-diff=auto` looks like it asks for auto-detected diffs, but git
  // reads the leading dash as "unset" and discards the `=auto`, and an unset
  // diff attribute means "binary". These two tests are the difference.

  it('leaves the diff attribute unspecified for raw and backfill, not unset', () => {
    const attrs = (p: string) =>
      execFileSync('git', ['check-attr', 'text', 'diff', '--', p], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: gitEnv,
      });

    for (const p of ['raw/x/response.json', 'backfill/x/response.json']) {
      expect(attrs(p)).toContain(`${p}: text: unset`);
      expect(attrs(p)).toContain(`${p}: diff: unspecified`);
    }
  });

  it('shows a real hunk, not "Binary files differ", in git log -p on a stored artifact', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-catalog-attr-'));
    tempRepos.push(dir);

    git(dir, 'init', '-q', '-b', 'main');
    // Copy the shipped file rather than retyping its contents here. A retyped
    // copy would keep passing after someone reverted the real .gitattributes,
    // which is exactly the vacuous test this replaces.
    fs.copyFileSync('.gitattributes', path.join(dir, '.gitattributes'));

    const artifact = path.join(dir, 'raw', 'x', 'response.json');
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, '{"models":[{"id":"x","price":2}]}\n');
    git(dir, 'add', '.gitattributes', 'raw/x/response.json');
    git(dir, 'commit', '-qm', 'first observation');

    // One byte changes: the price goes from 2 to 3.
    fs.writeFileSync(artifact, '{"models":[{"id":"x","price":3}]}\n');
    git(dir, 'commit', '-qam', 'second observation');

    const log = git(dir, 'log', '-p', '--', 'raw/x/response.json');
    expect(log).not.toContain('Binary files');
    expect(log).toContain('+{"models":[{"id":"x","price":3}]}');
    expect(log).toContain('-{"models":[{"id":"x","price":2}]}');
  });
});

// W1. The workflow runs unattended on a public repo with contents:write, so
// both of these are one silent edit away from mattering.
describe('the collect-daily workflow', () => {
  const workflow = (): string => fs.readFileSync('.github/workflows/collect-daily.yml', 'utf8');

  it('bounds the job, so a hung fetch cannot hold the write token open', () => {
    expect(workflow()).toContain('timeout-minutes: 15');
  });

  // Negative lookahead rather than a substring match on the good form: a
  // second, bare `npm ci` added later would satisfy toContain while running
  // dependency lifecycle scripts with the push credential in .git/config.
  it('never installs in a way that runs dependency lifecycle scripts', () => {
    expect(workflow()).not.toMatch(/npm ci(?! --ignore-scripts)/);
  });
});
