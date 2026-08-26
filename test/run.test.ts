import { describe, it, expect } from 'vitest';
import { runTier, type RunDeps } from '../src/run.js';
import type { Source } from '../src/config.js';
import type { HeaderRecord } from '../src/headers.js';
import { parseStatusFile, shouldCommitStatus, type SourceStatus, type StatusFile } from '../src/status.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) => new TextDecoder().decode(b);

/**
 * A body chosen so that R1 can actually fail here. A leading space, CRLF, a
 * trailing newline, a NUL and a byte that is not valid UTF-8: trimming,
 * re-encoding, EOL normalising or round-tripping through a string all change
 * it. A tidy ASCII fixture survives every one of those and proves nothing.
 */
const BODY = new Uint8Array([...enc(' CANARY\r\nline2\n'), 0x00, 0xff]);
const BODY_BYTES = 17;

/**
 * One fixture is not enough, because a normaliser can gate on contentType and
 * then no `text` body ever reaches it. These two close that family.
 *
 * The JSON body is deliberately VALID and minified with a trailing newline, so
 * that a JSON round trip guarded by try/catch actually runs instead of falling
 * back to the original bytes: `1.50` becomes `1.5`, `\u0041` becomes `A`, and
 * the trailing newline is dropped. Pretty-printing it changes every line. This
 * is the realistic violation, and it would land on openrouter-models, 685 KB of
 * minified JSON and the most-diffed body in the archive.
 */
const JSON_BODY = enc('{"b":1,"a":[2,3],"n":1.50,"u":"\\u0041"}\n');

/** A BOM and CRLF, which is what a BOM strip or an EOL rewrite would eat. */
const XML_BODY = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('<urlset>\r\n<url/>\r\n</urlset>\r\n')]);

const HDR: HeaderRecord = {
  fetchedAt: '2026-08-26T14:00:00.000Z',
  finalUrl: 'https://a.example/f',
  userAgent: 'ua',
  status: 200,
  etag: null,
  lastModified: null,
  date: null,
  age: null,
  cacheControl: null,
  cfCacheStatus: null,
  contentEncoding: null,
  contentLength: null,
};

/**
 * What meta/sources.json really declares for every non-text source. A canary
 * only stands in where "parses as its declared type" would be vacuous, which
 * is text and nothing else.
 */
const NO_CANARY = {
  minBytes: 1,
  requiredKeyPath: null,
  minRecords: null,
  canary: null,
  sizeBand: [0.1, 10],
} as Source['invariants'];

const source = (over: Partial<Source> = {}): Source =>
  ({
    id: 'a',
    url: 'https://a.example/f',
    tier: 'daily',
    path: 'raw/a/response.txt',
    status: 'active',
    contentType: 'text',
    expectedRoot: null,
    invariants: { minBytes: 1, requiredKeyPath: null, minRecords: null, canary: 'CANARY', sizeBand: [0.1, 10] },
    freshness: { kind: 'none', maxQuietDays: null },
    predicate: { type: 'bytes' },
    timeoutS: 5,
    retries: 0,
    maxRedirects: 3,
    rateLimit: { maxAutoEventsPerDay: 8 },
    magnitudeGuard: { maxShrinkPct: 25 },
    notes: '',
    ...over,
  }) as Source;

function deps(over: Partial<RunDeps> = {}, files: Record<string, Uint8Array> = {}) {
  const trace: string[] = [];
  const messages: string[] = [];
  const logs: string[] = [];
  const d: RunDeps = {
    cwd: '/tmp/fake',
    nowIso: () => '2026-08-26T14:00:00.000Z',
    fetchOne: async () => {
      trace.push('fetch');
      return {
        ok: true as const,
        attempts: 1,
        observed: {
          status: 200,
          body: BODY,
          finalUrl: 'https://a.example/f',
          redirectCount: 0,
          headers: {},
        },
        headers: HDR,
      };
    },
    readFile: (p) => files[p] ?? null,
    writeFile: (p, b) => {
      trace.push(`write:${p}`);
      files[p] = b;
    },
    commitPaths: (paths, message) => {
      trace.push(`commit:${paths.join(',')}`);
      messages.push(message);
      return true;
    },
    push: () => {
      trace.push('push');
    },
    log: (line) => {
      logs.push(line);
    },
    ...over,
  };
  return Object.assign(d, { files, trace, messages, logs });
}

/** The sidecar object as it was handed to writeFile, not as buildSidecar returns it. */
function sidecarWritten(files: Record<string, Uint8Array>): Record<string, unknown> {
  return JSON.parse(dec(files['raw/a/headers.json'])) as Record<string, unknown>;
}

/** One source, one body, run to completion. */
async function runOne(s: Source, body: Uint8Array) {
  const d = deps({
    fetchOne: async () => ({
      ok: true as const,
      attempts: 1,
      observed: { status: 200, body, finalUrl: 'https://a.example/f', redirectCount: 0, headers: {} },
      headers: HDR,
    }),
  });
  await runTier([s], 'daily', null, d);
  return d;
}

describe('runTier, minimal', () => {
  it('writes the body verbatim', async () => {
    const d = deps();
    await runTier([source()], 'daily', null, d);
    expect(d.files['raw/a/response.txt']).toEqual(BODY);
  });

  // Byte equality, on a body whose contentType is not `text`. Every other
  // source() in this file is `text`, so without these two a normaliser that
  // gates on contentType is invisible to the whole suite.
  it('writes a json body verbatim, neither pretty-printed nor re-serialised', async () => {
    const d = await runOne(source({ contentType: 'json', path: 'raw/a/response.json', invariants: NO_CANARY }), JSON_BODY);
    expect(d.files['raw/a/response.json']).toEqual(JSON_BODY);
  });

  it('writes an xml body verbatim, keeping its BOM and its CRLFs', async () => {
    const d = await runOne(source({ contentType: 'xml', path: 'raw/a/response.xml', invariants: NO_CANARY }), XML_BODY);
    expect(d.files['raw/a/response.xml']).toEqual(XML_BODY);
  });

  it('commits the body path', async () => {
    const d = deps();
    await runTier([source()], 'daily', null, d);
    expect(d.trace.find((t) => t.startsWith('commit:'))).toContain('raw/a/response.txt');
  });

  it('commits the headers sidecar in the same commit as the body', async () => {
    const d = deps();
    await runTier([source()], 'daily', null, d);
    expect(d.trace.find((t) => t.startsWith('commit:'))).toContain('raw/a/headers.json');
  });

  it('labels the commit with the source, the byte count and the status', async () => {
    const d = deps();
    await runTier([source()], 'daily', null, d);
    expect(d.messages[0]).toBe(`a: changed (${BODY_BYTES} bytes, HTTP 200)`);
  });

  // The whole trace, not the absence of a write. `some(...) === false` is also
  // satisfied by a runTier that returns immediately without fetching anything,
  // and a no-op passed it. This says the fetch happened, no ARTIFACT was
  // written, no artifact was committed, the daily status heartbeat still went
  // out, and the push still ran.
  it('fetches and then writes no artifact when the stored bytes are identical', async () => {
    const d = deps({}, { 'raw/a/response.txt': BODY });
    await runTier([source()], 'daily', null, d);
    expect(d.trace).toEqual(['fetch', 'write:meta/status.json', 'commit:meta/status.json', 'push']);
  });

  it('does not commit an artifact when the stored bytes are identical', async () => {
    const d = deps({}, { 'raw/a/response.txt': BODY });
    await runTier([source()], 'daily', null, d);
    expect(d.trace.filter((t) => t.startsWith('commit:'))).toEqual(['commit:meta/status.json']);
  });

  it('commits when one byte differs at the same length', async () => {
    const d = deps({}, { 'raw/a/response.txt': new Uint8Array([...BODY.slice(0, BODY_BYTES - 1), 0xfe]) });
    await runTier([source()], 'daily', null, d);
    expect(d.trace.some((t) => t.startsWith('commit:'))).toBe(true);
  });

  it('commits when the stored body is a prefix of the new one', async () => {
    const d = deps({}, { 'raw/a/response.txt': BODY.slice(0, BODY_BYTES - 1) });
    await runTier([source()], 'daily', null, d);
    expect(d.trace.some((t) => t.startsWith('commit:'))).toBe(true);
  });

  // The other direction, which is the one a length-blind comparison gets wrong:
  // a body that shrank is equal to its own prefix of the stored bytes, so
  // without the length check a truncation would be recorded as no change.
  it('commits when the new body is a prefix of the stored one', async () => {
    const d = deps({}, { 'raw/a/response.txt': new Uint8Array([...BODY, 0x01]) });
    await runTier([source()], 'daily', null, d);
    expect(d.trace.some((t) => t.startsWith('commit:'))).toBe(true);
  });

  // The three volatile sources ship pending. activeSourcesForTier already
  // filters them, and this is the second lock: under a bytes predicate each
  // would commit a multi-megabyte blob every run into a history R7 forbids
  // rewriting.
  it('does not fetch a source marked pending', async () => {
    const d = deps();
    await runTier([source({ status: 'pending' })], 'daily', null, d);
    expect(d.trace.some((t) => t === 'fetch')).toBe(false);
  });

  it('does not commit a source marked pending', async () => {
    const d = deps();
    await runTier([source({ status: 'pending' })], 'daily', null, d);
    expect(d.trace.filter((t) => t.startsWith('commit:'))).toEqual(['commit:meta/status.json']);
  });

  it('says which source it skipped and why', async () => {
    const d = deps();
    await runTier([source({ status: 'pending' })], 'daily', null, d);
    expect(d.logs).toContain('a: pending, skipped');
  });

  it('still fetches the active source standing next to a pending one', async () => {
    const d = deps();
    await runTier([source({ status: 'pending' }), source({ id: 'b', path: 'raw/b/response.txt' })], 'daily', null, d);
    expect(d.files['raw/b/response.txt']).toEqual(BODY);
  });

  it('one throwing source does not stop the others', async () => {
    let n = 0;
    const d = deps({
      fetchOne: async () => {
        n++;
        if (n === 1) throw new Error('boom');
        return {
          ok: true as const,
          attempts: 1,
          observed: {
            status: 200,
            body: enc('CANARY\nb'),
            finalUrl: 'https://b.example/f',
            redirectCount: 0,
            headers: {},
          },
          headers: HDR,
        };
      },
    });
    await runTier(
      [source({ id: 'a' }), source({ id: 'b', url: 'https://b.example/f', path: 'raw/b/response.txt' })],
      'daily',
      null,
      d,
    );
    expect(d.files['raw/b/response.txt']).toEqual(enc('CANARY\nb'));
  });

  it('reports what a throwing source threw', async () => {
    const d = deps({
      fetchOne: async () => {
        throw new Error('boom');
      },
    });
    await runTier([source()], 'daily', null, d);
    expect(d.logs).toContain('a: threw: boom');
  });

  it('does not write a source whose fetch reported failure', async () => {
    const d = deps({ fetchOne: async () => ({ ok: false as const, error: 'status 503', attempts: 3 }) });
    await runTier([source()], 'daily', null, d);
    expect(d.trace.filter((t) => t.startsWith('write:'))).toEqual(['write:meta/status.json']);
  });

  it('does not commit a source whose fetch reported failure', async () => {
    const d = deps({ fetchOne: async () => ({ ok: false as const, error: 'status 503', attempts: 3 }) });
    await runTier([source()], 'daily', null, d);
    expect(d.trace.filter((t) => t.startsWith('commit:'))).toEqual(['commit:meta/status.json']);
  });

  it('reports the failure a fetch gave up on', async () => {
    const d = deps({ fetchOne: async () => ({ ok: false as const, error: 'status 503', attempts: 3 }) });
    await runTier([source()], 'daily', null, d);
    expect(d.logs).toContain('a: fetch failed after 3 attempts: status 503');
  });

  it('pushes once', async () => {
    const d = deps();
    await runTier([source(), source({ id: 'b', path: 'raw/b/response.txt' })], 'daily', null, d);
    expect(d.trace.filter((t) => t === 'push')).toHaveLength(1);
  });

  it('pushes after the commits, not between them', async () => {
    const d = deps();
    await runTier([source(), source({ id: 'b', path: 'raw/b/response.txt' })], 'daily', null, d);
    expect(d.trace.lastIndexOf('push')).toBeGreaterThan(d.trace.findLastIndex((t) => t.startsWith('commit:')));
  });

  it('exits zero', async () => {
    const d = deps();
    const r = await runTier([source()], 'daily', null, d);
    expect(r.exitCode).toBe(0);
  });

  it('names the changed source in the trace it returns', async () => {
    const d = deps();
    const r = await runTier([source()], 'daily', null, d);
    expect(r.trace).toEqual(['changed:a']);
  });
});

/**
 * The invariant asserted against the bytes handed to writeFile, not against
 * buildSidecar in isolation. An earlier revision of this plan wrote the
 * observed_at/origin_date mapping in Task 11's runTier only, so every commit
 * from go-live until then would have carried a sidecar permanently missing
 * origin_date, and a test of buildSidecar alone would have passed throughout.
 */
describe('the sidecar runTier writes', () => {
  const withOrigin = {
    ...HDR,
    date: 'Tue, 26 Aug 2026 14:00:00 GMT',
    age: '600',
    etag: 'W/"abc123"',
  } satisfies HeaderRecord;

  const runWith = async (headers: HeaderRecord) => {
    const d = deps({
      fetchOne: async () => ({
        ok: true as const,
        attempts: 1,
        observed: {
          status: 200,
          body: BODY,
          finalUrl: 'https://a.example/f',
          redirectCount: 0,
          headers: {},
        },
        headers,
      }),
    });
    await runTier([source()], 'daily', null, d);
    return d;
  };

  it('carries observed_at', async () => {
    const d = await runWith(withOrigin);
    expect(sidecarWritten(d.files)['observed_at']).toBe('2026-08-26T14:00:00.000Z');
  });

  it('carries origin_date, date minus age', async () => {
    const d = await runWith(withOrigin);
    expect(sidecarWritten(d.files)['origin_date']).toBe('2026-08-26T13:50:00.000Z');
  });

  it('carries origin_date as null when the origin cannot be determined', async () => {
    const d = await runWith(HDR);
    expect(sidecarWritten(d.files)['origin_date']).toBeNull();
  });

  it('still carries the origin_date key when it is null', async () => {
    const d = await runWith(HDR);
    expect('origin_date' in sidecarWritten(d.files)).toBe(true);
  });

  it('keeps the captured header record beside the derived timestamps', async () => {
    const d = await runWith(withOrigin);
    expect(sidecarWritten(d.files)['etag']).toBe('W/"abc123"');
  });

  it('ends with a newline, so the file is a well-formed text line', async () => {
    const d = await runWith(withOrigin);
    expect(dec(d.files['raw/a/headers.json']).endsWith('\n')).toBe(true);
  });
});

/**
 * The health gate at its call site.
 *
 * A guard that exists but is never called protects nothing, and this collector
 * ran live and unguarded until these tests existed. Every claim here is about
 * `runTier`, not about `checkHealth`: the module has its own suite, and an
 * earlier revision of this plan would have shipped a fully tested health module
 * that `runTier` never consulted.
 */
describe('runTier consults the health gate before it writes', () => {
  const feedSource = (over: Partial<Source> = {}): Source =>
    source({
      contentType: 'xml',
      path: 'raw/a/response.atom',
      expectedRoot: 'feed',
      invariants: NO_CANARY,
      freshness: { kind: 'feed', maxQuietDays: 7 },
      ...over,
    });

  /** Carries the canary, so only the interstitial denylist can reject it. */
  const CHALLENGE = enc('CANARY\n<title>Just a moment...</title>\n__CF$cv$params\n');
  const LAST_GOOD = enc('CANARY\nthe bytes that were good\n');

  const feedDated = (iso: string) =>
    enc(`<?xml version="1.0"?>\n<feed><entry><id>1</id><updated>${iso}</updated></entry></feed>\n`);

  const runWith = async (s: Source, body: Uint8Array, files: Record<string, Uint8Array>, over: Partial<RunDeps> = {}) => {
    const d = deps(
      {
        fetchOne: async () => {
          d.trace.push('fetch');
          return {
            ok: true as const,
            attempts: 1,
            observed: { status: 200, body, finalUrl: s.url, redirectCount: 0, headers: {} },
            headers: HDR,
          };
        },
        ...over,
      },
      files,
    );
    await runTier([s], 'daily', null, d);
    return d;
  };

  // The whole trace, not the absence of a write: `some(...) === false` is also
  // satisfied by a runTier that returns without fetching anything.
  it('fetches an interstitial and then writes and commits nothing but the heartbeat', async () => {
    const d = await runWith(source(), CHALLENGE, { 'raw/a/response.txt': LAST_GOOD });
    expect(d.trace).toEqual(['fetch', 'write:meta/status.json', 'commit:meta/status.json', 'push']);
  });

  // The claim the whole task exists for.
  it('leaves the last-good bytes on disk untouched when a challenge page arrives at 200', async () => {
    const d = await runWith(source(), CHALLENGE, { 'raw/a/response.txt': LAST_GOOD });
    expect(d.files['raw/a/response.txt']).toEqual(LAST_GOOD);
  });

  it('says which check refused the write', async () => {
    const d = await runWith(source(), CHALLENGE, { 'raw/a/response.txt': LAST_GOOD });
    expect(d.logs).toContain('a: failed, not written: interstitial marker present: __CF$cv$params');
  });

  it('records the refusal in the trace it returns', async () => {
    const d = deps(
      {
        fetchOne: async () => ({
          ok: true as const,
          attempts: 1,
          observed: { status: 200, body: CHALLENGE, finalUrl: 'https://a.example/f', redirectCount: 0, headers: {} },
          headers: HDR,
        }),
      },
      { 'raw/a/response.txt': LAST_GOOD },
    );
    const r = await runTier([source()], 'daily', null, d);
    expect(r.trace).toEqual(['failed:a']);
  });

  it('writes nothing for a source with no stored artifact at all rather than creating a bad one', async () => {
    const d = await runWith(source(), CHALLENGE, {});
    expect(d.files['raw/a/response.txt']).toBeUndefined();
  });

  const twoSources = async () => {
    const bodies: Uint8Array[] = [CHALLENGE, enc('CANARY\nb is fine\n')];
    let n = 0;
    const d = deps({
      fetchOne: async (s) => ({
        ok: true as const,
        attempts: 1,
        observed: { status: 200, body: bodies[n++]!, finalUrl: s.url, redirectCount: 0, headers: {} },
        headers: HDR,
      }),
    });
    await runTier([source(), source({ id: 'b', path: 'raw/b/response.txt' })], 'daily', null, d);
    return d;
  };

  it('keeps collecting the next source after one fails health', async () => {
    const d = await twoSources();
    expect(d.files['raw/b/response.txt']).toEqual(enc('CANARY\nb is fine\n'));
  });

  // The sibling that makes the one above mean what its name says. On its own
  // it passes with checkHealth stubbed to always return ok, because b gets
  // written either way and nothing there ever checks that a was refused.
  it('and the source that failed health wrote nothing', async () => {
    const d = await twoSources();
    expect(d.files['raw/a/response.txt']).toBeUndefined();
  });

  it('does not write a stale feed', async () => {
    const d = await runWith(feedSource(), feedDated('2026-01-01T00:00:00Z'), {});
    expect(d.trace).toEqual(['fetch', 'write:meta/status.json', 'commit:meta/status.json', 'push']);
  });

  // Stale is not failed, and the log has to say so, because this is the line an
  // operator reads before deciding whether anything is broken.
  it('reports a quiet feed as stale rather than as failed', async () => {
    // A prior artifact, because `stale` now requires one: a source that has
    // never archived anything is broken rather than quiet, and saying so
    // loudly is the only thing that stops it going silent for ever.
    const d = await runWith(feedSource(), feedDated('2026-01-01T00:00:00Z'), {
      'raw/a/response.atom': feedDated('2025-12-01T00:00:00Z'),
    });
    expect(d.logs).toContain('a: stale, not written: newest item 238 days old, limit 7');
  });

  it('fails a quiet feed that has never archived anything, rather than going quietly silent', async () => {
    const d = await runWith(feedSource(), feedDated('2026-01-01T00:00:00Z'), {});
    expect(d.logs).toContain(
      'a: failed, not written: newest item 238 days old, limit 7, and no previous snapshot exists to be quiet against',
    );
  });

  // The band is a ratio against the stored artifact. If runTier passed a
  // hardcoded null the band could never fire, which is a guard spelled to look
  // configured. These two differ only in the size of the file already on disk.
  it('writes a body that sits inside the band around the stored size', async () => {
    const s = source({ invariants: { ...source().invariants, sizeBand: [0.5, 2.0] } });
    const d = await runWith(s, BODY, { 'raw/a/response.txt': new Uint8Array(16).fill(1) });
    expect(d.files['raw/a/response.txt']).toEqual(BODY);
  });

  it('refuses a body that sits outside the band around the stored size', async () => {
    const s = source({ invariants: { ...source().invariants, sizeBand: [0.5, 2.0] } });
    const stored = new Uint8Array(4).fill(1);
    const d = await runWith(s, BODY, { 'raw/a/response.txt': stored });
    expect(d.files['raw/a/response.txt']).toEqual(stored);
  });

  // The freshness window is measured against the run clock, not against the
  // wall clock. These two differ only in what nowIso returns.
  it('writes a feed that is fresh at the run clock', async () => {
    const d = await runWith(feedSource(), feedDated('2026-08-20T00:00:00Z'), {});
    expect(d.files['raw/a/response.atom']).toEqual(feedDated('2026-08-20T00:00:00Z'));
  });

  it('refuses the same feed once the run clock has passed the quiet limit', async () => {
    const d = await runWith(feedSource(), feedDated('2026-08-20T00:00:00Z'), {}, {
      nowIso: () => '2026-09-30T00:00:00.000Z',
    });
    expect(d.files['raw/a/response.atom']).toBeUndefined();
  });

  /**
   * The pin for "health check BEFORE the change predicate". That ordering is
   * observable in a RETURN VALUE, not only in a log line: for a response whose
   * bytes are unchanged, the shipped order returns `['stale:a']` and the
   * swapped order returns `[]`, because the predicate short-circuits before
   * the verdict is ever computed.
   *
   * Not hypothetical. `modelsdev-commits` carries `maxQuietDays: 7`, and a
   * genuinely quiet week serves byte-identical bytes, so this ordering is the
   * only reason a quiet source is visible to the run at all.
   */
  it('reports a stale verdict for a source whose bytes did not change', async () => {
    const body = feedDated('2026-01-01T00:00:00Z');
    const d = deps(
      {
        fetchOne: async (s) => ({
          ok: true as const,
          attempts: 1,
          observed: { status: 200, body, finalUrl: s.url, redirectCount: 0, headers: {} },
          headers: HDR,
        }),
      },
      { 'raw/a/response.atom': body },
    );
    const r = await runTier([feedSource()], 'daily', null, d);
    expect(r.trace).toEqual(['stale:a']);
  });

  it('writes a relocated source, because the bytes are good and the url is not', async () => {
    const d = deps({
      fetchOne: async () => ({
        ok: true as const,
        attempts: 1,
        observed: { status: 200, body: BODY, finalUrl: 'https://moved.example/f', redirectCount: 1, headers: {} },
        headers: HDR,
      }),
    });
    await runTier([source()], 'daily', null, d);
    expect(d.files['raw/a/response.txt']).toEqual(BODY);
  });

  it('says where a relocated source has moved to', async () => {
    const d = deps({
      fetchOne: async () => ({
        ok: true as const,
        attempts: 1,
        observed: { status: 200, body: BODY, finalUrl: 'https://moved.example/f', redirectCount: 1, headers: {} },
        headers: HDR,
      }),
    });
    await runTier([source()], 'daily', null, d);
    expect(d.logs).toContain('a: relocated, final url is https://moved.example/f, declared https://a.example/f');
  });

  it('refuses a non-2xx body that the fetch layer handed up as a success', async () => {
    const d = deps(
      {
        fetchOne: async () => ({
          ok: true as const,
          attempts: 1,
          observed: { status: 404, body: BODY, finalUrl: 'https://a.example/f', redirectCount: 0, headers: {} },
          headers: HDR,
        }),
      },
      { 'raw/a/response.txt': LAST_GOOD },
    );
    await runTier([source()], 'daily', null, d);
    expect(d.files['raw/a/response.txt']).toEqual(LAST_GOOD);
  });
});

/**
 * The status store at its call site.
 *
 * GitHub disables a scheduled workflow after 60 days of repository inactivity,
 * and under commit-only-on-change a dead collector stops committing, which IS
 * that inactivity. The counter that detects the death lives only in the
 * committed file, because the runner is ephemeral, so every claim here is about
 * what `runTier` COMMITS and returns, not about what `src/status.ts` computes.
 * The module has its own suite; a module that is never called protects nothing.
 */
describe('runTier keeps the status file, which is the only place a counter survives', () => {
  const statusWritten = (files: Record<string, Uint8Array>): StatusFile =>
    JSON.parse(dec(files['meta/status.json'])) as StatusFile;

  const entry = (over: Partial<SourceStatus> = {}): SourceStatus => ({
    lastAttemptAt: '2026-08-25T14:00:00.000Z',
    lastSuccessAt: '2026-08-25T14:00:00.000Z',
    lastChangeAt: null,
    consecutiveFailures: 0,
    failing: false,
    health: 'ok',
    httpStatus: 200,
    bytes: BODY_BYTES,
    originDate: null,
    held: null,
    ...over,
  });

  const committed = (sources: Record<string, SourceStatus>): StatusFile => ({
    version: 1,
    updatedAt: '2026-08-25T14:00:00.000Z',
    sources,
  });

  const unreachable = () => ({ fetchOne: async () => ({ ok: false as const, error: 'ECONNRESET', attempts: 3 }) });

  // The defect that made the alert eight days late. Revision 1 committed on
  // transitions only, so the run that computed 2 never wrote it and the next
  // run read 1 again.
  it('advances the counter from the committed copy rather than from zero', async () => {
    const d = deps(unreachable());
    const r = await runTier([source()], 'daily', committed({ a: entry({ consecutiveFailures: 1, health: 'failed' }) }), d);
    expect(r.status?.sources['a']?.consecutiveFailures).toBe(2);
  });

  // The half that matters. A counter that advances in memory and is not written
  // dies with the runner, which is the whole bug.
  it('writes the advanced counter into the file it commits', async () => {
    const d = deps(unreachable());
    await runTier([source()], 'daily', committed({ a: entry({ consecutiveFailures: 1, health: 'failed' }) }), d);
    expect(statusWritten(d.files).sources['a']?.consecutiveFailures).toBe(2);
  });

  it('resets the counter when the source comes back', async () => {
    const d = deps();
    const r = await runTier([source()], 'daily', committed({ a: entry({ consecutiveFailures: 5, health: 'failed' }) }), d);
    expect(r.status?.sources['a']?.consecutiveFailures).toBe(0);
  });

  it('counts a source that threw as a failure', async () => {
    const d = deps({
      fetchOne: async () => {
        throw new Error('boom');
      },
    });
    const r = await runTier([source()], 'daily', null, d);
    expect(r.status?.sources['a']?.consecutiveFailures).toBe(1);
  });

  // Task 6 established that a genuinely quiet feed is stale rather than failed.
  // A daily failure email about good news is how an alerting channel gets muted,
  // after which nothing else in this file works.
  it('does not count a quiet feed as a failure', async () => {
    const s = source({
      contentType: 'xml',
      path: 'raw/a/response.atom',
      expectedRoot: 'feed',
      invariants: NO_CANARY,
      freshness: { kind: 'feed', maxQuietDays: 7 },
    });
    const quiet = enc('<?xml version="1.0"?>\n<feed><entry><id>1</id><updated>2026-01-01T00:00:00Z</updated></entry></feed>\n');
    const d = deps({
      fetchOne: async () => ({
        ok: true as const,
        attempts: 1,
        observed: { status: 200, body: quiet, finalUrl: s.url, redirectCount: 0, headers: {} },
        headers: HDR,
      }),
    }, { 'raw/a/response.atom': enc('<?xml version="1.0"?>\n<feed><entry><id>0</id><updated>2025-12-01T00:00:00Z</updated></entry></feed>\n') });
    const r = await runTier([s], 'daily', committed({ a: entry({ consecutiveFailures: 2 }) }), d);
    expect(r.status?.sources['a']?.consecutiveFailures).toBe(0);
  });

  it('records the stale verdict against the source anyway', async () => {
    const s = source({
      contentType: 'xml',
      path: 'raw/a/response.atom',
      expectedRoot: 'feed',
      invariants: NO_CANARY,
      freshness: { kind: 'feed', maxQuietDays: 7 },
    });
    const quiet = enc('<?xml version="1.0"?>\n<feed><entry><id>1</id><updated>2026-01-01T00:00:00Z</updated></entry></feed>\n');
    const d = deps({
      fetchOne: async () => ({
        ok: true as const,
        attempts: 1,
        observed: { status: 200, body: quiet, finalUrl: s.url, redirectCount: 0, headers: {} },
        headers: HDR,
      }),
    }, { 'raw/a/response.atom': enc('<?xml version="1.0"?>\n<feed><entry><id>0</id><updated>2025-12-01T00:00:00Z</updated></entry></feed>\n') });
    const r = await runTier([s], 'daily', null, d);
    expect(r.status?.sources['a']?.health).toBe('stale');
  });

  /**
   * The ordering the whole task exists for. The natural implementation
   * evaluates counters first or aborts on the exception, and then the
   * unconditional daily commit fails to happen precisely when sources are
   * failing, which re-arms the 60-day clock this is defending against.
   *
   * Every source here fails and the committed counter is already past the daily
   * threshold, so this run is as bad as a run gets.
   */
  it('commits the status file on a run in which every source is failing', async () => {
    const d = deps(unreachable());
    await runTier([source()], 'daily', committed({ a: entry({ consecutiveFailures: 7, failing: true, health: 'failed' }) }), d);
    expect(d.trace).toContain('commit:meta/status.json');
  });

  it('and that same run still reports a non-zero exit code', async () => {
    const d = deps(unreachable());
    const r = await runTier([source()], 'daily', committed({ a: entry({ consecutiveFailures: 7, failing: true, health: 'failed' }) }), d);
    expect(r.exitCode).toBe(1);
  });

  it('commits the status file even when every source threw', async () => {
    const d = deps({
      fetchOne: async () => {
        throw new Error('boom');
      },
    });
    await runTier([source()], 'daily', null, d);
    expect(d.trace).toContain('commit:meta/status.json');
  });

  /**
   * A heartbeat committed after the push is a heartbeat that never leaves the
   * runner, and GitHub counts pushes, not commits.
   *
   * The two events are filtered out of the trace and compared as a sequence
   * rather than by index. `indexOf(commit) < indexOf(push)` is satisfied by a
   * run that never committed at all, because a missing entry is -1, and a stub
   * that committed nothing passed it.
   */
  it('commits the status file before it pushes', async () => {
    const d = deps(unreachable());
    await runTier([source()], 'daily', null, d);
    expect(d.trace.filter((t) => t === 'commit:meta/status.json' || t === 'push')).toEqual([
      'commit:meta/status.json',
      'push',
    ]);
  });

  it('exits zero while the counter is under this tier threshold', async () => {
    const d = deps(unreachable());
    const r = await runTier([source()], 'daily', committed({ a: entry({ consecutiveFailures: 1, health: 'failed' }) }), d);
    expect(r.exitCode).toBe(0);
  });

  it('exits non-zero at the daily threshold of three', async () => {
    const d = deps(unreachable());
    const r = await runTier([source()], 'daily', committed({ a: entry({ consecutiveFailures: 2, health: 'failed' }) }), d);
    expect(r.exitCode).toBe(1);
  });

  // Eight fast runs is two hours; three daily runs is three days. The same
  // committed counter must mean different things to the two jobs.
  it('does not exit non-zero at three on the fast tier, whose threshold is eight', async () => {
    const d = deps(unreachable());
    const r = await runTier([source()], 'fast', committed({ a: entry({ consecutiveFailures: 2, health: 'failed' }) }), d);
    expect(r.exitCode).toBe(0);
  });

  it('exits non-zero at the fast threshold of eight', async () => {
    const d = deps(unreachable());
    const r = await runTier([source()], 'fast', committed({ a: entry({ consecutiveFailures: 7, health: 'failed' }) }), d);
    expect(r.exitCode).toBe(1);
  });

  it('does not let a source from another tier trip this tier exit code', async () => {
    const d = deps(unreachable());
    const r = await runTier([source()], 'daily', committed({ a: entry(), other: entry({ consecutiveFailures: 99, failing: true, health: 'failed' }) }), d);
    expect(r.exitCode).toBe(0);
  });

  // Both tiers share one file. A fast run that rewrote it from its own sources
  // alone would erase every daily counter twice an hour.
  it('keeps the entries of sources this run did not touch', async () => {
    const d = deps();
    const r = await runTier([source()], 'fast', committed({ a: entry(), other: entry({ consecutiveFailures: 4, failing: true, health: 'failed' }) }), d);
    expect(r.status?.sources['other']?.consecutiveFailures).toBe(4);
  });

  it('reads back what it wrote, using the parser the collector reads it with', async () => {
    const d = deps();
    const r = await runTier([source()], 'daily', null, d);
    expect(parseStatusFile(dec(d.files['meta/status.json']))).toEqual(r.status);
  });

  it('ends the status file with a newline, so it is a well-formed text file', async () => {
    const d = deps();
    await runTier([source()], 'daily', null, d);
    expect(dec(d.files['meta/status.json']).endsWith('\n')).toBe(true);
  });

  it('dates the daily heartbeat commit, so the log itself shows the cadence', async () => {
    const d = deps();
    await runTier([source()], 'daily', null, d);
    expect(d.messages.find((m) => m.startsWith('status:'))).toBe('status: daily heartbeat 2026-08-26');
  });

  it('says why a fast run committed status at all', async () => {
    const d = deps(unreachable());
    await runTier([source()], 'fast', null, d);
    expect(d.messages.find((m) => m.startsWith('status:'))).toBe('status: source state changed');
  });
});

/**
 * The cadence, run against run, on the tier where it is load bearing.
 *
 * The daily job commits unconditionally, so only the fast job can tell a
 * working rule from a broken one. Each pair below runs `runTier` twice with a
 * DIFFERENT `nowIso`, which is what makes the clocks move; with one clock the
 * pair would pass even if every self-ticking field were still being compared.
 */
describe('two consecutive fast runs', () => {
  const later = { nowIso: () => '2026-08-26T14:15:00.000Z' };
  const unreachable = { fetchOne: async () => ({ ok: false as const, error: 'ECONNRESET', attempts: 3 }) };

  /** Steady health: the stored bytes already match, so nothing changes anywhere. */
  const healthyPair = async () => {
    const files = { 'raw/a/response.txt': BODY };
    const first = deps({}, files);
    const r1 = await runTier([source()], 'fast', null, first);
    const second = deps(later, files);
    const r2 = await runTier([source()], 'fast', r1.status, second);
    return { first, second, r1, r2 };
  };

  const outagePair = async () => {
    const first = deps(unreachable);
    const r1 = await runTier([source()], 'fast', null, first);
    const second = deps({ ...unreachable, ...later }, first.files);
    const r2 = await runTier([source()], 'fast', r1.status, second);
    return { first, second, r1, r2 };
  };

  it('moves the clocks, which is what makes the two claims below distinguishable', async () => {
    const { r1, r2 } = await healthyPair();
    expect(r2.status?.sources['a']?.lastAttemptAt).not.toBe(r1.status?.sources['a']?.lastAttemptAt);
  });

  it('does not commit status on the second run when the source is healthy and unchanged', async () => {
    const { second } = await healthyPair();
    expect(second.trace).toEqual(['fetch', 'push']);
  });

  // The trace this whole task exists to make possible: fail at 00:15 and commit
  // 1, fail at 00:30 and commit 2. Revision 1 committed only on transitions, so
  // the second run's 2 died with the runner and 00:45 read 1 again.
  it('advances the counter to two on the second run of an outage', async () => {
    const { r2 } = await outagePair();
    expect(r2.status?.sources['a']?.consecutiveFailures).toBe(2);
  });

  it('and commits that two, so the third run can read it', async () => {
    const { second } = await outagePair();
    expect(second.trace).toContain('commit:meta/status.json');
  });

  it('so the file left on disk carries two, not one', async () => {
    const { second } = await outagePair();
    expect((JSON.parse(dec(second.files['meta/status.json'])) as StatusFile).sources['a']?.consecutiveFailures).toBe(2);
  });
});

/**
 * The other cadence, and the one the 60-day clock actually depends on.
 *
 * A daily run must commit its heartbeat even when NOTHING moved, because
 * "nothing moved" is what a healthy archive looks like for weeks at a time and
 * GitHub reads a quiet repository as an abandoned one. The fast-tier pair above
 * proves the same two runs would not have committed on their own, so the commit
 * below can only be the unconditional daily rule.
 */
describe('two consecutive daily runs', () => {
  const dailyPair = async () => {
    const files = { 'raw/a/response.txt': BODY };
    const first = deps({}, files);
    const r1 = await runTier([source()], 'daily', null, first);
    const second = deps({ nowIso: () => '2026-08-27T14:00:00.000Z' }, files);
    const r2 = await runTier([source()], 'daily', r1.status, second);
    return { first, second, r1, r2 };
  };

  // The fixture check. If anything meaningful HAD moved between these two runs,
  // the claim below would pass without the daily rule existing at all.
  it('leave nothing meaningful moved between them', async () => {
    const { r1, r2 } = await dailyPair();
    expect(shouldCommitStatus(r1.status, r2.status!, false)).toBe(false);
  });

  it('and the second one commits its heartbeat anyway', async () => {
    const { second } = await dailyPair();
    expect(second.trace).toContain('commit:meta/status.json');
  });
});

describe('the change clock runTier records', () => {
  it('is stamped with the run clock when an artifact is written', async () => {
    const d = deps();
    const r = await runTier([source()], 'daily', null, d);
    expect(r.status?.sources['a']?.lastChangeAt).toBe('2026-08-26T14:00:00.000Z');
  });

  // Days since the last content change is what tells an operator a source has
  // gone quiet. A run that changed nothing must not restamp it.
  it('is left alone on a run whose bytes were identical', async () => {
    const files = { 'raw/a/response.txt': BODY };
    const first = deps({}, files);
    const r1 = await runTier([source()], 'daily', null, first);
    const second = deps({ nowIso: () => '2026-08-27T14:00:00.000Z' }, files);
    const r2 = await runTier([source()], 'daily', r1.status, second);
    expect(r2.status?.sources['a']?.lastChangeAt).toBe(r1.status?.sources['a']?.lastChangeAt ?? null);
  });

  it('starts null for a source that has never changed under our watch', async () => {
    const d = deps({}, { 'raw/a/response.txt': BODY });
    const r = await runTier([source()], 'daily', null, d);
    expect(r.status?.sources['a']?.lastChangeAt).toBeNull();
  });
});
