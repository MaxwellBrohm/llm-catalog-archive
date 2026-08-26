import { describe, it, expect } from 'vitest';
import { runTier, type RunDeps } from '../src/run.js';
import type { Source } from '../src/config.js';
import type { HeaderRecord } from '../src/headers.js';

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
    const d = await runOne(source({ contentType: 'json', path: 'raw/a/response.json' }), JSON_BODY);
    expect(d.files['raw/a/response.json']).toEqual(JSON_BODY);
  });

  it('writes an xml body verbatim, keeping its BOM and its CRLFs', async () => {
    const d = await runOne(source({ contentType: 'xml', path: 'raw/a/response.xml' }), XML_BODY);
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
  // and a no-op passed it. This says the fetch happened, nothing was written,
  // nothing was committed, and the push still ran.
  it('fetches and then writes nothing when the stored bytes are identical', async () => {
    const d = deps({}, { 'raw/a/response.txt': BODY });
    await runTier([source()], 'daily', null, d);
    expect(d.trace).toEqual(['fetch', 'push']);
  });

  it('does not commit when the stored bytes are identical', async () => {
    const d = deps({}, { 'raw/a/response.txt': BODY });
    await runTier([source()], 'daily', null, d);
    expect(d.trace.some((t) => t.startsWith('commit:'))).toBe(false);
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
    expect(d.trace.some((t) => t.startsWith('commit:'))).toBe(false);
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
    expect(d.trace.some((t) => t.startsWith('write:'))).toBe(false);
  });

  it('does not commit a source whose fetch reported failure', async () => {
    const d = deps({ fetchOne: async () => ({ ok: false as const, error: 'status 503', attempts: 3 }) });
    await runTier([source()], 'daily', null, d);
    expect(d.trace.some((t) => t.startsWith('commit:'))).toBe(false);
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
