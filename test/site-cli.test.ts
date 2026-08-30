import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The generator end to end, in a subprocess, against a real git repository.
 *
 * Everything below this level is a pure function tested from a literal, so this
 * file exists for the wiring those tests cannot see: that the ledger is read
 * from meta/retractions.jsonl rather than assumed empty, that a retraction in
 * that file actually reaches the page, and that a missing ledger stops the
 * build instead of quietly publishing every retracted change unmarked.
 *
 * Excluded from vitest.stryker.config.ts for the same reason test/cli.test.ts
 * is: a subprocess cannot see Stryker's in-process mutant switch.
 */

const REPO = process.cwd();
const temps: string[] = [];

afterAll(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

const env = {
  ...process.env,
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

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env });
}

/** A repository with one source, one first capture and one later change. */
function fixtureRepo(): { dir: string; second: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-sitecli-'));
  temps.push(dir);
  run(dir, ['init', '-q', '-b', 'main']);

  fs.mkdirSync(path.join(dir, 'raw/openai-llms-txt'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'meta'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta/retractions.jsonl'), '');

  const sidecar = (origin: string) =>
    JSON.stringify(
      {
        fetchedAt: '2026-08-28T11:23:40.960Z',
        finalUrl: 'https://developers.openai.com/api/docs/llms.txt',
        status: 200,
        etag: null,
        lastModified: null,
        date: 'Fri, 28 Aug 2026 11:23:40 GMT',
        age: '11718',
        cacheControl: null,
        cfCacheStatus: null,
        contentEncoding: null,
        contentLength: null,
        observed_at: '2026-08-28T11:23:40.960Z',
        origin_date: origin,
      },
      null,
      2,
    ) + '\n';

  fs.writeFileSync(path.join(dir, 'raw/openai-llms-txt/response.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(dir, 'raw/openai-llms-txt/headers.json'), sidecar('2026-08-26T20:25:00.000Z'));
  run(dir, ['add', '--', 'raw/openai-llms-txt', 'meta/retractions.jsonl']);
  run(dir, ['commit', '-q', '-m', 'openai-llms-txt: changed (8 bytes, HTTP 200)']);

  fs.writeFileSync(path.join(dir, 'raw/openai-llms-txt/response.txt'), 'one\nTWO\n');
  fs.writeFileSync(path.join(dir, 'raw/openai-llms-txt/headers.json'), sidecar('2026-08-28T08:08:22.000Z'));
  run(dir, ['add', '--', 'raw/openai-llms-txt']);
  run(dir, ['commit', '-q', '-m', 'openai-llms-txt: changed (8 bytes, HTTP 200)']);

  return { dir, second: run(dir, ['rev-parse', 'HEAD']).trim() };
}

function build(dir: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('npx', ['tsx', path.join(REPO, 'src/site-cli.ts')], {
    cwd: dir,
    encoding: 'utf8',
    env,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const TIMEOUT_MS = 60_000;

describe('site-cli against a real repository', () => {
  it('exits zero', () => {
    expect(build(fixtureRepo().dir).status).toBe(0);
  });

  it('writes the index page into docs/site', () => {
    const { dir } = fixtureRepo();
    build(dir);
    expect(fs.existsSync(path.join(dir, 'docs/site/index.html'))).toBe(true);
  });

  it('writes .nojekyll beside it', () => {
    const { dir } = fixtureRepo();
    build(dir);
    expect(fs.existsSync(path.join(dir, 'docs/site/.nojekyll'))).toBe(true);
  });

  // GitHub Pages looks for .nojekyll in the root of what it publishes, and its
  // branch source can publish the repository root or /docs and nothing else.
  it('writes a second .nojekyll at docs/, which is where Pages looks', () => {
    const { dir } = fixtureRepo();
    build(dir);
    expect(fs.existsSync(path.join(dir, 'docs/.nojekyll'))).toBe(true);
  });

  it('honours LCA_SITE_URL in the feed', () => {
    const { dir } = fixtureRepo();
    const r = spawnSync('npx', ['tsx', path.join(REPO, 'src/site-cli.ts')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...env, LCA_SITE_URL: 'https://example.test/archive' },
    });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'docs/site/feed.xml'), 'utf8')).toContain(
      '<link>https://example.test/archive/index.html</link>',
    );
  });

  it('writes one change page per commit that changed an artifact', () => {
    const { dir } = fixtureRepo();
    build(dir);
    // Absent counts as zero rather than as a thrown ENOENT. A mutant that
    // built the site from no records at all made this test red with a
    // filesystem error, which the gated planter correctly refuses to call a
    // kill because it is not an assertion about the page count.
    const changes = path.join(dir, 'docs/site/changes');
    const names = fs.existsSync(changes) ? fs.readdirSync(changes) : [];
    expect(names).toHaveLength(2);
  });

  it('reports the change count it built from', () => {
    expect(build(fixtureRepo().dir).stdout).toContain('site: 2 changes');
  });

  it('links the raw artifact at the commit sha on the change page', () => {
    const { dir, second } = fixtureRepo();
    build(dir);
    const page = fs.readFileSync(path.join(dir, `docs/site/changes/${second}.html`), 'utf8');
    expect(page).toContain(`/blob/${second}/raw/openai-llms-txt/response.txt`);
  });

  it('shows the origin_date stored at that commit, not the one at HEAD', () => {
    const { dir } = fixtureRepo();
    build(dir);
    const dirents = fs.readdirSync(path.join(dir, 'docs/site/changes'));
    const pages = dirents.map((f) => fs.readFileSync(path.join(dir, 'docs/site/changes', f), 'utf8'));
    expect(pages.some((p) => p.includes('26 August 2026 20:25 UTC'))).toBe(true);
  });
}, TIMEOUT_MS);

describe('site-cli and the retraction ledger', () => {
  it('marks a change whose sha the ledger names', () => {
    const { dir, second } = fixtureRepo();
    fs.writeFileSync(path.join(dir, 'meta/retractions.jsonl'), `{"sha":"${second}","reason":"fixture"}\n`);
    build(dir);
    const page = fs.readFileSync(path.join(dir, `docs/site/changes/${second}.html`), 'utf8');
    expect(page).toContain('<span class="badge badge-retracted">retracted</span>');
  });

  it('still writes that page rather than deleting it', () => {
    const { dir, second } = fixtureRepo();
    fs.writeFileSync(path.join(dir, 'meta/retractions.jsonl'), `{"sha":"${second}"}\n`);
    build(dir);
    expect(fs.existsSync(path.join(dir, `docs/site/changes/${second}.html`))).toBe(true);
  });

  it('reports how many ledger lines matched a commit', () => {
    const { dir, second } = fixtureRepo();
    fs.writeFileSync(path.join(dir, 'meta/retractions.jsonl'), `{"sha":"${second}"}\n`);
    expect(build(dir).stdout).toContain('1 retraction(s) in the ledger, 1 matched');
  });

  it('refuses to build when the ledger is missing', () => {
    const { dir } = fixtureRepo();
    fs.rmSync(path.join(dir, 'meta/retractions.jsonl'));
    expect(build(dir).status).not.toBe(0);
  });

  it('says why it refused', () => {
    const { dir } = fixtureRepo();
    fs.rmSync(path.join(dir, 'meta/retractions.jsonl'));
    expect(build(dir).stderr).toContain('meta/retractions.jsonl is missing');
  });

  it('refuses to build on a malformed ledger line', () => {
    const { dir } = fixtureRepo();
    fs.writeFileSync(path.join(dir, 'meta/retractions.jsonl'), 'not json\n');
    expect(build(dir).status).not.toBe(0);
  });
}, TIMEOUT_MS);
