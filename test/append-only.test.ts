import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * THE LEDGER GUARANTEE, EXERCISED RATHER THAN DESCRIBED.
 *
 * The append-only rule is the whole value of the ledgers: a scorecard anyone can
 * edit after the fact is not evidence of having been right, it is a claim to
 * have been right. That rule was enforced only by shell inside a workflow file,
 * which no test could reach, and two mutations proved what that cost:
 *
 *   `-ne 0` -> `-lt 0`, which grep -c can never satisfy: 2,345 tests green.
 *   deleting corrections.jsonl and retractions.jsonl from the loops: 2,345 green.
 *
 * Both disabled the guarantee completely. These tests run the extracted script
 * against real temporary git repositories, over ALL THREE ledgers, because a
 * test pinned to one filename passes when the other two are dropped.
 */

/**
 * meta/posted.jsonl joined this list when the desk began writing to it. Until
 * then the guard did not cover it while two documents claimed it did, which is
 * the worst of both: a guarantee described but not enforced. It matters more
 * than the others if anything, because it is now written by a web endpoint
 * rather than only by a person at a keyboard.
 */
const LEDGERS = [
  'meta/corrections.jsonl',
  'meta/retractions.jsonl',
  'meta/leaks-ledger.jsonl',
  'meta/posted.jsonl',
] as const;
const SCRIPT = path.resolve('tools/append-only.sh');

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

const git = (args: string[], cwd: string) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A repo with all three ledgers holding one line each, and a base commit to diff from. */
function repoWithLedgers(): { dir: string; base: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-ao-'));
  temps.push(dir);
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 't@example.invalid'], dir);
  git(['config', 'user.name', 'test'], dir);
  fs.mkdirSync(path.join(dir, 'meta'), { recursive: true });
  for (const f of LEDGERS) fs.writeFileSync(path.join(dir, f), '{"id":"one"}\n');
  git(['add', '.'], dir);
  git(['commit', '-qm', 'base'], dir);
  return { dir, base: git(['rev-parse', 'HEAD'], dir).trim() };
}

/** Run the guard. Returns its exit code rather than throwing. */
function run(base: string, dir: string): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [SCRIPT, base, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function commitAll(dir: string, message: string): void {
  git(['add', '-A'], dir);
  git(['commit', '-qm', message], dir);
}

describe('the append-only guard passes what it should', () => {
  it('allows a commit that changes nothing', () => {
    const { dir, base } = repoWithLedgers();
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x');
    commitAll(dir, 'unrelated');
    expect(run(base, dir).code).toBe(0);
  });

  it('allows a line appended to every ledger', () => {
    const { dir, base } = repoWithLedgers();
    for (const f of LEDGERS) fs.appendFileSync(path.join(dir, f), '{"id":"two"}\n');
    commitAll(dir, 'append');
    expect(run(base, dir).code).toBe(0);
  });

  it('skips rather than failing on an all-zeroes base, which is a branch creation', () => {
    const { dir } = repoWithLedgers();
    expect(run('0000000000000000000000000000000000000000', dir).code).toBe(0);
  });
});

/**
 * PARAMETERISED OVER ALL THREE. The previous assertion pinned one filename, so
 * dropping the other two from the guard also passed.
 */
describe.each(LEDGERS)('the guard refuses a violation in %s', (ledger) => {
  it('fails when a line is removed', () => {
    const { dir, base } = repoWithLedgers();
    fs.writeFileSync(path.join(dir, ledger), '');
    commitAll(dir, `empty ${ledger}`);
    const r = run(base, dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain('append-only');
  });

  it('fails when a line is modified in place', () => {
    const { dir, base } = repoWithLedgers();
    fs.writeFileSync(path.join(dir, ledger), '{"id":"edited"}\n');
    commitAll(dir, `edit ${ledger}`);
    expect(run(base, dir).code).toBe(1);
  });

  /**
   * Deleting a zero-line file produces no '-' content lines at all, so while
   * the ledgers are still empty a git rm sails past the diff check. The
   * existence check is what catches it, and it has to be tested separately.
   */
  it('fails when the file is deleted outright', () => {
    const { dir, base } = repoWithLedgers();
    fs.rmSync(path.join(dir, ledger));
    commitAll(dir, `rm ${ledger}`);
    const r = run(base, dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain('may not be deleted or renamed');
  });

  it('fails when the file is deleted while it is still empty', () => {
    const { dir, base } = repoWithLedgers();
    fs.writeFileSync(path.join(dir, ledger), '');
    commitAll(dir, 'empty it');
    const emptied = git(['rev-parse', 'HEAD'], dir).trim();
    fs.rmSync(path.join(dir, ledger));
    commitAll(dir, 'now remove it');
    expect(run(emptied, dir).code).toBe(1);
    expect(base).not.toBe(emptied);
  });
});

/**
 * A GUARD THAT CANNOT RUN HAS NOT PASSED. Both of these used to be the shapes
 * that reported "no lines removed" exactly as confidently as a clean diff.
 */
describe('the guard refuses rather than skipping when it cannot check', () => {
  it('fails when the diff base is not a reachable commit, which is what a force-push leaves', () => {
    const { dir } = repoWithLedgers();
    const r = run('b'.repeat(40), dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain('not a reachable commit');
  });

  it('fails on a repository with no ledgers at all', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-ao-bare-'));
    temps.push(dir);
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'user.email', 't@example.invalid'], dir);
    git(['config', 'user.name', 'test'], dir);
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
    git(['add', '.'], dir);
    git(['commit', '-qm', 'base'], dir);
    expect(run(git(['rev-parse', 'HEAD'], dir).trim(), dir).code).toBe(1);
  });
});

describe('the workflow actually calls the extracted guard', () => {
  const yaml = fs.readFileSync('.github/workflows/append-only.yml', 'utf8');

  it('invokes tools/append-only.sh rather than carrying its own copy', () => {
    expect(yaml).toContain('tools/append-only.sh');
  });

  it('checks out full history, without which the diff base is unreachable', () => {
    expect(yaml).toContain('fetch-depth: 0');
  });
});

describe('the guard names every ledger', () => {
  const script = fs.readFileSync('tools/append-only.sh', 'utf8');
  it.each(LEDGERS)('covers %s', (ledger) => {
    expect(script).toContain(ledger);
  });
});
