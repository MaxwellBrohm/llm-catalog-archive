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
  fs.writeFileSync(path.join(dir, 'meta/leaks-ledger.jsonl'), '');

  // The real repository keeps its specs under docs/, and the generator used to
  // write a .nojekyll in there. A fixture with no docs/ cannot tell a generator
  // that has stopped writing outside its output directory from one whose write
  // simply crashes on a missing directory, so the fixture has one.
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/spec.md'), '# spec\n');

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
  run(dir, ['add', '--', 'raw/openai-llms-txt', 'meta/retractions.jsonl', 'meta/leaks-ledger.jsonl', 'docs/spec.md']);
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

  it('writes the index page into build/site', () => {
    const { dir } = fixtureRepo();
    build(dir);
    expect(fs.existsSync(path.join(dir, 'build/site/index.html'))).toBe(true);
  });

  it('writes .nojekyll beside it', () => {
    const { dir } = fixtureRepo();
    build(dir);
    expect(fs.existsSync(path.join(dir, 'build/site/.nojekyll'))).toBe(true);
  });

  /**
   * three.js belongs to the GENERATOR, not to the archive it is pointed at, and
   * this fixture is the case that tells the two apart: it is a real repository
   * with real commits and no node_modules at all. A vendor step that composed
   * its path out of process.cwd() found nothing here and threw, which took the
   * whole build with it and left build/site/ unwritten. Every other assertion
   * in this file went red at once, which is a loud failure and still not a
   * named one, so these two name it.
   */
  it('vendors the three module beside the page that imports it', () => {
    const { dir } = fixtureRepo();
    build(dir);
    expect(fs.existsSync(path.join(dir, 'build/site/vendor/three.module.min.js'))).toBe(true);
  });

  it('vendors the core chunk that module imports in turn', () => {
    const { dir } = fixtureRepo();
    build(dir);
    expect(fs.existsSync(path.join(dir, 'build/site/vendor/three.core.min.js'))).toBe(true);
  });

  // The build directory IS the deployed root now, so .nojekyll belongs in it
  // and nowhere else. The generator used to write a second copy at docs/, back
  // when Pages published the /docs directory of the branch; that write is gone,
  // and this asserts it stayed gone, because a generator that writes outside
  // its gitignored output directory is how build output gets committed again.
  it('writes nothing outside its output directory', () => {
    const { dir } = fixtureRepo();
    const before = treePaths(dir);
    build(dir);
    expect(treePaths(dir)).toEqual(before);
  });

  it('honours LCA_SITE_URL in the feed', () => {
    const { dir } = fixtureRepo();
    const r = spawnSync('npx', ['tsx', path.join(REPO, 'src/site-cli.ts')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...env, LCA_SITE_URL: 'https://example.test/archive' },
    });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'build/site/feed.xml'), 'utf8')).toContain(
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
    const changes = path.join(dir, 'build/site/changes');
    const names = fs.existsSync(changes) ? fs.readdirSync(changes) : [];
    expect(names).toHaveLength(2);
  });

  it('reports the change count it built from', () => {
    expect(build(fixtureRepo().dir).stdout).toContain('site: 2 changes');
  });

  it('links the raw artifact at the commit sha on the change page', () => {
    const { dir, second } = fixtureRepo();
    build(dir);
    const page = fs.readFileSync(path.join(dir, `build/site/changes/${second}.html`), 'utf8');
    expect(page).toContain(`/blob/${second}/raw/openai-llms-txt/response.txt`);
  });

  it('shows the origin_date stored at that commit, not the one at HEAD', () => {
    const { dir } = fixtureRepo();
    build(dir);
    const dirents = fs.readdirSync(path.join(dir, 'build/site/changes'));
    const pages = dirents.map((f) => fs.readFileSync(path.join(dir, 'build/site/changes', f), 'utf8'));
    expect(pages.some((p) => p.includes('26 August 2026 20:25 UTC'))).toBe(true);
  });
}, TIMEOUT_MS);

describe('site-cli and the retraction ledger', () => {
  it('marks a change whose sha the ledger names', () => {
    const { dir, second } = fixtureRepo();
    fs.writeFileSync(path.join(dir, 'meta/retractions.jsonl'), `{"sha":"${second}","reason":"fixture"}\n`);
    build(dir);
    const page = fs.readFileSync(path.join(dir, `build/site/changes/${second}.html`), 'utf8');
    expect(page).toContain('<span class="badge badge-retracted">retracted</span>');
  });

  it('still writes that page rather than deleting it', () => {
    const { dir, second } = fixtureRepo();
    fs.writeFileSync(path.join(dir, 'meta/retractions.jsonl'), `{"sha":"${second}"}\n`);
    build(dir);
    expect(fs.existsSync(path.join(dir, `build/site/changes/${second}.html`))).toBe(true);
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

/**
 * The accuracy ledger gets the same refusal as the retraction ledger, for the
 * same reason one level over: a desk that published a scorecard it could not
 * read would be reporting an accuracy of "no claims" over claims it simply
 * failed to open, and that is the single number the ledger exists to make
 * honest.
 */
describe('site-cli and the accuracy ledger', () => {
  it('writes the leaks desk', () => {
    const { dir } = fixtureRepo();
    build(dir);
    expect(fs.existsSync(path.join(dir, 'build/site/leaks/index.html'))).toBe(true);
  });

  it('writes the accuracy ledger page', () => {
    const { dir } = fixtureRepo();
    build(dir);
    expect(fs.existsSync(path.join(dir, 'build/site/leaks/ledger.html'))).toBe(true);
  });

  it('reports the leak item count it derived', () => {
    const { dir } = fixtureRepo();
    expect(build(dir).stdout).toMatch(/leaks: \d+ items/);
  });

  it('reports how many ledger claims it read', () => {
    const { dir } = fixtureRepo();
    expect(build(dir).stdout).toContain('0 ledger claim(s)');
  });

  it('refuses to build when the accuracy ledger is missing', () => {
    const { dir } = fixtureRepo();
    fs.rmSync(path.join(dir, 'meta/leaks-ledger.jsonl'));
    expect(build(dir).status).not.toBe(0);
  });

  it('says why it refused', () => {
    const { dir } = fixtureRepo();
    fs.rmSync(path.join(dir, 'meta/leaks-ledger.jsonl'));
    expect(build(dir).stderr).toContain('meta/leaks-ledger.jsonl is missing');
  });

  it('refuses to build on a malformed accuracy-ledger line', () => {
    const { dir } = fixtureRepo();
    fs.writeFileSync(path.join(dir, 'meta/leaks-ledger.jsonl'), 'not json\n');
    expect(build(dir).status).not.toBe(0);
  });
}, TIMEOUT_MS);

/**
 * Every file under `dir`, keyed by its path relative to `dir`, read as bytes.
 * Latin-1 so a byte comparison stays a byte comparison.
 */
function readTree(dir: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dir, entry.name);
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) for (const [k, v] of readTree(abs, rel)) out.set(k, v);
    else out.set(rel, fs.readFileSync(abs, 'latin1'));
  }
  return out;
}

/**
 * The newest `origin_date` fixtureRepo commits. The site is built only from
 * committed sidecars, so no page it renders may carry a date after this one:
 * anything later can only have come from the wall clock.
 */
const NEWEST_FIXTURE_DAY = '2026-08-28';

describe('site-cli determinism', () => {
  // Two full runs, seconds apart because each one spawns tsx and shells out to
  // git per commit. A generator that stamped `new Date()` anywhere would
  // differ between them.
  it('produces byte-identical output on a second run over the same history', () => {
    const { dir } = fixtureRepo();
    build(dir);
    const first = readTree(path.join(dir, 'build/site'));
    build(dir);
    expect([...readTree(path.join(dir, 'build/site'))]).toEqual([...first]);
  });

  // A clock at day resolution survives the comparison above whenever both runs
  // land on the same day, which is always. This is the check that catches it:
  // today is later than every date the fixture commits, so a rendered "now" of
  // any resolution shows up here as a date the archive never observed.
  it('renders no date later than the newest one committed to the fixture', () => {
    const { dir } = fixtureRepo();
    build(dir);
    const dates: string[] = [];
    for (const [rel, body] of readTree(path.join(dir, 'build/site'))) {
      if (!rel.endsWith('.html') && !rel.endsWith('.xml')) continue;
      for (const m of body.matchAll(/\d{4}-\d{2}-\d{2}/g)) dates.push(m[0]);
    }
    expect(dates.filter((d) => d > NEWEST_FIXTURE_DAY)).toEqual([]);
  });
}, TIMEOUT_MS);

describe('site-cli and the pages that moved', () => {
  it('answers a change page at its old /site/ address', () => {
    const { dir, second } = fixtureRepo();
    build(dir);
    expect(fs.existsSync(path.join(dir, `build/site/site/changes/${second}.html`))).toBe(true);
  });

  it('sends that old address to the same page at its new one', () => {
    const { dir, second } = fixtureRepo();
    build(dir);
    const stub = fs.readFileSync(path.join(dir, `build/site/site/changes/${second}.html`), 'utf8');
    expect(stub).toContain(`<meta http-equiv="refresh" content="0; url=../../changes/${second}.html">`);
  });
}, TIMEOUT_MS);

/** Every path under `dir`, ignoring git's own directory and the build output. */
function treePaths(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (rel === '.git' || rel === 'build') continue;
    out.push(rel);
    if (entry.isDirectory()) out.push(...treePaths(path.join(dir, entry.name), rel));
  }
  return out.sort();
}
