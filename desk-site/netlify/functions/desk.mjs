/**
 * The posting desk's state.
 *
 * THE QUEUE IS PULLED, NOT PUSHED, and that is not a preference. The routine
 * that builds it runs in a cloud sandbox whose egress proxy allows package
 * registries, the Anthropic API and GitHub, and refuses everything else: its
 * POST to this host came back `connect_rejected (organization policy)`. GitHub
 * is therefore the only channel between the routine and this site, so the
 * routine force-pushes a one-commit orphan branch and this function reads it.
 *
 * The orphan branch matters. The repository's main history IS the archive, the
 * product is derived from it by walking it, and a daily housekeeping commit on
 * main would be writing into the evidence. `desk` is a mailbox, not history.
 *
 * DECISIONS STAY HERE, in Netlify Blobs, because they are the one thing written
 * from a phone rather than from the routine. A free-tier Postgres that pauses
 * when it is read a few times a day is a worse fit than a key-value store that
 * does not care.
 *
 * THE KEY IS NOT AUTHENTICATION and is not pretending to be. It is an
 * unguessable path to a personal console, the same posture as an unlisted URL,
 * and its whole job is to stop a stranger who stumbles on the host from
 * emptying the queue. It is compared in constant time anyway, because doing the
 * lazy thing here costs nothing to avoid and teaches the wrong habit.
 */

import { getStore } from '@netlify/blobs';
import { timingSafeEqual } from 'node:crypto';

const REPO = 'MaxwellBrohm/llm-catalog-archive';
const LEDGER_PATH = 'meta/posted.jsonl';
// Overridable so the append can be exercised for real against a scratch branch
// without writing into the archive. Production sets nothing and gets main.
const LEDGER_BRANCH = process.env.LEDGER_BRANCH || 'main';
const API_URL = `https://api.github.com/repos/${REPO}/contents/queue.json?ref=desk`;
const RAW_URL = `https://raw.githubusercontent.com/${REPO}/desk/queue.json`;

/**
 * Read the queue branch.
 *
 * THE API, NOT raw.githubusercontent, and this was measured. After the `desk`
 * branch was deleted outright, raw kept answering 200 with the old file while
 * the API correctly answered 404. A cache that outlives the thing it is caching
 * turns "the routine did not run today" into "here is yesterday's news,
 * presented as today's", which is the one failure this whole project exists to
 * not commit.
 *
 * Raw stays as the fallback for the API's 60-requests-an-hour anonymous limit,
 * because a stale queue beats no queue, and `generated_at` travels to the page
 * either way so a reader can always see how old the answer is.
 */
async function readQueueBranch() {
  const res = await fetch(API_URL, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'diffwire-desk' },
    cache: 'no-store',
  });
  if (res.status === 404) return { missing: true };
  if (res.ok) {
    const body = await res.json();
    return { queue: JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')), via: 'api' };
  }
  // 403 is the anonymous rate limit, which is shared across everything leaving
  // this function's egress IP and so is not under our control.
  if (res.status === 403 || res.status === 429) {
    const raw = await fetch(RAW_URL + '?t=' + Date.now(), { cache: 'no-store' });
    if (raw.status === 404) return { missing: true };
    if (raw.ok) return { queue: await raw.json(), via: 'raw (api rate-limited; may be stale)' };
  }
  return { error: res.status };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

function authorized(request) {
  const expected = process.env.DESK_KEY;
  // A missing key on the server must DENY, not allow. The opposite is the
  // classic way a console ends up open to the world after a failed deploy.
  if (!expected) return false;
  const given = new URL(request.url).searchParams.get('k') ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Append one row to meta/posted.jsonl on main.
 *
 * WHY THE FUNCTION AND NOT THE ROUTINE. The routine cannot reach this host, and
 * this host cannot be reached BY it, so the decision Max makes on his phone has
 * no path back to the archive except the one thing both ends can talk to, which
 * is GitHub. The function has the token, so the function writes the row.
 *
 * APPEND, LITERALLY. The Contents API replaces a file wholesale, so the current
 * bytes are read and the row is concatenated onto them. Nothing existing is
 * parsed, reformatted or rewritten: a line that is already in the ledger comes
 * back out byte for byte, because the append-only workflow rejects a diff that
 * touches a written line and it is right to.
 *
 * THE SHA IS THE LOCK. A PUT carrying a stale blob sha is refused ("does not
 * match"), which is exactly the behaviour wanted when the daily collector
 * commits between our read and our write. Verified against the real API before
 * this was written, on a scratch branch, including the refusal.
 */
export async function appendToLedger(row, token) {
  const base = `https://api.github.com/repos/${REPO}/contents/${LEDGER_PATH}`;
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'diffwire-desk',
    'content-type': 'application/json',
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    const read = await fetch(`${base}?ref=${LEDGER_BRANCH}`, { headers, cache: 'no-store' });
    if (!read.ok) return { ok: false, why: `could not read the ledger (${read.status})` };
    const file = await read.json();
    const current = Buffer.from(file.content, 'base64').toString('utf8');

    // Idempotent: the same item and platform never gets a second row, so a
    // double tap, a retry, or a page reloaded twice cannot inflate the record
    // of what was actually pushed at people.
    if (current.includes(`"id":${JSON.stringify(row.id)},"platform":${JSON.stringify(row.platform)}`)) {
      return { ok: true, already: true };
    }

    const next = current + (current.length > 0 && !current.endsWith('\n') ? '\n' : '') +
      JSON.stringify(row) + '\n';

    const write = await fetch(base, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `desk: ${row.platform} <- ${row.id}`,
        content: Buffer.from(next, 'utf8').toString('base64'),
        sha: file.sha,
        branch: LEDGER_BRANCH,
      }),
    });
    if (write.ok) return { ok: true, commit: (await write.json()).commit?.sha ?? null };
    // 409 is the collector having committed between our read and our write.
    // Re-read and try again; anything else is not ours to retry.
    if (write.status !== 409 && write.status !== 422) {
      return { ok: false, why: `could not write the ledger (${write.status})` };
    }
  }
  return { ok: false, why: 'the ledger kept changing under us; not written' };
}

export default async (request) => {
  if (!authorized(request)) return json({ error: 'not authorized' }, 401);

  const store = getStore({ name: 'desk', consistency: 'strong' });
  const url = new URL(request.url);
  const action = url.pathname.split('/').filter(Boolean).pop();

  if (request.method === 'GET' && action === 'queue') {
    // A manual seed wins, so the desk can still be driven by hand when the
    // routine is broken. Otherwise read the branch the routine pushed.
    const seeded = await store.get('queue', { type: 'json' });
    if (seeded) return json({ ...seeded, from: 'seed' });

    const out = await readQueueBranch();
    if (out.missing) {
      return json({ candidates: [], funnel: null, from: 'branch', note: 'no queue has been pushed yet' });
    }
    if (out.error) return json({ error: 'could not read the queue branch', status: out.error }, 502);
    return json({ ...out.queue, from: out.via });
  }

  // Manual override, kept for when the routine cannot run. Replaces the day's
  // queue wholesale; decisions live under a separate key so a seed can never
  // clobber one. POST {"candidates": null} to drop back to the branch.
  if (request.method === 'POST' && action === 'seed') {
    const peek = request.clone();
    const maybe = await peek.json().catch(() => null);
    if (maybe && maybe.candidates === null) {
      await store.delete('queue');
      return json({ ok: true, from: 'branch' });
    }
    const body = await request.json();
    if (!Array.isArray(body?.candidates)) return json({ error: 'candidates must be an array' }, 400);
    await store.setJSON('queue', { ...body, seeded_at: new Date().toISOString() });
    return json({ ok: true, candidates: body.candidates.length });
  }

  // A decision from the page. Recorded per item id, merged rather than
  // replaced, so posting to a second platform does not erase the first.
  if (request.method === 'POST' && action === 'decide') {
    const { id, status, platform } = await request.json();
    if (typeof id !== 'string' || id.length === 0) return json({ error: 'id is required' }, 400);

    const decisions = (await store.get('decisions', { type: 'json' })) ?? {};
    const row = decisions[id] ?? { status: 'pending', posted: {} };
    if (status === 'skipped') row.status = 'skipped';

    let ledger = null;
    if (typeof platform === 'string' && platform.length > 0) {
      const at = new Date().toISOString();
      row.posted[platform] = at;

      // The id must be a candidate currently on the desk. The key travels in a
      // URL and in email, so it is the kind of secret that eventually leaks,
      // and this bounds what a leaked one can write into a public repository to
      // rows about items the archive actually produced.
      const branch = await readQueueBranch();
      const candidate = branch.queue?.candidates?.find((c) => c.id === id);
      if (!candidate) {
        ledger = { ok: false, why: 'that id is not on the current desk; nothing written to the ledger' };
      } else if (!process.env.GITHUB_TOKEN) {
        ledger = { ok: false, why: 'no GITHUB_TOKEN configured; the ledger was not written' };
      } else {
        ledger = await appendToLedger(
          {
            id,
            platform,
            entities: candidate.entities ?? [],
            posted_at: at,
            permalink: null,
            via: 'human',
          },
          process.env.GITHUB_TOKEN,
        );
      }
    }

    decisions[id] = row;
    await store.setJSON('decisions', decisions);
    return json({ ok: true, [id]: row, ledger });
  }

  if (request.method === 'GET' && action === 'decisions') {
    return json((await store.get('decisions', { type: 'json' })) ?? {});
  }

  // The routine clears what it has already written into meta/posted.jsonl, so
  // yesterday's settled rows do not accumulate forever.
  if (request.method === 'POST' && action === 'clear') {
    const { ids } = await request.json();
    if (!Array.isArray(ids)) return json({ error: 'ids must be an array' }, 400);
    const decisions = (await store.get('decisions', { type: 'json' })) ?? {};
    for (const id of ids) delete decisions[id];
    await store.setJSON('decisions', decisions);
    return json({ ok: true, remaining: Object.keys(decisions).length });
  }

  return json({ error: 'no such action' }, 404);
};
