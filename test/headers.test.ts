import { describe, it, expect } from 'vitest';
import { captureHeaders, originDateMs, isStaleGeneration, type HeaderRecord } from '../src/headers.js';

const cap = (h: Record<string, string>, status = 200): HeaderRecord =>
  captureHeaders({ status, headers: new Headers(h) },
    { fetchedAt: '2026-08-26T14:00:00.000Z', finalUrl: 'https://x/y', userAgent: 'llm-catalog-archive/1.0' });

const DATE_14 = 'Tue, 26 Aug 2026 14:00:00 GMT';

// A HeaderRecord built directly, bypassing Headers. Node's Headers strips
// leading and trailing whitespace from every value, so `new Headers({age: '   '})`
// yields '' and a whitespace-only Age can never reach originDateMs by that
// route. It can arrive through a headers.json sidecar read back from the
// archive, which is an ordinary HeaderRecord that no Headers object touched.
// Routing the whitespace case through `cap` would silently retest the blank
// case instead, and the trim guard would go unexercised.
const record = (over: Partial<HeaderRecord>): HeaderRecord => ({
  fetchedAt: '2026-08-26T14:00:00.000Z',
  finalUrl: 'https://x/y',
  userAgent: 'llm-catalog-archive/1.0',
  status: 200,
  etag: null,
  lastModified: null,
  date: null,
  age: null,
  cacheControl: null,
  cfCacheStatus: null,
  contentEncoding: null,
  contentLength: null,
  ...over,
});

// A response carrying one of everything in the allowlist plus material that
// must never reach a public archive. Built fresh per call so no test can leak
// a mutation into whichever test vitest runs next.
const everything = () =>
  cap({
    etag: 'abc123',
    'last-modified': 'Tue, 26 Aug 2026 13:00:00 GMT',
    date: DATE_14,
    age: '120',
    'cache-control': 'public, max-age=300',
    'cf-cache-status': 'HIT',
    'content-encoding': 'gzip',
    'content-length': '4242',
    'set-cookie': 'sessiontoken=leakme',
    'x-request-id': 'req-shouldnotappear',
  });

// Hardcoded on purpose. Deriving this list from HeaderRecord, or from the
// record captureHeaders just returned, would be circular and would keep
// passing after someone spread the whole Headers object into the result.
const DECLARED_KEYS = [
  'age',
  'cacheControl',
  'cfCacheStatus',
  'contentEncoding',
  'contentLength',
  'date',
  'etag',
  'fetchedAt',
  'finalUrl',
  'lastModified',
  'status',
  'userAgent',
];

describe('captureHeaders records the declared header set', () => {
  it('records etag', () => {
    expect(everything().etag).toBe('abc123');
  });

  it('records last-modified', () => {
    expect(everything().lastModified).toBe('Tue, 26 Aug 2026 13:00:00 GMT');
  });

  it('records date', () => {
    expect(everything().date).toBe(DATE_14);
  });

  it('records age', () => {
    expect(everything().age).toBe('120');
  });

  it('records cache-control', () => {
    expect(everything().cacheControl).toBe('public, max-age=300');
  });

  it('records cf-cache-status', () => {
    expect(everything().cfCacheStatus).toBe('HIT');
  });

  it('records content-encoding', () => {
    expect(everything().contentEncoding).toBe('gzip');
  });

  it('records content-length', () => {
    expect(everything().contentLength).toBe('4242');
  });

  it('records the response status', () => {
    expect(cap({}, 304).status).toBe(304);
  });

  it('records the capture time from meta, not from the date header', () => {
    expect(everything().fetchedAt).toBe('2026-08-26T14:00:00.000Z');
  });

  it('records the final url from meta', () => {
    expect(everything().finalUrl).toBe('https://x/y');
  });

  it('records the user agent from meta', () => {
    expect(everything().userAgent).toBe('llm-catalog-archive/1.0');
  });
});

describe('captureHeaders drops everything outside the allowlist', () => {
  it('does not carry a Set-Cookie value into the record', () => {
    expect(JSON.stringify(everything())).not.toContain('leakme');
  });

  it('does not carry an unlisted header value into the record', () => {
    expect(JSON.stringify(everything())).not.toContain('req-shouldnotappear');
  });

  it('has exactly the declared keys and no others', () => {
    expect(Object.keys(everything()).sort()).toEqual(DECLARED_KEYS);
  });
});

describe('captureHeaders on an absent header', () => {
  it('sets the value to null', () => {
    expect(cap({}).etag).toBeNull();
  });

  it('sets content-encoding to null when the response is not encoded', () => {
    expect(cap({}).contentEncoding).toBeNull();
  });

  it('sets cache-control to null when the response declares none', () => {
    expect(cap({}).cacheControl).toBeNull();
  });

  it('keeps the key present rather than omitting it', () => {
    expect('etag' in cap({})).toBe(true);
  });
});

describe('originDateMs', () => {
  it('is date minus age', () => {
    expect(originDateMs(cap({ date: DATE_14, age: '600' }))).toBe(Date.parse('2026-08-26T13:50:00Z'));
  });

  it('is date itself when age is zero', () => {
    expect(originDateMs(cap({ date: DATE_14, age: '0' }))).toBe(Date.parse('2026-08-26T14:00:00Z'));
  });

  it('is null when only date is present', () => {
    expect(originDateMs(cap({ date: DATE_14 }))).toBeNull();
  });

  it('is null when only age is present', () => {
    expect(originDateMs(cap({ age: '600' }))).toBeNull();
  });

  it('is null when neither is present', () => {
    expect(originDateMs(cap({}))).toBeNull();
  });

  it('is null when date does not parse', () => {
    expect(originDateMs(cap({ date: 'not a date', age: '600' }))).toBeNull();
  });

  it('is null when age is not a number', () => {
    expect(originDateMs(cap({ date: DATE_14, age: 'soon' }))).toBeNull();
  });

  // RFC 9111 makes Age non-negative delta-seconds. The three cases below are
  // malformed, and each would otherwise pass silently: a negative age is
  // finite arithmetic, and Number('') and Number('   ') are both 0 rather
  // than NaN.
  it('is null when age is negative', () => {
    expect(originDateMs(cap({ date: DATE_14, age: '-3600' }))).toBeNull();
  });

  it('is null when age is blank', () => {
    expect(originDateMs(cap({ date: DATE_14, age: '' }))).toBeNull();
  });

  it('is null when age is negative by one second', () => {
    expect(originDateMs(cap({ date: DATE_14, age: '-1' }))).toBeNull();
  });

  it('is null when age is whitespace only', () => {
    expect(originDateMs(record({ date: DATE_14, age: '   ' }))).toBeNull();
  });
});

// Why the negative-age guard is not merely tidiness. The two tests below are a
// pair: the first shows the damage a future origin does once stored, the
// second shows the guard is what keeps a negative Age from ever becoming one.
// 14:00 Date minus an Age of -3600 is 15:00, an hour into the future, and the
// stored value below is that exact number written out rather than derived.
describe('a future origin poisons a source, which is why a negative age is null', () => {
  it('skips the next honest poll once a future origin is stored', () => {
    expect(isStaleGeneration(cap({ date: DATE_14, age: '60' }), '2026-08-26T15:00:00.000Z')).toBe(true);
  });

  it('never derives that future origin from a negative age', () => {
    expect(originDateMs(cap({ date: DATE_14, age: '-3600' }))).toBe(null);
  });
});

describe('isStaleGeneration', () => {
  it('rejects a response whose origin is older than what is already stored', () => {
    expect(isStaleGeneration(cap({ date: DATE_14, age: '3600' }), '2026-08-26T13:30:00.000Z')).toBe(true);
  });

  it('rejects a response one second older than what is stored', () => {
    expect(isStaleGeneration(cap({ date: DATE_14, age: '1801' }), '2026-08-26T13:30:00.000Z')).toBe(true);
  });

  it('accepts a newer origin', () => {
    expect(isStaleGeneration(cap({ date: DATE_14, age: '60' }), '2026-08-26T13:30:00.000Z')).toBe(false);
  });

  it('accepts an equal origin, so a re-served identical generation is not a skip', () => {
    expect(isStaleGeneration(cap({ date: DATE_14, age: '1800' }), '2026-08-26T13:30:00.000Z')).toBe(false);
  });

  it('accepts when the incoming origin is unknown, rather than blocking forever', () => {
    expect(isStaleGeneration(cap({}), '2026-08-26T13:30:00.000Z')).toBe(false);
  });

  it('accepts when nothing is stored yet', () => {
    expect(isStaleGeneration(cap({ date: DATE_14, age: '60' }), null)).toBe(false);
  });

  it('accepts when the stored origin does not parse', () => {
    expect(isStaleGeneration(cap({ date: DATE_14, age: '3600' }), 'not a date')).toBe(false);
  });
});
