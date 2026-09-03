# The posting desk

The review console for diffwire.dev, at
https://diffwire-desk.maxwellbrohm.workers.dev

## Why Cloudflare

It ran on Netlify for one day. In that day, seventeen production deploys and a
round of function testing for this side project consumed a 300-credit monthly
allowance shared with three live UA Design Group sites: a booking page, an RSVP
page and a payroll portal. Netlify paused production deploys and warned that
published sites were suspended next.

The lesson is not "deploy less carefully". It is that a side project should
never share a budget with a business, because no amount of care changes the
blast radius. Cloudflare's free tier is 100,000 requests a day with no credit
pool to run out of, and this Worker is alone on the account.

## Shape

A Worker with static assets and two KV keys, the same two the Netlify version
held as Blobs:

- `queue` — a manual override, replaced wholesale, absent by default
- `decisions` — what has been opened, skipped or posted, merged per item

Separate so that seeding a queue can never erase a decision about the last one.
By default there is no `queue` key at all and the desk reads the `desk` branch
on GitHub, which is the only channel the daily routine can reach.

## Secrets

    npx wrangler secret put DESK_KEY       # the ?k= in every request
    npx wrangler secret put GITHUB_TOKEN   # fine-grained PAT, Contents write, this repo

`DESK_KEY` is not authentication and does not pretend to be: an unguessable path
to a personal console, whose job is that a stranger who finds the host cannot
empty the queue. A missing one DENIES rather than allows.

## API

| | |
| --- | --- |
| `GET /api/queue` | today's candidates |
| `GET /api/decisions` | what has been opened, skipped or posted |
| `GET /api/health` | is this desk actually wired up |
| `POST /api/seed` | manual override; `{"candidates": null}` reverts to the branch |
| `POST /api/decide` | record one decision |
| `POST /api/clear` | drop settled decisions |

`/api/health` is read-only by design. The obvious way to test a write credential
is to write something, and here that would mean putting a row into a file whose
whole purpose is recording what was really pushed at people.

## Deploy

    cd desk-cf && npx wrangler deploy
