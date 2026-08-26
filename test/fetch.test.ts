import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchSource, type FetchImpl, type FetchOpts } from '../src/fetch.js';
import type { Source } from '../src/config.js';

// No test in this file touches the network. `fetchImpl` and `sleep` are always
// injected, so a regression here fails on logic and never on connectivity.

const UA = 'llm-catalog-archive/1.0 (+https://github.com/OWNER/REPO)';
// Deliberately not UA. Used wherever the claim is "the module forwards the user
// agent it was handed", which an assertion against UA cannot distinguish from a
// hardcoded copy of the declared string.
const OTHER_UA = 'llm-catalog-archive/1.0 (+https://github.com/real-owner/real-repo)';
const NOW = '2026-08-26T14:00:00.000Z';
const START = 'https://a.example/f';

const src = (over: Partial<Source> = {}): Source =>
  ({ id: 'x', url: START, timeoutS: 5, retries: 2, maxRedirects: 3, ...over }) as Source;

const opts = (fetchImpl: FetchImpl, over: Partial<FetchOpts> = {}): FetchOpts => ({
  userAgent: UA,
  nowIso: () => NOW,
  fetchImpl,
  sleep: async () => {},
  ...over,
});

const res = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, ...init });

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

/** Fails loudly rather than letting a broken run fall through to a vacuous pass. */
const succeeded = (out: Awaited<ReturnType<typeof fetchSource>>) => {
  if (!out.ok) throw new Error(`expected success, got failure: ${out.error}`);
  return out;
};

const failed = (out: Awaited<ReturnType<typeof fetchSource>>) => {
  if (out.ok) throw new Error(`expected failure, got status ${out.observed.status}`);
  return out;
};

// ---------------------------------------------------------------------------

describe('fetchSource identifies itself', () => {
  const firstInit = async () => {
    const seen: RequestInit[] = [];
    const impl: FetchImpl = async (_u, i) => {
      seen.push(i);
      return res('ok');
    };
    await fetchSource(src(), opts(impl));
    return seen[0]!;
  };

  // The declared UA, spelled out. Not derived from opts.userAgent, which would
  // pass just as happily if the module sent no user-agent at all and something
  // else echoed the value back.
  it('sends the declared user agent verbatim', async () => {
    expect(new Headers((await firstInit()).headers).get('user-agent')).toBe(UA);
  });

  // The test above cannot tell a threaded argument from a hardcoded copy of the
  // declared string. Task 5 replaces the OWNER/REPO placeholder with the real
  // repository before the first live fetch, so a module that ignored this
  // argument would introduce itself to sixteen third parties as OWNER/REPO
  // forever, with a green suite. Hence a UA unlike the fixture default.
  it('sends the user agent it was given rather than one of its own', async () => {
    const seen: RequestInit[] = [];
    const impl: FetchImpl = async (_u, i) => {
      seen.push(i);
      return res('ok');
    };
    await fetchSource(src(), opts(impl, { userAgent: OTHER_UA }));
    expect(new Headers(seen[0]!.headers).get('user-agent')).toBe(OTHER_UA);
  });

  it('asks for the encodings it can decode', async () => {
    expect(new Headers((await firstInit()).headers).get('accept-encoding')).toBe('gzip, deflate, br');
  });

  it('keeps redirect handling out of the platform', async () => {
    expect((await firstInit()).redirect).toBe('manual');
  });

  it('requests the configured url', async () => {
    const seen: string[] = [];
    const impl: FetchImpl = async (u) => {
      seen.push(u);
      return res('ok');
    };
    await fetchSource(src({ url: 'https://other.example/z' }), opts(impl));
    expect(seen).toEqual(['https://other.example/z']);
  });
});

// ---------------------------------------------------------------------------

describe('fetchSource reports a plain success', () => {
  const plain = async (init: ResponseInit = {}) => {
    const impl: FetchImpl = async () => res('body', init);
    return succeeded(await fetchSource(src(), opts(impl)));
  };

  it('reports one attempt', async () => {
    expect((await plain()).attempts).toBe(1);
  });

  it('reports zero redirects', async () => {
    expect((await plain()).observed.redirectCount).toBe(0);
  });

  it('reports the status', async () => {
    expect((await plain({ status: 201 })).observed.status).toBe(201);
  });

  // A url other than the fixture default, so a module that hardcoded its own
  // idea of the final url cannot pass this.
  it('reports the requested url as final', async () => {
    const impl: FetchImpl = async () => res('body');
    const out = succeeded(await fetchSource(src({ url: 'https://elsewhere.example/p' }), opts(impl)));
    expect(out.observed.finalUrl).toBe('https://elsewhere.example/p');
  });

  it('returns the body bytes', async () => {
    expect(decode((await plain()).observed.body)).toBe('body');
  });

  it('returns multibyte bodies without re-encoding them', async () => {
    const impl: FetchImpl = async () => res('café');
    const out = succeeded(await fetchSource(src(), opts(impl)));
    // 5 bytes, not 4 characters. A byteLength of 4 would mean something
    // decoded the body to a string and back through latin-1.
    expect(out.observed.body.byteLength).toBe(5);
  });

  it('exposes the raw response headers', async () => {
    expect((await plain({ headers: { 'x-thing': 'yes' } })).observed.headers['x-thing']).toBe('yes');
  });
});

// ---------------------------------------------------------------------------

describe('the header sidecar', () => {
  // A clock and a url that are both unlike the fixture defaults, so a module
  // that stamped a constant instead of reading its inputs cannot pass.
  const CLOCK = '2031-01-02T03:04:05.000Z';
  const SIDECAR_URL = 'https://sidecar.example/s';

  const sidecar = async (h: Record<string, string> = {}) => {
    const impl: FetchImpl = async () => res('body', { status: 203, headers: h });
    const out = await fetchSource(
      src({ url: SIDECAR_URL }),
      opts(impl, { nowIso: () => CLOCK, userAgent: OTHER_UA }),
    );
    return succeeded(out).headers;
  };

  it('stamps fetchedAt from the injected clock', async () => {
    expect((await sidecar()).fetchedAt).toBe(CLOCK);
  });

  // Same reasoning as the wire header: a hardcoded copy of the declared string
  // would satisfy an assertion against UA. The sidecar is what the archive
  // commits, so a stale user agent there is a permanent false record.
  it('records the user agent it was given rather than one of its own', async () => {
    expect((await sidecar()).userAgent).toBe(OTHER_UA);
  });

  it('records the url that was finally fetched', async () => {
    expect((await sidecar()).finalUrl).toBe(SIDECAR_URL);
  });

  it('records the status of the response it describes', async () => {
    expect((await sidecar()).status).toBe(203);
  });

  it('records the etag of the response it describes', async () => {
    expect((await sidecar({ etag: 'W/"abc123"' })).etag).toBe('W/"abc123"');
  });
});

// ---------------------------------------------------------------------------

describe('fetchSource follows redirects manually', () => {
  const oneHop = (): FetchImpl => async (u) =>
    u === START
      ? new Response(null, { status: 301, headers: { location: 'https://b.example/g' } })
      : res('final');

  const hopped = async () => succeeded(await fetchSource(src(), opts(oneHop())));

  // No `expect(out.ok).toBe(true)` here: `hopped` already routes through
  // `succeeded`, which throws on a failed outcome, so such an assertion could
  // never be the thing that fails.
  it('reports the relocated url as final', async () => {
    expect((await hopped()).observed.finalUrl).toBe('https://b.example/g');
  });

  it('counts the hop', async () => {
    expect((await hopped()).observed.redirectCount).toBe(1);
  });

  it('returns the body from the destination, not from the 301', async () => {
    expect(decode((await hopped()).observed.body)).toBe('final');
  });

  it('records the relocated url in the header sidecar', async () => {
    expect((await hopped()).headers.finalUrl).toBe('https://b.example/g');
  });

  it('does not spend an attempt on a redirect', async () => {
    expect((await hopped()).attempts).toBe(1);
  });

  it('sends the user agent on the redirected request too', async () => {
    const seen: RequestInit[] = [];
    const impl: FetchImpl = async (u, i) => {
      seen.push(i);
      return oneHop()(u, i);
    };
    await fetchSource(src(), opts(impl));
    expect(new Headers(seen[1]!.headers).get('user-agent')).toBe(UA);
  });

  it('keeps redirect handling manual on the redirected request too', async () => {
    const seen: RequestInit[] = [];
    const impl: FetchImpl = async (u, i) => {
      seen.push(i);
      return oneHop()(u, i);
    };
    await fetchSource(src(), opts(impl));
    expect(seen[1]!.redirect).toBe('manual');
  });

  for (const code of [301, 302, 303, 307, 308]) {
    it(`treats ${code} as a relocation`, async () => {
      const impl: FetchImpl = async (u) =>
        u === START
          ? new Response(null, { status: code, headers: { location: 'https://b.example/g' } })
          : res('final');
      expect(succeeded(await fetchSource(src(), opts(impl))).observed.finalUrl).toBe('https://b.example/g');
    });
  }

  // 300 and 304 carry a Location in the wild without meaning "go here now".
  // Following them would rewrite finalUrl and hide the real state.
  for (const code of [300, 304]) {
    it(`does not treat ${code} as a relocation`, async () => {
      const impl: FetchImpl = async (u) =>
        u === START
          ? new Response(null, { status: code, headers: { location: 'https://b.example/g' } })
          : res('final');
      expect(succeeded(await fetchSource(src(), opts(impl))).observed.status).toBe(code);
    });
  }

  it('returns a 3xx that carries no Location instead of inventing a destination', async () => {
    const impl: FetchImpl = async () => new Response(null, { status: 308 });
    expect(succeeded(await fetchSource(src(), opts(impl))).observed.status).toBe(308);
  });

  it('counts no hop for a 3xx that carries no Location', async () => {
    const impl: FetchImpl = async () => new Response(null, { status: 308 });
    expect(succeeded(await fetchSource(src(), opts(impl))).observed.redirectCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('relative Location resolution', () => {
  const to = (location: string): FetchImpl => async (u) =>
    u === START ? new Response(null, { status: 302, headers: { location } }) : res('final');

  it('resolves an absolute-path Location against the current url', async () => {
    const out = succeeded(await fetchSource(src(), opts(to('/moved'))));
    expect(out.observed.finalUrl).toBe('https://a.example/moved');
  });

  it('resolves a bare relative Location against the current path', async () => {
    const out = succeeded(await fetchSource(src(), opts(to('moved'))));
    expect(out.observed.finalUrl).toBe('https://a.example/moved');
  });

  it('resolves a protocol-relative Location against the current scheme', async () => {
    const out = succeeded(await fetchSource(src(), opts(to('//c.example/p'))));
    expect(out.observed.finalUrl).toBe('https://c.example/p');
  });

  it('leaves an absolute Location alone', async () => {
    const out = succeeded(await fetchSource(src(), opts(to('https://d.example/q?a=1'))));
    expect(out.observed.finalUrl).toBe('https://d.example/q?a=1');
  });

  // The base is the url of the hop we just fetched, not source.url. Resolving
  // against source.url would send the second hop back to a.example.
  it('resolves the second hop against the first hop, not against the original url', async () => {
    const impl: FetchImpl = async (u) => {
      if (u === START) return new Response(null, { status: 302, headers: { location: 'https://b.example/dir/x' } });
      if (u === 'https://b.example/dir/x') return new Response(null, { status: 302, headers: { location: 'y' } });
      return res('final');
    };
    const out = succeeded(await fetchSource(src(), opts(impl)));
    expect(out.observed.finalUrl).toBe('https://b.example/dir/y');
  });
});

// ---------------------------------------------------------------------------

describe('the redirect cap', () => {
  // Every response is a redirect to a url that has not been seen before, so
  // nothing but the cap can stop this.
  const endless = () => {
    let n = 0;
    const impl: FetchImpl = async () => {
      n++;
      return new Response(null, { status: 301, headers: { location: `https://a.example/${n}` } });
    };
    return { impl, calls: () => n };
  };

  it('fails rather than looping', async () => {
    const { impl } = endless();
    expect((await fetchSource(src({ maxRedirects: 3 }), opts(impl))).ok).toBe(false);
  });

  // maxRedirects hops plus the fetch that discovers the cap is exceeded.
  // Pinned exactly: "at most 5" would still pass if the cap were off by one.
  it('makes exactly four requests under a cap of three', async () => {
    const { impl, calls } = endless();
    await fetchSource(src({ maxRedirects: 3 }), opts(impl));
    expect(calls()).toBe(4);
  });

  it('makes exactly two requests under a cap of one', async () => {
    const { impl, calls } = endless();
    await fetchSource(src({ maxRedirects: 1 }), opts(impl));
    expect(calls()).toBe(2);
  });

  it('names the cap it hit', async () => {
    const { impl } = endless();
    const out = failed(await fetchSource(src({ maxRedirects: 3 }), opts(impl)));
    expect(out.error).toMatch(/redirect cap 3 exceeded/);
  });

  it('does not spend retries on a redirect loop', async () => {
    const { impl } = endless();
    const out = await fetchSource(src({ maxRedirects: 3, retries: 2 }), opts(impl));
    expect(out.attempts).toBe(1);
  });

  // A chain of exactly maxRedirects hops is legal. This is the other side of
  // the boundary: tightening the comparison by one would break it.
  const chainOf = (length: number): FetchImpl => async (u) => {
    const i = u === START ? 0 : Number(/\/hop(\d+)$/.exec(u)![1]);
    return i < length
      ? new Response(null, { status: 302, headers: { location: `https://a.example/hop${i + 1}` } })
      : res('arrived');
  };

  it('allows a chain exactly as long as the cap', async () => {
    const out = succeeded(await fetchSource(src({ maxRedirects: 3 }), opts(chainOf(3))));
    expect(out.observed.finalUrl).toBe('https://a.example/hop3');
  });

  it('counts a chain exactly as long as the cap', async () => {
    const out = succeeded(await fetchSource(src({ maxRedirects: 3 }), opts(chainOf(3))));
    expect(out.observed.redirectCount).toBe(3);
  });

  it('rejects a chain one hop past the cap', async () => {
    expect((await fetchSource(src({ maxRedirects: 2 }), opts(chainOf(3)))).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('the retry predicate', () => {
  // Fails `failures` times with `status`, then serves a real body. `calls`
  // counts requests that actually reached the transport, which is the
  // observable a stubbed fetchSource cannot fake.
  const flaky = (status: number, failures: number) => {
    let n = 0;
    const impl: FetchImpl = async () => {
      n++;
      return n <= failures ? res('transient', { status }) : res('good');
    };
    return { impl, calls: () => n };
  };

  for (const status of [429, 500, 503, 599]) {
    it(`retries a ${status}`, async () => {
      const f = flaky(status, 1);
      await fetchSource(src({ retries: 2 }), opts(f.impl));
      expect(f.calls()).toBe(2);
    });
  }

  // The upper bound of the 5xx range. `new Response` throws RangeError above
  // 599, but that constructor is not the only producer: an origin can put any
  // three digits on the status line and node's fetch hands the number back, and
  // `fetchImpl` is injected and never validated. So this input is reachable and
  // the bound is not dead code.
  it('does not retry a status above 599', async () => {
    let n = 0;
    const impl: FetchImpl = async () => {
      n++;
      return {
        status: 600,
        headers: new Headers(),
        body: null,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    };
    await fetchSource(src({ retries: 2 }), opts(impl));
    expect(n).toBe(1);
  });

  // A missing page will still be missing, and a bad request will still be bad.
  for (const status of [400, 404, 499]) {
    it(`does not retry a ${status}`, async () => {
      const f = flaky(status, 1);
      await fetchSource(src({ retries: 2 }), opts(f.impl));
      expect(f.calls()).toBe(1);
    });
  }

  it('reports the attempt count it spent on a status it did not retry', async () => {
    const out = await fetchSource(src({ retries: 2 }), opts(flaky(404, 1).impl));
    expect(out.attempts).toBe(1);
  });

  it('carries the status of a response it did not retry', async () => {
    const out = succeeded(await fetchSource(src(), opts(flaky(404, 1).impl)));
    expect(out.observed.status).toBe(404);
  });

  it('carries the body of a response it did not retry', async () => {
    const out = succeeded(await fetchSource(src(), opts(flaky(404, 1).impl)));
    expect(decode(out.observed.body)).toBe('transient');
  });

  it('counts every attempt it made', async () => {
    expect((await fetchSource(src({ retries: 2 }), opts(flaky(503, 2).impl))).attempts).toBe(3);
  });

  it('returns the body of the attempt that worked', async () => {
    const out = succeeded(await fetchSource(src({ retries: 2 }), opts(flaky(503, 2).impl)));
    expect(decode(out.observed.body)).toBe('good');
  });

  // Retries exhausted on a 5xx is not a fetch failure. The response is real and
  // the health check is what decides whether a 503 may be committed.
  it('reports the exhausted status on a persistent 503 rather than an error', async () => {
    const out = succeeded(await fetchSource(src({ retries: 1 }), opts(flaky(503, 99).impl)));
    expect(out.observed.status).toBe(503);
  });

  it('stops at the configured attempt count on a persistent 503', async () => {
    const out = await fetchSource(src({ retries: 1 }), opts(flaky(503, 99).impl));
    expect(out.attempts).toBe(2);
  });

  it('makes exactly one request when retries are zero', async () => {
    const f = flaky(503, 99);
    await fetchSource(src({ retries: 0 }), opts(f.impl));
    expect(f.calls()).toBe(1);
  });

  it('releases the body of a response it retried past', async () => {
    const kept: Response[] = [];
    let n = 0;
    const impl: FetchImpl = async () => {
      n++;
      const r = n < 2 ? res('transient', { status: 503 }) : res('good');
      if (n < 2) kept.push(r);
      return r;
    };
    await fetchSource(src(), opts(impl));
    expect(kept[0]!.bodyUsed).toBe(true);
  });

  it('releases the body of a redirect hop', async () => {
    const kept: Response[] = [];
    const impl: FetchImpl = async (u) => {
      if (u !== START) return res('final');
      const r = new Response('moved along', { status: 301, headers: { location: 'https://b.example/g' } });
      kept.push(r);
      return r;
    };
    await fetchSource(src(), opts(impl));
    expect(kept[0]!.bodyUsed).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('transport errors', () => {
  const always = (): FetchImpl => async () => {
    throw new Error('ECONNRESET');
  };

  it('reports a failure once retries run out', async () => {
    expect((await fetchSource(src({ retries: 2 }), opts(always()))).ok).toBe(false);
  });

  it('retries a transport error', async () => {
    expect((await fetchSource(src({ retries: 2 }), opts(always()))).attempts).toBe(3);
  });

  it('reports the underlying error text', async () => {
    const out = failed(await fetchSource(src({ retries: 2 }), opts(always())));
    expect(out.error).toMatch(/ECONNRESET/);
  });

  it('recovers when a later attempt connects', async () => {
    let n = 0;
    const impl: FetchImpl = async () => {
      n++;
      if (n < 2) throw new Error('ECONNRESET');
      return res('good');
    };
    const out = succeeded(await fetchSource(src(), opts(impl)));
    expect(decode(out.observed.body)).toBe('good');
  });

  it('reports the thrown value when it is not an Error', async () => {
    const impl: FetchImpl = async () => {
      throw 'plain string boom';
    };
    const out = failed(await fetchSource(src({ retries: 0 }), opts(impl)));
    expect(out.error).toBe('plain string boom');
  });
});

// ---------------------------------------------------------------------------

// A 25 second timeout against a real endpoint once truncated a body at 23,404
// of 57,859 bytes and produced unparseable JSON rather than an error status. A
// truncated body that happened to still parse would have been committed as a
// real change.
describe('the content-length guard', () => {
  const withHeaders = (body: string, headers: Record<string, string>): FetchImpl => async () =>
    res(body, { headers });

  it('refuses a body shorter than content-length', async () => {
    const out = await fetchSource(src({ retries: 0 }), opts(withHeaders('short', { 'content-length': '57859' })));
    expect(out.ok).toBe(false);
  });

  it('reports both sides of the shortfall', async () => {
    const out = failed(
      await fetchSource(src({ retries: 0 }), opts(withHeaders('short', { 'content-length': '57859' }))),
    );
    expect(out.error).toBe('truncated body: got 5 of content-length 57859');
  });

  it('accepts a body when content-length is absent', async () => {
    const impl: FetchImpl = async () => res('fine');
    const out = succeeded(await fetchSource(src(), opts(impl)));
    expect(decode(out.observed.body)).toBe('fine');
  });

  it('accepts a body that matches content-length exactly', async () => {
    const out = succeeded(await fetchSource(src(), opts(withHeaders('fine', { 'content-length': '4' }))));
    expect(decode(out.observed.body)).toBe('fine');
  });

  // Only short is wrong. A body longer than a stale content-length is not the
  // truncation this guard exists to catch.
  it('accepts a body longer than content-length', async () => {
    const out = succeeded(await fetchSource(src(), opts(withHeaders('fine', { 'content-length': '2' }))));
    expect(decode(out.observed.body)).toBe('fine');
  });

  // content-length then describes the compressed length while arrayBuffer
  // yields the decoded body, so the comparison would fail on every compressed
  // response.
  it('skips the guard when the response declares a content-encoding', async () => {
    const out = succeeded(
      await fetchSource(
        src({ retries: 0 }),
        opts(withHeaders('short', { 'content-length': '57859', 'content-encoding': 'gzip' })),
      ),
    );
    expect(decode(out.observed.body)).toBe('short');
  });

  // Number('abc') is NaN, and `5 < NaN` is already false, so this case passes
  // with or without the Number.isFinite guard. It is here to pin the NaN
  // semantics of the comparison itself, not the guard.
  it('accepts a body when content-length is not a number', async () => {
    const out = succeeded(
      await fetchSource(src({ retries: 0 }), opts(withHeaders('short', { 'content-length': 'abc' }))),
    );
    expect(decode(out.observed.body)).toBe('short');
  });

  // This is the case the Number.isFinite guard exists for: Number('1e400') is
  // Infinity, and every body is shorter than Infinity, so without the guard a
  // malformed content-length would condemn every response from that source
  // forever. No real endpoint sends this; the guard is cheap and the failure it
  // prevents is permanent.
  it('accepts a body when content-length overflows to Infinity', async () => {
    const out = succeeded(
      await fetchSource(src({ retries: 0 }), opts(withHeaders('short', { 'content-length': '1e400' }))),
    );
    expect(decode(out.observed.body)).toBe('short');
  });

  it('retries a truncated body', async () => {
    let n = 0;
    const impl: FetchImpl = async () => {
      n++;
      return n < 2 ? res('short', { headers: { 'content-length': '57859' } }) : res('the whole thing');
    };
    const out = await fetchSource(src({ retries: 2 }), opts(impl));
    expect(out.attempts).toBe(2);
  });

  it('returns the complete body once a retry delivers it', async () => {
    let n = 0;
    const impl: FetchImpl = async () => {
      n++;
      return n < 2 ? res('short', { headers: { 'content-length': '57859' } }) : res('the whole thing');
    };
    const out = succeeded(await fetchSource(src({ retries: 2 }), opts(impl)));
    expect(decode(out.observed.body)).toBe('the whole thing');
  });

  it('gives up after spending its retries on truncated bodies', async () => {
    const out = await fetchSource(src({ retries: 2 }), opts(withHeaders('short', { 'content-length': '57859' })));
    expect(out.attempts).toBe(3);
  });
});

// ---------------------------------------------------------------------------

describe('backoff between attempts', () => {
  const waitsFor = async (retries: number, impl: FetchImpl) => {
    const waits: number[] = [];
    await fetchSource(src({ retries }), opts(impl, { sleep: async (ms) => void waits.push(ms) }));
    return waits;
  };

  const alwaysFive = (): FetchImpl => async () => res('', { status: 500 });

  it('waits 2s then 8s across three attempts', async () => {
    expect(await waitsFor(2, alwaysFive())).toEqual([2000, 8000]);
  });

  it('holds at 8s rather than growing without bound', async () => {
    expect(await waitsFor(4, alwaysFive())).toEqual([2000, 8000, 8000, 8000]);
  });

  it('waits once before a single retry', async () => {
    expect(await waitsFor(1, alwaysFive())).toEqual([2000]);
  });

  it('does not wait before the first attempt', async () => {
    const ok: FetchImpl = async () => res('good');
    expect(await waitsFor(2, ok)).toEqual([]);
  });

  it('backs off before retrying a transport error too', async () => {
    const boom: FetchImpl = async () => {
      throw new Error('ECONNRESET');
    };
    expect(await waitsFor(2, boom)).toEqual([2000, 8000]);
  });
});

// ---------------------------------------------------------------------------

describe('the per-attempt timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // A request that never answers on its own. It settles only when the signal
  // this module installed fires, which is the thing under test.
  const hanging = () => {
    let signal: AbortSignal | undefined;
    const impl: FetchImpl = (_u, i) =>
      new Promise<Response>((_resolve, reject) => {
        signal = i.signal as AbortSignal;
        signal.addEventListener('abort', () => reject(new Error('timed out')));
      });
    return { impl, signal: () => signal! };
  };

  // These three deliberately do not await the fetchSource promise. It settles
  // only because of the abort under test, so awaiting it would turn a broken
  // timeout into a five second hang instead of a one line assertion failure.
  it('has not aborted one millisecond before the timeout', async () => {
    vi.useFakeTimers();
    const h = hanging();
    void fetchSource(src({ timeoutS: 5, retries: 0 }), opts(h.impl));
    await vi.advanceTimersByTimeAsync(4999);
    expect(h.signal().aborted).toBe(false);
  });

  it('aborts once timeoutS has elapsed', async () => {
    vi.useFakeTimers();
    const h = hanging();
    void fetchSource(src({ timeoutS: 5, retries: 0 }), opts(h.impl));
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.signal().aborted).toBe(true);
  });

  it('scales the timeout with timeoutS', async () => {
    vi.useFakeTimers();
    const h = hanging();
    void fetchSource(src({ timeoutS: 25, retries: 0 }), opts(h.impl));
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.signal().aborted).toBe(false);
  });

  it('reports a timed out attempt as a failure', async () => {
    vi.useFakeTimers();
    const h = hanging();
    const run = fetchSource(src({ timeoutS: 5, retries: 0 }), opts(h.impl));
    await vi.advanceTimersByTimeAsync(5000);
    expect((await run).ok).toBe(false);
  });

  // The abort timer must be cleared on every path out of an attempt, or a
  // finished collector sits holding one live handle per source. Nothing in the
  // returned outcome shows this, so the assertion is on the timer count itself:
  // pristine leaves none pending, a missing clearTimeout leaves one per attempt.
  it('clears the per-attempt timer after a successful attempt', async () => {
    vi.useFakeTimers();
    const impl: FetchImpl = async () => res('ok');
    await fetchSource(src({ timeoutS: 5, retries: 0 }), opts(impl));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the per-attempt timer when the redirect cap ends the attempt', async () => {
    vi.useFakeTimers();
    let n = 0;
    const impl: FetchImpl = async () => {
      n++;
      return new Response(null, { status: 301, headers: { location: `https://a.example/${n}` } });
    };
    await fetchSource(src({ timeoutS: 5, retries: 0, maxRedirects: 2 }), opts(impl));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the per-attempt timer of an attempt it retried past', async () => {
    vi.useFakeTimers();
    let n = 0;
    const impl: FetchImpl = async () => {
      n++;
      return n < 2 ? res('transient', { status: 503 }) : res('good');
    };
    await fetchSource(src({ timeoutS: 5, retries: 1 }), opts(impl));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the per-attempt timer when the attempt throws', async () => {
    vi.useFakeTimers();
    const impl: FetchImpl = async () => {
      throw new Error('ECONNRESET');
    };
    await fetchSource(src({ timeoutS: 5, retries: 0 }), opts(impl));
    expect(vi.getTimerCount()).toBe(0);
  });
});
