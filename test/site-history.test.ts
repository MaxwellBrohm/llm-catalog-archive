import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from '../src/git.js';
import {
  isArtifactPath,
  parseLog,
  parseNameStatus,
  readChangeRecords,
  sidecarViewFrom,
} from '../src/site/history.js';

const US = '\u001f';

let repo: string;
const temps: string[] = [];

beforeAll(() => {
  // Same hygiene as test/git.test.ts: src/git.ts spawns git with the ambient
  // environment, and an inherited GIT_DIR aims every temp repo at the real one.
  process.env['GIT_CONFIG_GLOBAL'] = '/dev/null';
  process.env['GIT_CONFIG_SYSTEM'] = '/dev/null';
  delete process.env['GIT_DIR'];
  delete process.env['GIT_WORK_TREE'];
  delete process.env['GIT_INDEX_FILE'];
  delete process.env['GIT_OBJECT_DIRECTORY'];
  delete process.env['GIT_ALTERNATE_OBJECT_DIRECTORIES'];
});

afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function write(dir: string, rel: string, contents: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

function commit(dir: string, paths: string[], message: string): string {
  git(['add', '--', ...paths], dir);
  git(['commit', '-q', '-m', message, '--', ...paths], dir);
  return git(['rev-parse', 'HEAD'], dir).stdout.trim();
}

const sidecarJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify(
    {
      // Deliberately NOT equal to observed_at. They are the same value in
      // every real sidecar, which is exactly why a test using the same value
      // twice cannot tell `observed_at` from its `fetchedAt` fallback.
      fetchedAt: '2001-01-01T00:00:00.000Z',
      finalUrl: 'https://developers.openai.com/api/docs/llms.txt',
      userAgent: 'llm-catalog-archive/1.0',
      status: 200,
      etag: null,
      lastModified: null,
      date: 'Fri, 28 Aug 2026 11:23:40 GMT',
      age: '11718',
      cacheControl: 'public, max-age=0, must-revalidate',
      cfCacheStatus: null,
      contentEncoding: 'br',
      contentLength: null,
      observed_at: '2026-08-28T11:23:40.960Z',
      origin_date: '2026-08-28T08:08:22.000Z',
      ...over,
    },
    null,
    2,
  ) + '\n';

/**
 * Two commits on one source: a first capture and a later change, each with the
 * sidecar the collector writes beside the body in the same commit. The second
 * sidecar carries a DIFFERENT origin_date, which is what makes "read the
 * sidecar at that commit" a claim the tests can distinguish from "read HEAD".
 */
let first: string;
let second: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-site-'));
  temps.push(repo);
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);

  write(repo, 'raw/openai-llms-txt/response.txt', 'one\ntwo\nthree\n');
  write(repo, 'raw/openai-llms-txt/headers.json', sidecarJson({ origin_date: '2026-08-26T20:25:00.000Z' }));
  first = commit(repo, ['raw/openai-llms-txt/response.txt', 'raw/openai-llms-txt/headers.json'], 'openai-llms-txt: changed (14 bytes, HTTP 200)');

  write(repo, 'meta/status.json', '{}\n');
  commit(repo, ['meta/status.json'], 'status: daily heartbeat 2026-08-27');

  // A different length from the first capture on purpose: equal sizes would
  // leave `git cat-file -s <sha>:<path>` and `... HEAD:<path>` indistinguishable.
  write(repo, 'raw/openai-llms-txt/response.txt', 'one\nTWOO\nthree\n');
  write(repo, 'raw/openai-llms-txt/headers.json', sidecarJson());
  second = commit(repo, ['raw/openai-llms-txt/response.txt', 'raw/openai-llms-txt/headers.json'], 'openai-llms-txt: changed (14 bytes, HTTP 200)');
});

describe('parseLog', () => {
  it('splits a sha from its subject at the unit separator', () => {
    expect(parseLog(`abc123${US}openai-llms-txt: changed (1 bytes, HTTP 200)\n`)).toEqual([
      { sha: 'abc123', subject: 'openai-llms-txt: changed (1 bytes, HTTP 200)' },
    ]);
  });

  it('keeps a subject that contains its own colons and parentheses', () => {
    expect(parseLog(`abc${US}a: b (c) d\n`)[0]?.subject).toBe('a: b (c) d');
  });

  it('reads every line', () => {
    expect(parseLog(`a${US}one\nb${US}two\n`)).toHaveLength(2);
  });

  it('reads nothing from empty output', () => {
    expect(parseLog('')).toEqual([]);
  });

  // A line with no separator is not half a record: it is not a record. Taking
  // the whole line as a sha would send a bogus ref into `git show`.
  it('skips a line carrying no separator', () => {
    expect(parseLog('a line with no separator\n')).toEqual([]);
  });

  it('keeps an empty subject rather than dropping the commit', () => {
    expect(parseLog(`abc${US}\n`)).toEqual([{ sha: 'abc', subject: '' }]);
  });
});

describe('parseNameStatus', () => {
  it('reads a modification', () => {
    expect(parseNameStatus('M\traw/x/response.txt\n')).toEqual([{ status: 'M', path: 'raw/x/response.txt' }]);
  });

  it('reads an addition', () => {
    expect(parseNameStatus('A\traw/x/response.txt\n')).toEqual([{ status: 'A', path: 'raw/x/response.txt' }]);
  });

  it('reads both files of a collector commit', () => {
    expect(parseNameStatus('M\traw/x/response.txt\nM\traw/x/headers.json\n')).toHaveLength(2);
  });

  it('takes the destination path of a rename', () => {
    expect(parseNameStatus('R100\traw/old/response.txt\traw/new/response.txt\n')[0]?.path).toBe(
      'raw/new/response.txt',
    );
  });

  it('reads nothing from empty output', () => {
    expect(parseNameStatus('\n\n')).toEqual([]);
  });

  // A status with no path is not an entry. Without this the status letter is
  // taken as the path and the site tries to diff a file called "M".
  it('skips a line carrying a status and no path', () => {
    expect(parseNameStatus('M\n')).toEqual([]);
  });

  it('skips a whitespace-only line', () => {
    expect(parseNameStatus('   \n')).toEqual([]);
  });
});

describe('isArtifactPath', () => {
  it('accepts a stored response body', () => {
    expect(isArtifactPath('raw/openai-llms-txt/response.txt')).toBe(true);
  });

  it('rejects the sidecar, which is evidence about an artifact rather than one', () => {
    expect(isArtifactPath('raw/openai-llms-txt/headers.json')).toBe(false);
  });

  it('rejects collector state under meta/', () => {
    expect(isArtifactPath('meta/status.json')).toBe(false);
  });

  it('rejects a third-party import under backfill/, which R6 keeps separate', () => {
    expect(isArtifactPath('backfill/kj-9-openrouter/models.json')).toBe(false);
  });
});

describe('sidecarViewFrom', () => {
  it('reads origin_date out of the committed sidecar', () => {
    expect(sidecarViewFrom(JSON.parse(sidecarJson()))?.originDate).toBe('2026-08-28T08:08:22.000Z');
  });

  it('reads observed_at out of the committed sidecar', () => {
    expect(sidecarViewFrom(JSON.parse(sidecarJson()))?.observedAt).toBe('2026-08-28T11:23:40.960Z');
  });

  it('falls back to fetchedAt when observed_at is absent, as the earliest sidecars are', () => {
    const legacy = { fetchedAt: '2026-08-26T20:25:41.138Z', origin_date: null };
    expect(sidecarViewFrom(legacy)?.observedAt).toBe('2026-08-26T20:25:41.138Z');
  });

  it('falls back to fetchedAt when observed_at is present but not a string', () => {
    expect(sidecarViewFrom(JSON.parse(sidecarJson({ observed_at: 7 })))?.observedAt).toBe('2001-01-01T00:00:00.000Z');
  });

  it('reads a null origin_date as null rather than as a string', () => {
    expect(sidecarViewFrom(JSON.parse(sidecarJson({ origin_date: null })))?.originDate).toBeNull();
  });

  it('reads the numeric status', () => {
    expect(sidecarViewFrom(JSON.parse(sidecarJson()))?.status).toBe(200);
  });

  it('reads the etag', () => {
    expect(sidecarViewFrom(JSON.parse(sidecarJson({ etag: 'W/"abc"' })))?.etag).toBe('W/"abc"');
  });

  it('rejects a non-object', () => {
    expect(sidecarViewFrom('not a sidecar')).toBeNull();
  });

  // typeof null is 'object', so this is not the same claim as the one above.
  it('rejects null', () => {
    expect(sidecarViewFrom(null)).toBeNull();
  });

  it('reads a non-string etag as null rather than leaking a number onto a page', () => {
    expect(sidecarViewFrom(JSON.parse(sidecarJson({ etag: 42 })))?.etag).toBeNull();
  });

  it('prefers observed_at over fetchedAt when both are present', () => {
    expect(sidecarViewFrom(JSON.parse(sidecarJson()))?.observedAt).toBe('2026-08-28T11:23:40.960Z');
  });

  it('rejects an array', () => {
    expect(sidecarViewFrom([])).toBeNull();
  });

  // Every field against its own key, in one assertion. A field map is exactly
  // the thing that is right in the first entry and reading the wrong key in the
  // ninth, and the four sampled fields above cannot see that.
  it('maps every spec section 9 header to its own key', () => {
    expect(sidecarViewFrom(JSON.parse(sidecarJson({ etag: 'W/"abc"', lastModified: 'Thu, 27 Aug 2026 10:00:00 GMT', cfCacheStatus: 'HIT', contentLength: '4242' })))).toEqual({
      observedAt: '2026-08-28T11:23:40.960Z',
      originDate: '2026-08-28T08:08:22.000Z',
      status: 200,
      finalUrl: 'https://developers.openai.com/api/docs/llms.txt',
      etag: 'W/"abc"',
      lastModified: 'Thu, 27 Aug 2026 10:00:00 GMT',
      date: 'Fri, 28 Aug 2026 11:23:40 GMT',
      age: '11718',
      cacheControl: 'public, max-age=0, must-revalidate',
      cfCacheStatus: 'HIT',
      contentEncoding: 'br',
      contentLength: '4242',
    });
  });

  it('reads a non-numeric status as null rather than as a string', () => {
    expect(sidecarViewFrom(JSON.parse(sidecarJson({ status: '200' })))?.status).toBeNull();
  });
});

describe('readChangeRecords', () => {
  it('returns one record per commit that changed a stored artifact', () => {
    expect(readChangeRecords(repo)).toHaveLength(2);
  });

  it('leaves the status-only heartbeat commit out', () => {
    expect(readChangeRecords(repo).map((r) => r.subject)).not.toContain('status: daily heartbeat 2026-08-27');
  });

  it('returns the newest commit first, as git log does', () => {
    expect(readChangeRecords(repo)[0]?.sha).toBe(second);
  });

  it('carries the full 40 character sha', () => {
    expect(readChangeRecords(repo)[0]?.sha).toHaveLength(40);
  });

  it('carries the collector commit subject verbatim', () => {
    expect(readChangeRecords(repo)[0]?.subject).toBe('openai-llms-txt: changed (14 bytes, HTTP 200)');
  });

  it('records the body but not the sidecar as the changed artifact', () => {
    expect(readChangeRecords(repo)[0]?.artifacts.map((a) => a.path)).toEqual(['raw/openai-llms-txt/response.txt']);
  });

  it('reads the source id off the path', () => {
    expect(readChangeRecords(repo)[0]?.artifacts[0]?.sourceId).toBe('openai-llms-txt');
  });

  it('calls the first capture added', () => {
    expect(readChangeRecords(repo)[1]?.artifacts[0]?.kind).toBe('added');
  });

  it('calls the later capture modified', () => {
    expect(readChangeRecords(repo)[0]?.artifacts[0]?.kind).toBe('modified');
  });

  it('counts the added lines of the later capture', () => {
    expect(readChangeRecords(repo)[0]?.artifacts[0]?.linesAdded).toBe(1);
  });

  it('counts the removed lines of the later capture', () => {
    expect(readChangeRecords(repo)[0]?.artifacts[0]?.linesRemoved).toBe(1);
  });

  it('measures the artifact size at the later commit', () => {
    expect(readChangeRecords(repo)[0]?.artifacts[0]?.bytes).toBe(15);
  });

  it('measures the artifact size at the first commit, not at HEAD', () => {
    expect(readChangeRecords(repo)[1]?.artifacts[0]?.bytes).toBe(14);
  });

  // The point of the whole module: the sidecar is read at the commit, not at
  // HEAD, so the first capture keeps the origin_date it was captured with even
  // though a later commit overwrote that file in place.
  it('reads the sidecar as it was at the first commit, not as it is at HEAD', () => {
    expect(readChangeRecords(repo)[1]?.artifacts[0]?.sidecar?.originDate).toBe('2026-08-26T20:25:00.000Z');
  });

  it('reads the sidecar as it was at the later commit', () => {
    expect(readChangeRecords(repo)[0]?.artifacts[0]?.sidecar?.originDate).toBe('2026-08-28T08:08:22.000Z');
  });

  it('carries the parsed diff of the change', () => {
    const line = readChangeRecords(repo)[0]?.artifacts[0]?.diff.find((l) => l.kind === 'add');
    expect(line?.text).toBe('TWOO');
  });

  it('attaches a retraction that names the commit', () => {
    const rows = [{ sha: second, path: null, reason: 'test fixture' }];
    expect(readChangeRecords(repo, rows)[0]?.retraction).toEqual({ sha: second, path: null, reason: 'test fixture' });
  });

  it('leaves an unnamed commit unretracted', () => {
    const rows = [{ sha: second, path: null, reason: 'test fixture' }];
    expect(readChangeRecords(repo, rows)[1]?.retraction).toBeNull();
  });

  it('renders a retracted change rather than dropping it from the list', () => {
    const rows = [{ sha: second, path: null, reason: 'test fixture' }];
    expect(readChangeRecords(repo, rows).map((r) => r.sha)).toEqual([second, first]);
  });

  it('reports no records for a repository with no raw/ history', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-empty-'));
    temps.push(empty);
    git(['init', '-q', '-b', 'main'], empty);
    git(['config', 'user.email', 'test@example.com'], empty);
    git(['config', 'user.name', 'Test'], empty);
    write(empty, 'meta/status.json', '{}\n');
    commit(empty, ['meta/status.json'], 'status: first');
    expect(readChangeRecords(empty)).toEqual([]);
  });

  it('ignores a commit that deleted an artifact, which R7 forbids anyway', () => {
    const before = readChangeRecords(repo).length;
    fs.rmSync(path.join(repo, 'raw/openai-llms-txt/response.txt'));
    git(['rm', '-q', '--cached', '--', 'raw/openai-llms-txt/response.txt'], repo);
    git(['commit', '-q', '-m', 'removed'], repo);
    expect(readChangeRecords(repo)).toHaveLength(before);
  });

  it('records no sidecar when none was committed beside the artifact', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-bare-sc-'));
    temps.push(bare);
    git(['init', '-q', '-b', 'main'], bare);
    git(['config', 'user.email', 'test@example.com'], bare);
    git(['config', 'user.name', 'Test'], bare);
    write(bare, 'raw/openai-llms-txt/response.txt', 'only a body\n');
    commit(bare, ['raw/openai-llms-txt/response.txt'], 'openai-llms-txt: changed (12 bytes, HTTP 200)');
    expect(readChangeRecords(bare)[0]?.artifacts[0]?.sidecar).toBeNull();
  });

  it('records no sidecar when the committed one is not valid JSON', () => {
    write(repo, 'raw/openai-llms-txt/response.txt', 'one\nTHREE\nthree\n');
    write(repo, 'raw/openai-llms-txt/headers.json', 'not json\n');
    commit(repo, ['raw/openai-llms-txt/response.txt', 'raw/openai-llms-txt/headers.json'], 'openai-llms-txt: changed');
    expect(readChangeRecords(repo)[0]?.artifacts[0]?.sidecar).toBeNull();
  });

  it('throws rather than reporting an empty archive when git cannot be read', () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-notgit-'));
    temps.push(notARepo);
    expect(() => readChangeRecords(notARepo)).toThrow('git log failed');
  });

  it('ignores a commit that touched only the sidecar', () => {
    write(repo, 'raw/openai-llms-txt/headers.json', sidecarJson({ etag: 'W/"changed"' }));
    commit(repo, ['raw/openai-llms-txt/headers.json'], 'sidecar only');
    expect(readChangeRecords(repo)).toHaveLength(2);
  });
});
