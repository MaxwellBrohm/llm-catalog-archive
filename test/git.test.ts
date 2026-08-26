import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, commitPaths, pushWithRebase } from '../src/git.js';

let repo: string;
const temps: string[] = [];

function mkrepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-'));
  temps.push(dir);
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  return dir;
}

beforeAll(() => {
  // src/git.ts spawns git with the ambient environment, which is right in
  // production and dangerous here. A git hook exports GIT_DIR, and an inherited
  // value aims every temp repo below at the real repository: scaffold.test.ts
  // measured exactly that, reporting green while committing somewhere else. A
  // personal commit.gpgsign would also fail commits that have nothing to do
  // with signing.
  process.env['GIT_CONFIG_GLOBAL'] = '/dev/null';
  process.env['GIT_CONFIG_SYSTEM'] = '/dev/null';
  delete process.env['GIT_DIR'];
  delete process.env['GIT_WORK_TREE'];
  delete process.env['GIT_INDEX_FILE'];
  delete process.env['GIT_OBJECT_DIRECTORY'];
  delete process.env['GIT_ALTERNATE_OBJECT_DIRECTORIES'];
});

beforeEach(() => {
  repo = mkrepo();
});

afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function writeRaw(dir: string, rel: string, contents: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

describe('git', () => {
  it('returns the stdout of a command that succeeds', () => {
    expect(git(['symbolic-ref', '--short', 'HEAD'], repo).stdout.trim()).toBe('main');
  });

  it('returns status 0 for a command that succeeds', () => {
    expect(git(['symbolic-ref', '--short', 'HEAD'], repo).status).toBe(0);
  });

  it('returns a non-zero status for a command that fails', () => {
    expect(git(['rev-parse', 'refs/heads/nope'], repo).status).not.toBe(0);
  });

  it('returns the stderr of a command that fails', () => {
    expect(git(['rev-parse', 'refs/heads/nope'], repo).stderr).toContain('unknown revision');
  });
});

describe('commitPaths', () => {
  it('reports true when a file changed', () => {
    writeRaw(repo, 'raw/x/response.json', '{"a":1}');
    expect(commitPaths(repo, ['raw/x/response.json'], 'x: changed')).toBe(true);
  });

  it('records the message it was given on the commit', () => {
    writeRaw(repo, 'raw/x/response.json', '{"a":1}');
    commitPaths(repo, ['raw/x/response.json'], 'x: changed');
    expect(git(['log', '--oneline'], repo).stdout).toContain('x: changed');
  });

  it('commits the file it was given', () => {
    writeRaw(repo, 'raw/x/response.json', '{"a":1}');
    commitPaths(repo, ['raw/x/response.json'], 'x: changed');
    expect(git(['show', '--name-only', '--format=', 'HEAD'], repo).stdout.trim()).toBe('raw/x/response.json');
  });

  it('reports false when nothing changed', () => {
    writeRaw(repo, 'raw/x/response.json', '{"a":1}');
    commitPaths(repo, ['raw/x/response.json'], 'first');
    expect(commitPaths(repo, ['raw/x/response.json'], 'second')).toBe(false);
  });

  it('creates no commit when nothing changed', () => {
    writeRaw(repo, 'raw/x/response.json', '{"a":1}');
    commitPaths(repo, ['raw/x/response.json'], 'first');
    const before = git(['rev-list', '--count', 'HEAD'], repo).stdout.trim();
    commitPaths(repo, ['raw/x/response.json'], 'second');
    expect(git(['rev-list', '--count', 'HEAD'], repo).stdout.trim()).toBe(before);
  });

  it('reports false when given no paths at all', () => {
    expect(commitPaths(repo, [], 'nothing')).toBe(false);
  });

  it('creates no commit when given no paths at all', () => {
    // Something another session staged and has not committed yet. `git add --`
    // with no pathspec adds nothing, but `git commit -m msg --` with no
    // pathspec commits the whole index, so without the guard this file ships
    // inside a collector commit.
    fs.writeFileSync(path.join(repo, 'UNRELATED.md'), 'someone else was here');
    git(['add', 'UNRELATED.md'], repo);
    commitPaths(repo, [], 'nothing');
    expect(git(['rev-list', '--count', '--all'], repo).stdout.trim()).toBe('0');
  });

  it('throws when git add fails', () => {
    expect(() => commitPaths(repo, ['raw/x/does-not-exist.json'], 'x: changed')).toThrow(/git add failed/);
  });

  it('leaves another session work untracked', () => {
    writeRaw(repo, 'raw/x/response.json', '{"a":1}');
    fs.writeFileSync(path.join(repo, 'UNRELATED.md'), 'someone else was here');
    commitPaths(repo, ['raw/x/response.json'], 'x: changed');
    // The `??` is load bearing. A bare substring match on the filename passes
    // just as happily when the file was staged with `git add -A` and left in
    // the index, which is the behaviour this test exists to forbid.
    expect(git(['status', '--porcelain'], repo).stdout).toContain('?? UNRELATED.md');
  });

  it('leaves nothing of its own in the index afterwards', () => {
    writeRaw(repo, 'raw/x/response.json', '{"a":1}');
    fs.writeFileSync(path.join(repo, 'UNRELATED.md'), 'someone else was here');
    commitPaths(repo, ['raw/x/response.json'], 'x: changed');
    expect(git(['diff', '--cached', '--name-only'], repo).stdout.trim()).toBe('');
  });

  // The unstaged case above is the easy one. This is the case the pathspec on
  // the commit itself defends: another session that has already staged its work
  // when the collector commits. Without `-- <paths>` on the commit, git commits
  // the whole index and that file ships inside a collector commit.
  it('keeps work another session already staged out of the commit', () => {
    writeRaw(repo, 'raw/x/response.json', '{"a":1}');
    fs.writeFileSync(path.join(repo, 'UNRELATED.md'), 'someone else was here');
    git(['add', 'UNRELATED.md'], repo);
    commitPaths(repo, ['raw/x/response.json'], 'x: changed');
    // The whole file list, not `not.toContain`. A negation is also satisfied by
    // there being no commit at all, so it passes against a commitPaths that
    // does nothing.
    expect(git(['show', '--name-only', '--format=', 'HEAD'], repo).stdout.trim()).toBe('raw/x/response.json');
  });

  // R1 is the load-bearing rule and this is the only test that can catch it
  // being violated by configuration rather than by code.
  it('stores bytes verbatim through a commit and checkout round trip', () => {
    // Copy the SHIPPED .gitattributes rather than retyping it. A retyped copy
    // keeps this test green forever after someone reverts the real file, which
    // is precisely the vacuity Task 1's review caught.
    fs.copyFileSync('.gitattributes', path.join(repo, '.gitattributes'));
    commitPaths(repo, ['.gitattributes'], 'attrs');
    fs.mkdirSync(path.join(repo, 'raw/y'), { recursive: true });
    const bytes = new Uint8Array([...new TextEncoder().encode('a\r\nb\r\nc'), 0xff]);
    const p = path.join(repo, 'raw/y/response.txt');
    fs.writeFileSync(p, bytes);
    commitPaths(repo, ['raw/y/response.txt'], 'y: changed');
    // Removed first, because `git checkout -- <path>` on a file whose stat info
    // already matches the index can decline to rewrite it, and a round trip
    // that never materialised the blob proves nothing about how it was stored.
    fs.rmSync(p);
    git(['checkout', '--', 'raw/y/response.txt'], repo);
    expect(new Uint8Array(fs.readFileSync(p))).toEqual(bytes);
  });
});

describe('pushWithRebase', () => {
  function withRemote(): { local: string; bare: string } {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-bare-'));
    temps.push(bare);
    git(['init', '-q', '--bare', '-b', 'main'], bare);
    const local = mkrepo();
    fs.writeFileSync(path.join(local, 'first.txt'), 'one');
    commitPaths(local, ['first.txt'], 'first');
    git(['remote', 'add', 'origin', bare], local);
    git(['push', '-q', 'origin', 'main'], local);
    return { local, bare };
  }

  it('lands the local commit on the remote', () => {
    const { local, bare } = withRemote();
    fs.writeFileSync(path.join(local, 'mine.txt'), 'mine');
    commitPaths(local, ['mine.txt'], 'mine');
    pushWithRebase(local, 'main');
    expect(git(['log', '--oneline', 'main'], bare).stdout).toContain('mine');
  });

  // R7: a rejected non-fast-forward push is resolved by rebasing on top of
  // what is already there, never by discarding it. Permalinks into this archive
  // are commit shas, so a force push destroys published references.
  it('keeps a commit another session pushed first', () => {
    const { local, bare } = withRemote();

    const other = mkrepo();
    git(['remote', 'add', 'origin', bare], other);
    git(['fetch', '-q', 'origin', 'main'], other);
    git(['reset', '-q', '--hard', 'origin/main'], other);
    fs.writeFileSync(path.join(other, 'theirs.txt'), 'theirs');
    commitPaths(other, ['theirs.txt'], 'theirs');
    git(['push', '-q', 'origin', 'main'], other);

    fs.writeFileSync(path.join(local, 'mine.txt'), 'mine');
    commitPaths(local, ['mine.txt'], 'mine');
    pushWithRebase(local, 'main');

    expect(git(['log', '--oneline', 'main'], bare).stdout).toContain('theirs');
  });

  it('lands its own commit too when it had to rebase', () => {
    const { local, bare } = withRemote();

    const other = mkrepo();
    git(['remote', 'add', 'origin', bare], other);
    git(['fetch', '-q', 'origin', 'main'], other);
    git(['reset', '-q', '--hard', 'origin/main'], other);
    fs.writeFileSync(path.join(other, 'theirs.txt'), 'theirs');
    commitPaths(other, ['theirs.txt'], 'theirs');
    git(['push', '-q', 'origin', 'main'], other);

    fs.writeFileSync(path.join(local, 'mine.txt'), 'mine');
    commitPaths(local, ['mine.txt'], 'mine');
    pushWithRebase(local, 'main');

    expect(git(['log', '--oneline', 'main'], bare).stdout).toContain('mine');
  });

  it('throws when the remote cannot be reached', () => {
    const local = mkrepo();
    fs.writeFileSync(path.join(local, 'first.txt'), 'one');
    commitPaths(local, ['first.txt'], 'first');
    git(['remote', 'add', 'origin', path.join(os.tmpdir(), 'lca-no-such-remote')], local);
    expect(() => pushWithRebase(local, 'main', 2)).toThrow(/push failed after 2 attempts/);
  });
});
