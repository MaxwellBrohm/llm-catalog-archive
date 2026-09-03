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
| `POST /api/clear` | drop settled decisions |
| `GET /api/health` | is this desk actually wired up |

## Checking it works

    curl -s "$DESK_URL/api/health?k=$DESK_KEY"

Reports whether the token is present, whether it can read
`main:meta/posted.jsonl` (the exact path a write targets), how many rows the
ledger holds, and how old the queue is.

**Read-only on purpose.** The obvious way to test a write credential is to write
something, and here that would mean putting a row into a file whose entire
purpose is to record what was really pushed at people. A ledger with a test row
in it is not a ledger.

A read does not prove the token can WRITE: a Contents-read-only PAT passes this
check. To prove the write without touching the real ledger, point the function
at a scratch branch, exercise it, and put it back:

    gh api repos/<repo>/git/refs -f ref=refs/heads/ledger-probe -f sha=<main sha>
    netlify env:set LEDGER_BRANCH ledger-probe --context production
    netlify deploy --prod --dir public --functions netlify/functions
    # ... press a button, check the branch ...
    netlify env:unset LEDGER_BRANCH --context production
    netlify deploy --prod --dir public --functions netlify/functions
    gh api repos/<repo>/git/refs/heads/ledger-probe -X DELETE

`LEDGER_BRANCH` exists for exactly this. Production sets nothing and gets main.

## The ledger write

Pressing a platform button appends a row to `meta/posted.jsonl` on `main`
through the GitHub API. This function is that file's ONLY writer.

It is the writer because of a wall rather than a preference: the daily routine
runs in a sandbox that cannot reach this host, and this host cannot reach the
routine. GitHub is the only thing both ends can talk to, and the function is the
end that can hold a token.

Three properties, each verified against the real API before the code shipped:

- **Append, literally.** The Contents API replaces a file wholesale, so the
  current bytes are read and the row is concatenated. Nothing existing is
  parsed or reformatted, because `tools/append-only.sh` rejects a diff that
  touches a written line.
- **The blob sha is the lock.** A PUT carrying a stale sha is refused, which is
  what should happen when the collector commits between the read and the write.
  A conflict re-reads and retries; four attempts, then it gives up and says so.
- **Idempotent per item and platform.** A double tap, a retry or a reloaded page
  cannot add a second row for the same pair, so the record of what was pushed at
  people cannot inflate.

An id that is not on the current desk is refused before any write is attempted.
The key travels in URLs and email, so it is the kind of secret that eventually
leaks, and this bounds what a leaked one can put into a public repository.

`GITHUB_TOKEN` is a fine-grained PAT with **Contents: read and write on this one
repository**. Without it the desk still works and every decision reports
`no GITHUB_TOKEN configured` rather than failing silently.

## Deploy

    cd desk-site && netlify deploy --prod --dir public --functions netlify/functions
