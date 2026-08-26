/**
 * Header capture and origin-time reasoning. Pure: no fs, no child_process, no
 * fetch, no git. Everything here is a function of its arguments.
 *
 * `headers.json` is a sidecar. It is written in the same commit as the body it
 * describes and only when that body is accepted, never on an independent
 * schedule. On its own status cadence the fast tier would discard 95 of every
 * 96 daily header states and would guarantee that the committed etag was not
 * the etag of the committed body.
 */

export type HeaderRecord = {
  fetchedAt: string;
  finalUrl: string;
  userAgent: string;
  status: number;
  etag: string | null;
  lastModified: string | null;
  date: string | null;
  age: string | null;
  cacheControl: string | null;
  cfCacheStatus: string | null;
  contentEncoding: string | null;
  contentLength: string | null;
};

/**
 * A fixed allowlist, not a dump. Response headers can carry Set-Cookie and
 * other per-request material, and this file is committed to a public archive.
 */
export function captureHeaders(
  res: { status: number; headers: Headers },
  meta: { fetchedAt: string; finalUrl: string; userAgent: string },
): HeaderRecord {
  const g = (k: string) => res.headers.get(k) ?? null;
  return {
    fetchedAt: meta.fetchedAt,
    finalUrl: meta.finalUrl,
    userAgent: meta.userAgent,
    status: res.status,
    etag: g('etag'),
    lastModified: g('last-modified'),
    date: g('date'),
    age: g('age'),
    cacheControl: g('cache-control'),
    cfCacheStatus: g('cf-cache-status'),
    contentEncoding: g('content-encoding'),
    contentLength: g('content-length'),
  };
}

/**
 * When the response was generated at origin, as distinct from when we saw it.
 * Every published timestamp derives from this and never from commit time:
 * OpenRouter serves stale-while-revalidate=3600, so an edge may hand back a
 * response up to about 65 minutes past freshness, which makes capture time an
 * upper bound on change time rather than the change time.
 */
export function originDateMs(h: HeaderRecord): number | null {
  if (h.date === null || h.age === null) return null;
  const d = Date.parse(h.date);
  // Blank before Number(), because Number('') and Number('   ') are both 0 and
  // not NaN. Left to the numeric guard, a blank Age would claim the response
  // was generated exactly at its Date header, while an absent Age correctly
  // returns null. The lenient case would be the malformed one.
  if (h.age.trim() === '') return null;
  const a = Number(h.age);
  // RFC 9111 defines Age as non-negative delta-seconds, so a negative value is
  // malformed. Treated as arithmetic it yields an origin in the FUTURE of the
  // Date header, and once a future origin is stored every later honest
  // response is judged stale and the source stops collecting for good. That is
  // the exact failure the permissiveness contract exists to prevent, arriving
  // through the arithmetic rather than through the guards, and it would also
  // publish a future timestamp. Null is the consistent treatment.
  if (Number.isNaN(d) || !Number.isFinite(a) || a < 0) return null;
  return d - a * 1000;
}

/**
 * True when this response is an older cache generation than what is stored.
 *
 * Runners are spread across regions with no stable Cloudflare POP, so two
 * adjacent polls can land on edges holding different cache generations. Without
 * this check the archive records A, B, A, B for a value that changed once, and
 * the deriver emits a change event and a reversion event, both with honest
 * artifact links.
 *
 * Permissive when it cannot tell. An unknown origin timestamp on either side
 * returns false, because a guard that blocks while uninformed would stall a
 * source permanently the first time a provider stopped sending Age. The
 * comparison is strictly older, not older-or-equal, so a re-served identical
 * generation is not treated as stale.
 */
export function isStaleGeneration(next: HeaderRecord, storedOriginIso: string | null): boolean {
  if (storedOriginIso === null) return false;
  const nextOrigin = originDateMs(next);
  if (nextOrigin === null) return false;
  const stored = Date.parse(storedOriginIso);
  if (Number.isNaN(stored)) return false;
  return nextOrigin < stored;
}
