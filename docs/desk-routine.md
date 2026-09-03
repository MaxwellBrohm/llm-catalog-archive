# The daily desk routine

What the scheduled cloud agent does, once a day. It lives here rather than
inside the routine's configuration so that it is reviewable, diffable and
editable like everything else, and so a change to how the desk is filled leaves
a trace in the history.

**The desk** is the artifact at
`https://claude.ai/code/artifact/131f656d-3c54-4955-adbe-3417d221c1fe`.

**You never post anything to any platform.** Read `docs/posting.md` for why.
Your job ends when the desk is filled and Max has been told. Nothing you do is
visible to anyone outside this account.

## 0. Get the whole archive

The environment clones shallow, and **the archive is the git history**, so a
shallow clone is not a faster checkout of the same data: it is a smaller
archive. The score of every candidate comes from the distribution of event types
across all of it, so a truncated clone does not merely miss old items, it
changes the probability of every type and confidently ranks the wrong thing.

```
git rev-parse --is-shallow-repository
git fetch --unshallow    # only if that printed true
```

`npm run desk` refuses to run on a shallow clone rather than trusting you to
remember this, so if you skip it you get an error and not a wrong answer. Do not
work around that error by editing the check.

## 1. Build the queue

```
npm ci
npm run desk
```

Prints JSON: a `funnel` object and a `candidates` array. Read-only, writes
nothing, posts nothing. If it fails, stop and report the failure rather than
seeding a partial desk.

## 2. Read the current desk

Artifact tool, `action: "read_db"`, `db_op: "list"`, `collection: "queue"`,
`url` = the desk.

## 3. Retire what Max has already decided

A doc with `status: "skipped"`, or with a non-empty `posted` object, is a
decision already made. It should not be on tomorrow's desk.

Before deleting one whose `posted` object is non-empty, append one line to
`meta/posted.jsonl` for each platform key in it. Each line is a JSON object with
exactly these keys:

- `id` — the doc's `item_id`
- `platform` — the key from `posted`
- `entities` — the doc's `entities` array
- `posted_at` — the ISO string that key holds
- `permalink` — `null`
- `via` — `"human"`

**Append only.** Never edit, reorder or remove an existing line: that file is
the public record of what this account has pushed at people, and the commit hook
refuses a diff that touches a written line.

Then commit `meta/posted.jsonl` alone, on a new branch, and open a pull request
titled `desk: record what went out`. Never push to main. If there was nothing to
append, open no PR.

Delete the retired docs with `write_db`, `db_op: "delete"`.

## 4. Seed today's candidates

For each candidate not already on the desk, `write_db`, `db_op: "set"`,
`collection: "queue"`. Prefer one `db_op: "batch"` over several single writes.

The document id is the candidate's `id` with every character outside
`A-Za-z0-9_-.~:@+` replaced by a dash, truncated to 200 characters.

Fields, **copied verbatim from the CLI output**: `item_id` (the candidate's
`id`), `type`, `sentence`, `source`, `stamp_iso` (from `stamp.iso`, or null),
`bits`, `why`, `entities`, `facts`, `drafts`, `shortfalls`, plus
`status: "pending"`, `posted: {}`, `seen` (the funnel's `seen`), and `seeded_at`
(the output's `generated_at`).

Add a `label` to each draft: hn is `Hacker News`, reddit is `Reddit`, bluesky is
`Bluesky`, mastodon is `Mastodon`, x is `X`, linkedin is `LinkedIn`.

**Do not rewrite a sentence, shorten one, or compose a new one.** If a draft is
missing for a platform that is correct and already explained by `shortfalls`.
Writing your own version of a claim is the one thing this system exists to
prevent.

## 5. Tell Max

Email maxwellbrohm@gmail.com if a Gmail connector is attached to this routine.
Subject: `Diffwire desk: N waiting` (or `nothing today`). Body: the desk link,
then one line per candidate giving its bits and its sentence, and finally the
funnel's `seen` count. Plain text, no marketing voice, and do not restate the
sentences in your own words.

Include `seen` because it is the one number that reveals a truncated archive: it
should be in the hundreds and growing. If it drops sharply between days,
something has gone wrong with the clone and the scores that day are not
trustworthy.

If no Gmail connector is attached, say so plainly in your final message instead
of pretending the mail went out.

## A quiet day is the normal case

Most days produce no candidates. Seed nothing, send `nothing today`, and stop.
A desk that always has something on it means the floor is too low, and the cost
of that is not a wasted post: it is teaching the audience that this account is
noise.
