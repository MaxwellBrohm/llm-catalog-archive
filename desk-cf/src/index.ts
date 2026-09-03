/**
 * The posting desk, on Cloudflare Workers.
 *
 * MOVED OFF NETLIFY BECAUSE A SIDE PROJECT SHOULD NOT SHARE A BUDGET WITH A
 * BUSINESS. Seventeen production deploys and a day of function testing consumed
 * a 300-credit monthly allowance that also covers three live UA Design Group
 * sites: a booking page, an RSVP page and a payroll portal. Netlify paused
 * production deploys, and its own warning said published sites would be
 * suspended next. The desk was never worth that risk, and no amount of care
 * about deploy frequency fixes a shared blast radius: separating them does.
 *
 * The behaviour is deliberately identical to the Netlify version, because this
 * is a move and not a rewrite, and a move that also changes behaviour cannot be
 * verified against what it replaced. Two keys in KV, the same names as the two
 * Blobs keys: `queue` is a manual override replaced wholesale, `decisions` is
 * merged per item. Separate so seeding cannot erase a decision.
 */

const REPO = 'MaxwellBrohm/llm-catalog-archive';
const LEDGER_PATH = 'meta/posted.jsonl';
const API_URL = `https://api.github.com/repos/${REPO}/contents/queue.json?ref=desk`;
const RAW_URL = `https://raw.githubusercontent.com/${REPO}/desk/queue.json`;

type Env = {
  DESK: KVNamespace;
  DESK_KEY?: string;
  GITHUB_TOKEN?: string;
  LEDGER_BRANCH?: string;
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/**
 * Constant-time compare of the desk key.
 *
 * Not authentication and not pretending to be: an unguessable path to a
 * personal console, whose real job is that a stranger who finds the host cannot
 * empty the queue. A MISSING KEY ON THE SERVER DENIES rather than allows, which
 * is how a console usually ends up open to the world after a bad deploy.
 */
function authorized(request: Request, env: Env): boolean {
  const expected = env.DESK_KEY;
  if (!expected) return false;
  const given = new URL(request.url).searchParams.get('k') ?? '';
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const ledgerBranch = (env: Env): string => env.LEDGER_BRANCH || 'main';

/**
 * Read the queue branch.
 *
 * THE API, NOT raw.githubusercontent, and this was measured on the version this
 * replaces: after the `desk` branch was deleted outright, raw kept answering
 * 200 with the old file while the API correctly answered 404. A cache that
 * outlives the thing it caches turns "the routine did not run today" into "here
 * is yesterday's news, presented as today's".
 *
 * Raw stays as the fallback for the API's sixty-an-hour anonymous limit,
 * labelled so the page can say the answer may be stale.
 */
async function readQueueBranch(): Promise<
  { missing: true } | { error: number } | { queue: any; via: string }
> {
  const res = await fetch(API_URL, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'diffwire-desk' },
    cf: { cacheTtl: 0 },
  });
  if (res.status === 404) return { missing: true };
  if (res.ok) {
    const body = (await res.json()) as { content: string };
    return { queue: JSON.parse(atob(body.content.replace(/\n/g, ''))), via: 'api' };
  }
  if (res.status === 403 || res.status === 429) {
    const raw = await fetch(`${RAW_URL}?t=${Date.now()}`, { cf: { cacheTtl: 0 } });
    if (raw.status === 404) return { missing: true };
    if (raw.ok) return { queue: await raw.json(), via: 'raw (api rate-limited; may be stale)' };
  }
  return { error: res.status };
}

/**
 * Append one row to meta/posted.jsonl.
 *
 * APPEND, LITERALLY. The Contents API replaces a file wholesale, so the current
 * bytes are read and the row is concatenated. Nothing existing is parsed or
 * reformatted, because tools/append-only.sh rejects a diff that touches a
 * written line, and it is right to.
 *
 * THE BLOB SHA IS THE LOCK. A PUT carrying a stale sha is refused, which is
 * what should happen when the collector commits between our read and our write.
 */
async function appendToLedger(row: Record<string, unknown>, token: string, branch: string) {
  const base = `https://api.github.com/repos/${REPO}/contents/${LEDGER_PATH}`;
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'diffwire-desk',
    'content-type': 'application/json',
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    const read = await fetch(`${base}?ref=${branch}`, { headers, cf: { cacheTtl: 0 } });
    if (!read.ok) return { ok: false, why: `could not read the ledger (${read.status})` };
    const file = (await read.json()) as { content: string; sha: string };
    const current = new TextDecoder().decode(
      Uint8Array.from(atob(file.content.replace(/\n/g, '')), (c) => c.charCodeAt(0)),
    );

    // Idempotent on the pair actually posted to, which is item and VENUE, so a
    // double tap or a reloaded page cannot inflate the record of what was
    // really pushed at people.
    const marker = `"id":${JSON.stringify(row['id'])},"platform":${JSON.stringify(row['platform'])},"venue":${JSON.stringify(row['venue'])}`;
    if (current.includes(marker)) return { ok: true, already: true };

    const next =
      current + (current.length > 0 && !current.endsWith('\n') ? '\n' : '') + JSON.stringify(row) + '\n';
    const bytes = new TextEncoder().encode(next);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);

    const write = await fetch(base, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `desk: ${row['venue']} <- ${row['id']}`,
        content: btoa(binary),
        sha: file.sha,
        branch,
      }),
    });
    if (write.ok) {
      const done = (await write.json()) as { commit?: { sha?: string } };
      return { ok: true, commit: done.commit?.sha ?? null };
    }
    if (write.status !== 409 && write.status !== 422) {
      return { ok: false, why: `could not write the ledger (${write.status})` };
    }
  }
  return { ok: false, why: 'the ledger kept changing under us; not written' };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    if (!authorized(request, env)) return json({ error: 'not authorized' }, 401);

    const action = url.pathname.split('/').filter(Boolean).pop();

    if (request.method === 'GET' && action === 'queue') {
      // A manual seed wins, so the desk can be driven by hand when the routine
      // is broken. Otherwise read the branch the routine pushed.
      const seeded = await env.DESK.get('queue', 'json');
      if (seeded) return json({ ...(seeded as object), from: 'seed' });

      const out = await readQueueBranch();
      if ('missing' in out) {
        return json({ candidates: [], funnel: null, from: 'branch', note: 'no queue has been pushed yet' });
      }
      if ('error' in out) return json({ error: 'could not read the queue branch', status: out.error }, 502);
      return json({ ...out.queue, from: out.via });
    }

    if (request.method === 'GET' && action === 'decisions') {
      return json((await env.DESK.get('decisions', 'json')) ?? {});
    }

    /**
     * Read-only on purpose. The obvious way to test a write credential is to
     * write something, and here that would mean putting a row into a file whose
     * entire purpose is to record what was really pushed at people.
     */
    if (request.method === 'GET' && action === 'health') {
      const token = env.GITHUB_TOKEN;
      const branch = ledgerBranch(env);
      const out: Record<string, unknown> = { key: 'accepted', token: Boolean(token), ledger: null, queue: null };

      if (token) {
        const res = await fetch(
          `https://api.github.com/repos/${REPO}/contents/${LEDGER_PATH}?ref=${branch}`,
          { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'diffwire-desk' }, cf: { cacheTtl: 0 } },
        );
        if (res.ok) {
          const file = (await res.json()) as { content: string };
          const text = atob(file.content.replace(/\n/g, ''));
          out['ledger'] = {
            readable: true,
            rows: text.split('\n').filter((l) => l.trim().length > 0).length,
            path: `${branch}:${LEDGER_PATH}`,
          };
        } else {
          out['ledger'] = {
            readable: false, status: res.status,
            why: res.status === 401 ? 'the token was rejected'
              : res.status === 404 ? 'the token cannot see this repository or that path' : 'unexpected',
          };
        }
      }

      const branchOut = await readQueueBranch();
      out['queue'] = 'missing' in branchOut ? { present: false }
        : 'error' in branchOut ? { present: false, status: branchOut.error }
        : { present: true, candidates: branchOut.queue.candidates?.length ?? 0, generated_at: branchOut.queue.generated_at ?? null, via: branchOut.via };
      out['host'] = 'cloudflare';
      return json(out);
    }

    if (request.method === 'POST' && action === 'seed') {
      const body = (await request.json()) as { candidates?: unknown };
      if (body && body.candidates === null) {
        await env.DESK.delete('queue');
        return json({ ok: true, from: 'branch' });
      }
      if (!Array.isArray(body?.candidates)) return json({ error: 'candidates must be an array' }, 400);
      await env.DESK.put('queue', JSON.stringify({ ...body, seeded_at: new Date().toISOString() }));
      return json({ ok: true, candidates: body.candidates.length });
    }

    /**
     * OPENING A FORM IS NOT POSTING. Conflating the two put a false line in a
     * public append-only record within a day: the button was pressed,
     * r/LocalLLaMA refused the submission for having no flair, and the ledger
     * said the post had gone out anyway. A press records `opened` and writes
     * nothing; only a confirmation writes the row.
     */
    if (request.method === 'POST' && action === 'decide') {
      const { id, status, venue, state } = (await request.json()) as {
        id?: string; status?: string; venue?: string; state?: string;
      };
      if (typeof id !== 'string' || id.length === 0) return json({ error: 'id is required' }, 400);

      const decisions = ((await env.DESK.get('decisions', 'json')) ?? {}) as Record<string, any>;
      const row = decisions[id] ?? { status: 'pending', opened: {}, posted: {} };
      row.opened = row.opened ?? {};
      row.posted = row.posted ?? {};
      if (status === 'skipped') row.status = 'skipped';

      let ledger: unknown = null;
      if (typeof venue === 'string' && venue.length > 0) {
        const at = new Date().toISOString();

        if (state !== 'confirmed' && state !== 'failed') {
          row.opened[venue] = at;
          decisions[id] = row;
          await env.DESK.put('decisions', JSON.stringify(decisions));
          return json({ ok: true, [id]: row, ledger: { ok: true, pending: 'awaiting confirmation' } });
        }
        if (state === 'failed') {
          delete row.opened[venue];
          decisions[id] = row;
          await env.DESK.put('decisions', JSON.stringify(decisions));
          return json({ ok: true, [id]: row, ledger: { ok: true, cleared: venue } });
        }

        // The id AND the venue must both be on the current desk. The key
        // travels in a URL and in email, so it is the kind of secret that
        // eventually leaks, and this bounds what a leaked one can write into a
        // public repository to rows the archive actually produced and routed.
        const branch = await readQueueBranch();
        const candidate = 'queue' in branch
          ? branch.queue.candidates?.find((c: any) => c.id === id)
          : null;
        const draft = candidate
          ? [candidate.post, ...(candidate.others ?? [])].find((d: any) => d && d.venue === venue)
          : null;

        /**
         * MARKED POSTED ONLY IF THE CLAIM WAS COHERENT, and this ordering is
         * the fix for a bug found by exercising it: `posted` used to be set
         * before validation, so a venue the desk had just REFUSED to record
         * still showed as posted on the card and was suppressed from every
         * future run. The two refusals below mean the request could not have
         * come from a button on this desk, so nothing about it is believed.
         *
         * A missing token or a failed write is different: a person really did
         * post, and only our record of it failed. Those still mark it, and the
         * `ledger` field says what went wrong.
         */
        if (!candidate) {
          ledger = { ok: false, why: 'that id is not on the current desk; nothing written to the ledger' };
        } else if (!draft) {
          ledger = { ok: false, why: `${venue} is not a venue routed for that item; nothing written to the ledger` };
        } else if (!env.GITHUB_TOKEN) {
          row.posted[venue] = at;
          delete row.opened[venue];
          ledger = { ok: false, why: 'no GITHUB_TOKEN configured; the ledger was not written' };
        } else {
          row.posted[venue] = at;
          delete row.opened[venue];
          ledger = await appendToLedger(
            { id, platform: draft.platform, venue, entities: candidate.entities ?? [], posted_at: at, permalink: null, via: 'human' },
            env.GITHUB_TOKEN,
            ledgerBranch(env),
          );
        }
      }

      decisions[id] = row;
      await env.DESK.put('decisions', JSON.stringify(decisions));
      return json({ ok: true, [id]: row, ledger });
    }

    if (request.method === 'POST' && action === 'clear') {
      const { ids } = (await request.json()) as { ids?: unknown };
      if (!Array.isArray(ids)) return json({ error: 'ids must be an array' }, 400);
      const decisions = ((await env.DESK.get('decisions', 'json')) ?? {}) as Record<string, unknown>;
      for (const id of ids) delete decisions[id as string];
      await env.DESK.put('decisions', JSON.stringify(decisions));
      return json({ ok: true, remaining: Object.keys(decisions).length });
    }

    return json({ error: 'no such action' }, 404);
  },
} satisfies ExportedHandler<Env>;
