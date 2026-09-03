# The posting desk

The review console for diffwire.dev, at https://diffwire-desk.netlify.app.

Deliberately not a Claude preview URL and deliberately not a file path. It is
opened from a phone, usually first thing in the morning, by someone who is not
signed in to anything: a console behind a second login does not get used, and a
`file://` link cannot work at all, because the routine that fills this runs in a
cloud sandbox with no access to any particular machine and mail clients do not
open local files anyway.

## Shape

Static page, one function, Netlify Blobs. Two keys in the store:

- `queue` — today's candidates, replaced wholesale by the daily routine
- `decisions` — what Max has skipped or posted, merged per item

They are separate so that seeding tomorrow's queue can never erase a decision
made about today's.

## The key

`DESK_KEY`, a Netlify environment variable, passed as `?k=` on every API call.
It is not authentication and is not pretending to be: it is an unguessable path
to a personal console. What it actually buys is that a stranger who finds the
host cannot empty the queue.

A missing `DESK_KEY` on the server DENIES rather than allows, which is the
opposite of how a console usually ends up open to the world after a bad deploy.
The comparison is constant-time because avoiding that costs nothing.

## API

| | |
| --- | --- |
| `GET /api/queue` | today's candidates |
| `GET /api/decisions` | what has been skipped or posted |
| `POST /api/seed` | routine writes the day's queue |
| `POST /api/decide` | page records one decision |
| `POST /api/clear` | routine drops decisions it has written to the ledger |

## Deploy

    cd desk-site && netlify deploy --prod --dir public --functions netlify/functions
