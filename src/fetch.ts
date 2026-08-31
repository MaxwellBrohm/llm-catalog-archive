/**
 * The HTTP layer. This is the only module in the project that touches the
 * network; everything above it is pure.
 *
 * `fetchImpl` and `sleep` are injected so every behaviour in here is proven
 * without a network and without real delays. The defaults are the global
 * `fetch` and a real `setTimeout`.
 */

import type { Source } from './config.js';
import type { Observed } from './types.js';
import { captureHeaders, type HeaderRecord } from './headers.js';

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export type FetchOpts = {
  userAgent: string;
  nowIso: () => string;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
};

export type FetchOutcome =
  | { ok: true; observed: Observed; headers: HeaderRecord; attempts: number }
  | { ok: false; error: string; attempts: number };

/**
 * The wait before attempt 2 and before attempt 3. Attempts past that reuse the
 * last value rather than growing without bound, because the fast tier runs
 * every 15 minutes and a run that outlives its own cadence is worse than a run
 * that gives up.
 */
const BACKOFF_MS = [2000, 8000];

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/** Retry only what a retry can fix. A 404 will still be a 404. */
function retryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Release the body of a response we are throwing away. Redirect hops and
 * retried error responses are never read, and an unread body holds its socket
 * open instead of returning it to the pool.
 */
async function discard(r: Response): Promise<void> {
  try {
    await r.body?.cancel();
  } catch {
    // Already released, or the stream errored on the way out. Nothing here is
    // load bearing: this is cleanup for a response we have decided to ignore.
  }
}

export async function fetchSource(source: Source, opts: FetchOpts): Promise<FetchOutcome> {
  const doFetch = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastError = 'unknown';
  const maxAttempts = source.retries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await sleep(BACKOFF_MS[Math.min(attempt - 2, BACKOFF_MS.length - 1)]!);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), source.timeoutS * 1000);

    try {
      let url = source.url;
      let redirectCount = 0;
      let response: Response | null = null;

      // Manual redirects: the platform default follows silently and would hide
      // the relocation that the health check exists to surface. One day of
      // probing found five relocations, so this is what catches the sixth.
      // An absolute ceiling, independent of maxRedirects. The cap below is the
      // policy; this is the guarantee. A loop whose only exit is a policy check
      // becomes infinite the moment that check is wrong, and an infinite async
      // loop cannot be cancelled by a test timeout: vitest fails the test and
      // the worker spins on. Not hypothetical. Four orphaned workers burned
      // 100% CPU each for five days after a mutation deleted redirectCount++.
      const HOP_CEILING = 32;
      for (let hop = 0; ; hop++) {
        if (hop > HOP_CEILING) {
          clearTimeout(timer);
          return {
            ok: false,
            error: `redirect loop did not terminate within ${HOP_CEILING} hops at ${url}`,
            attempts: attempt,
          };
        }
        const r: Response = await doFetch(url, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'user-agent': opts.userAgent, 'accept-encoding': 'gzip, deflate, br' },
        });
        if (REDIRECT_CODES.has(r.status)) {
          const loc = r.headers.get('location');
          // A 3xx with no Location relocates nowhere. Hand it up as the
          // observation it is rather than inventing a destination.
          if (loc === null) {
            response = r;
            break;
          }
          if (redirectCount >= source.maxRedirects) {
            clearTimeout(timer);
            await discard(r);
            return {
              ok: false,
              error: `redirect cap ${source.maxRedirects} exceeded at ${url}`,
              attempts: attempt,
            };
          }
          redirectCount++;
          // Resolved against the url we just fetched, not against source.url,
          // so a relative Location on the second hop lands on the second host.
          url = new URL(loc, url).toString();
          await discard(r);
          continue;
        }
        response = r;
        break;
      }

      const res = response!;
      if (retryableStatus(res.status) && attempt < maxAttempts) {
        lastError = `status ${res.status}`;
        clearTimeout(timer);
        await discard(res);
        continue;
      }

      const body = new Uint8Array(await res.arrayBuffer());
      clearTimeout(timer);

      // A 25s timeout against a real endpoint once truncated a body at 23,404
      // of 57,859 bytes and produced unparseable JSON rather than an error
      // status. A truncated body that happened to still parse would otherwise
      // be committed as a real change.
      //
      // Skipped when content-encoding is present: the runtime hands back the
      // decoded entity body while content-length describes the compressed
      // length, so comparing them would fail on every compressed response.
      const declared = res.headers.get('content-length');
      if (declared !== null && res.headers.get('content-encoding') === null) {
        const want = Number(declared);
        if (Number.isFinite(want) && body.byteLength < want) {
          lastError = `truncated body: got ${body.byteLength} of content-length ${want}`;
          if (attempt < maxAttempts) continue;
          return { ok: false, error: lastError, attempts: attempt };
        }
      }

      const fetchedAt = opts.nowIso();
      return {
        ok: true,
        attempts: attempt,
        observed: {
          status: res.status,
          body,
          finalUrl: url,
          redirectCount,
          headers: Object.fromEntries(res.headers),
        },
        headers: captureHeaders(res, { fetchedAt, finalUrl: url, userAgent: opts.userAgent }),
      };
    } catch (e) {
      clearTimeout(timer);
      lastError = String(e instanceof Error ? e.message : e);
      if (attempt >= maxAttempts) return { ok: false, error: lastError, attempts: attempt };
    }
  }
  // Not reachable through any path above: every branch at attempt ===
  // maxAttempts returns rather than continuing. It exists because the compiler
  // cannot see that, and it is deliberately not covered by a test.
  return { ok: false, error: lastError, attempts: maxAttempts };
}
