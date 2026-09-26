# The desk routine

What the scheduled cloud agent does. It runs EVERY TWO HOURS and does one of
two things.

**Most runs do nothing and end in seconds.** Build the queue, see that nothing
clears the interrupt floor, push the branch, send no mail, stop. That is the
expected outcome of eleven runs out of twelve and it is not a failure.

**The run in the 12:00 UTC hour also sends the digest.** The scheduler adds a
few minutes of jitter, so that run fires at 12:0x rather than exactly 12:00;
judge it by the hour, not the minute., which is the mail that has always
gone out: every candidate, its venue, its bits. Unchanged.

**A run at any hour sends an INTERRUPT** when `alert.ids` in the CLI output is
non-empty. That list is the CLI's decision and not yours: do not second-guess
the floor, do not mail about an item that is not in it, and do not withhold one
that is.

Why the interrupt exists, so nobody removes it as noise: the first stealth
listing this archive recorded was captured eighteen minutes before the first
person posted it to Hacker News, and the once-a-day desk showed it twenty-one
hours later. The collection layer was ahead of the world and the distribution
layer gave the lead away. It lives here rather than
inside the routine's configuration so that it is reviewable, diffable and
editable like everything else, and so a change to how the desk is filled leaves
a trace in the history.

**The desk** is `https://diffwire-desk.maxwellbrohm.workers.dev`, a Cloudflare Worker. Its
API takes the key as `?k=<key>` on every call; without it every endpoint answers
401.

`DESK_URL` and `DESK_KEY` are given to you **in the prompt**, not in the
environment. The routine API accepts an `environment_variables` field and then
silently drops it, which was measured rather than assumed: a run that echoed
`env | grep DESK` printed nothing. Export them yourself at the start of the run
from the values in the prompt.

The key belongs in the desk link and nowhere else. **Never** write it into a
commit, a branch name, an issue or a pull request: the repository is public. It
does have to appear in the link you email, because the page cannot read the desk
without it, and that is the one place it is meant to be.

It deliberately does not live on a Claude preview URL. The desk is opened from a
phone, most often by someone not signed in to anything, and a console that
depends on a second login is a console that does not get used.

It moved off Netlify on 2026-09-03 for a reason worth remembering: a day of
deploys and function testing for THIS project consumed a monthly credit
allowance shared with three live UA Design Group sites, and Netlify's own
warning said published sites would be suspended next. A side project must not
share a blast radius with a business. Cloudflare's free tier is 100,000 requests
a day with no credit pool to exhaust, and this Worker is alone on it.

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

## 2. Nothing. The ledger writes itself.

There is no step here any more, and that is the point. When Max taps a platform
on the desk, the desk's own function appends the row to `meta/posted.jsonl` on
`main` through the GitHub API, because it holds a token and can reach GitHub
even though it cannot reach you and you cannot reach it.

So by the time you clone, the ledger is already current, `npm run desk` has
already read it, and the cooldown has already been applied to the queue you are
about to publish. You neither read decisions nor write the ledger. Do not add a
step that does: two writers to an append-only file is how one of them ends up
clobbering the other.

## 3. Nothing here either.

`meta/posted.jsonl` is append-only and enforced by `tools/append-only.sh`, which
fails a diff that touches a line already written. It has exactly one writer, the
desk's function, and it should stay that way.

Skipped items need no cleanup: staleness costs a bit a day, so a six-bit
candidate falls under the floor in three and stops being offered on its own.

## 3b. Carry the alert state across runs

The `desk` branch holds TWO files now. Read `alerted.json` from it before
building the queue and pass it in, or every run will re-alert on the same item:

    git fetch -q origin desk 2>/dev/null || true
    export LCA_ALERT_STATE="$(git show origin/desk:alerted.json 2>/dev/null || echo '{"alerted":[]}')"

`npm run desk` then reports `alert.ids` (what to interrupt about now) and
`alert.next_state` (what to write back). Write `next_state` to `alerted.json`
in the same push as `queue.json`, ALWAYS, including on a run that alerted about
nothing: it is how the list stays bounded and how a crash between mail and push
cannot repeat an alert for ever.

## 4. Push today's queue to the `desk` branch

**You cannot POST to the desk.** This sandbox's egress proxy allows package
registries, the Anthropic API and GitHub, and rejects everything else with
`connect_rejected (organization policy)`. That is not a transient error and
there is nothing to retry. GitHub is the only channel you have, so the desk
pulls from a branch instead of being pushed to.

Write `{"candidates": [...], "funnel": {...}, "generated_at": "..."}` to a file,
taken **verbatim** from step 1's output, with one addition: give each draft a
`label` (hn is `Hacker News`, reddit is `Reddit`, bluesky is `Bluesky`, mastodon
is `Mastodon`, x is `X`, linkedin is `LinkedIn`).

Then publish it as a ONE-COMMIT ORPHAN branch, using plumbing so that nothing
touches the working tree, the current branch, or `main`:

    BLOB=$(git hash-object -w queue.json | tr -d '[:space:]')
    ABLOB=$(git hash-object -w alerted.json | tr -d '[:space:]')
    TREE=$(printf '100644 blob %s\talerted.json\n100644 blob %s\tqueue.json\n' "$ABLOB" "$BLOB" \
      | git mktree | tr -d '[:space:]')
    COMMIT=$(git commit-tree "$TREE" -m "desk queue $(date -u +%FT%TZ)" | tr -d '[:space:]')
    git push --force -q origin "${COMMIT}:refs/heads/desk"

`git mktree` wants its entries SORTED BY NAME, so `alerted.json` comes before
`queue.json`. Out of order it fails with a message about the tree rather than
about the order.

`tr -d` is not superstition: the command substitutions carry trailing
whitespace that silently corrupts the refspec into something git rejects with a
confusing message about a refspec that does not match.

**The orphan branch is the whole point.** `main`'s history IS the archive, and
every derivation walks it, so a daily housekeeping commit on `main` would be
writing into the evidence the product is made of. `desk` carries one commit with
one file and no ancestry, force-replaced each day. It is a mailbox, not history:
never merge it, never branch from it, and never add a second file to it.

**Do not rewrite a sentence, shorten one, or compose a new one.** A missing
draft for a platform is correct and already explained by `shortfalls`. Writing
your own version of a claim is the one thing this system exists to prevent.

You will see `title` and `titleBy: "template"` on Hacker News drafts. That title
was composed by `src/desk/titles.ts` from the event's own typed fields, every
value verbatim, and it is part of the CLI output you copy through untouched. Do
not edit it, improve it, or write one where the CLI produced none.

## 5. Tell Max

### The interrupt mail

Send this the moment `alert.ids` is non-empty, at whatever hour the run is.

Subject: `Diffwire: <the composed title, or the type and subject>`. One item per
mail. Body: the desk link, the bits, the sentence verbatim, the venue, and the
facts table. No preamble and no digest of the other candidates: this mail exists
because something is worth acting on now, and anything else in it competes.

### The digest mail

ONLY on the run whose UTC hour is 12. Skip it entirely at every other hour, even when
candidates are waiting: they will keep, and a digest every two hours is how an
inbox rule gets written.

Email maxwellbrohm@gmail.com if a Gmail connector is attached to this routine.
Subject: `Diffwire desk: N waiting` (or `nothing today`).

Body, plain text:

1. The desk link, `$DESK_URL/?k=$DESK_KEY`. The key has to be in the link or the
   page cannot read anything.
2. One block per candidate:

       [8.0 bits] r/LocalLLaMA
       The pull request numbered "vllm-project/vllm#54566" records a merged_at
       of "2026-09-02T18:09:10Z" in the collected search payload.

   **Name the venue.** It is `post.label` on the candidate, and leaving it out
   is what makes the mail untriageable: the whole question a reader has in an
   inbox is whether this is worth opening the desk for, and where it would go is
   most of that answer. A candidate with no `post` says `no venue routed`.
3. The funnel's `seen` count on its own line.

**NO EM DASHES.** Not in the subject, not in the body, not anywhere. Use a
comma, a colon, parentheses, or two sentences. This is a standing rule for
everything written on Max's behalf and the mail had been breaking it daily.

Do not restate a sentence in your own words, and do not add a summary line of
your own. Copy each sentence exactly as `npm run desk` printed it, for the same
reason the drafter never rewrites one: this is the point where a claim travels
furthest from the bytes that support it.

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
