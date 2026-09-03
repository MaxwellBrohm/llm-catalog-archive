# The daily desk routine

What the scheduled cloud agent does, once a day. It lives here rather than
inside the routine's configuration so that it is reviewable, diffable and
editable like everything else, and so a change to how the desk is filled leaves
a trace in the history.

**The desk** is `https://diffwire-desk.netlify.app`, Max's own Netlify site. Its
API needs the key in `DESK_KEY`, passed as `?k=<key>` on every call; without it
every endpoint answers 401. Never put the key in a commit, an issue, a PR or the
body of the email: it belongs only in the link.

It deliberately does not live on a Claude preview URL. The desk is opened from a
phone, most often by someone not signed in to anything, and a console that
depends on a second login is a console that does not get used.

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
npm run desk --silent > queue.json
```

Prints JSON and nothing else: a `funnel` object and a `candidates` array.
Read-only, writes nothing, posts nothing.

`--silent` is not optional. Without it npm prepends its own two-line banner to
stdout and the output stops being parseable, which costs you a detour into
stripping lines off the front of your own data. If it fails, stop and report the failure rather than
seeding a partial desk.

## 2. Read the decisions Max has already made

    curl -s "$DESK_URL/api/decisions?k=$DESK_KEY"

An object keyed by candidate id, each `{status, posted}`. `status: "skipped"` or
a non-empty `posted` means Max has dealt with that item.

## 3. Write what went out into the ledger

For every decision whose `posted` object is non-empty, append one line to
`meta/posted.jsonl` per platform key. Each line is a JSON object with exactly
these keys:

- `id` — the candidate id the decision is keyed by
- `platform` — the key from `posted`
- `entities` — that candidate's `entities` array, from step 1's output
- `posted_at` — the ISO string that key holds
- `permalink` — `null`
- `via` — `"human"`

**Append only.** Never edit, reorder or remove an existing line: that file is
the record of what this account has pushed at people, and the commit hook
refuses a diff that touches a written line.

Then commit `meta/posted.jsonl` alone, on a new branch, and open a pull request
titled `desk: record what went out`. Never push to main. If there was nothing to
append, open no PR.

Once a decision is in the PR, clear it so it does not accumulate:

    curl -s -X POST "$DESK_URL/api/clear?k=$DESK_KEY" \
      -H 'content-type: application/json' -d '{"ids": ["..."]}'

Clear the skipped ones too. They fall off the desk on their own anyway, because
staleness costs a bit a day and a six-bit item drops under the floor in three,
but a decision that has been acted on should not linger.

## 4. Seed today's candidates

POST the whole queue. The seed replaces the day's list wholesale and cannot
touch decisions, which live under a separate key:

    curl -s -X POST "$DESK_URL/api/seed?k=$DESK_KEY" \
      -H 'content-type: application/json' -d @queue.json

The body is `{"candidates": [...], "funnel": {...}}`, taken **verbatim** from
step 1's output, with one addition: give each draft a `label` (hn is
`Hacker News`, reddit is `Reddit`, bluesky is `Bluesky`, mastodon is `Mastodon`,
x is `X`, linkedin is `LinkedIn`).

**Do not rewrite a sentence, shorten one, or compose a new one.** A missing
draft for a platform is correct and already explained by `shortfalls`. Writing
your own version of a claim is the one thing this system exists to prevent.

## 5. Tell Max

Email maxwellbrohm@gmail.com if a Gmail connector is attached to this routine.
Subject: `Diffwire desk: N waiting` (or `nothing today`). Body: the desk link,
which is `$DESK_URL/?k=$DESK_KEY` (the key has to be in the link or the page
cannot read anything),
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
