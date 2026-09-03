/**
 * The posting desk's state.
 *
 * ONE STORE, THREE VERBS. The routine seeds the day's candidates, the page
 * reads them, and the page records a decision. Netlify Blobs holds it because
 * the alternative that fits this shape is a Postgres that would sit idle six
 * days a week: this is read a few times a day by one person, and a free-tier
 * database that pauses under exactly that access pattern is a worse fit than a
 * key-value store that does not care.
 *
 * THE KEY IS NOT AUTHENTICATION and is not pretending to be. It is an
 * unguessable path to a personal console, the same posture as an unlisted URL,
 * and its whole job is to stop a stranger who stumbles on the host from
 * emptying the queue. It is compared in constant time anyway, because doing the
 * lazy thing here costs nothing to avoid and teaches the wrong habit.
 */

import { getStore } from '@netlify/blobs';
import { timingSafeEqual } from 'node:crypto';

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

export default async (request) => {
  if (!authorized(request)) return json({ error: 'not authorized' }, 401);

  const store = getStore({ name: 'desk', consistency: 'strong' });
  const url = new URL(request.url);
  const action = url.pathname.split('/').filter(Boolean).pop();

  if (request.method === 'GET' && action === 'queue') {
    const queue = (await store.get('queue', { type: 'json' })) ?? { candidates: [], funnel: null };
    return json(queue);
  }

  // The routine's write. Replaces the day's queue wholesale; decisions live in
  // a separate key so seeding can never clobber one.
  if (request.method === 'POST' && action === 'seed') {
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
    if (typeof platform === 'string' && platform.length > 0) {
      row.posted[platform] = new Date().toISOString();
    }
    decisions[id] = row;
    await store.setJSON('decisions', decisions);
    return json({ ok: true, [id]: row });
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
