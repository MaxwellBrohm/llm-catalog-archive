# The collected bytes

`raw/` and `backfill/` are not this project's work. They are other people's
files, stored verbatim, and this file states what that means before anyone
depends on them.

## What is stored

One directory per source under `raw/<source-id>/`, holding the response body
exactly as received and a `headers.json` sidecar recording a fixed allowlist of
response headers plus the observation time. Bodies are stored unmodified: no
normalising, no parsing, no schema at write time. The sources are public
documentation indexes, machine-readable model catalogues, sitemaps, status
feeds and public search endpoints, listed in `meta/sources.json`.

## Who owns it

Each vendor owns what it published. Storing a copy does not transfer anything,
and the MIT grant in LICENSE explicitly does not extend to these directories. If
you want to redistribute any of it, that is between you and the party that
published it.

## Why it is kept rather than summarised

Every claim this project publishes links to the exact bytes it was derived from,
at the exact commit that stored them. Discarding the bytes would leave the
claims unverifiable, which would remove the only thing that distinguishes this
archive from a feed of assertions. That is the whole argument for keeping them,
and it is worth weighing against the costs below rather than assuming it wins.

## Personal data

Three sources carry content written by named individuals.

`modelsdev-commits` is an Atom feed of commits to models.dev. Atom commit
entries carry an `<email>` element for every author and for every
`Co-authored-by:` trailer. Nine distinct addresses reached the published site
this way, four of them personal, before the publication began masking every
address in a rendered diff. The masking is a property of the site, not of the
archive: the stored bytes still contain the addresses.

`transformers-pulls` and `vllm-pulls` are GitHub pull-request searches. Their
payloads carry each pull request's full description text and its author's login,
numeric id, avatar URL and profile URL. Those fields are stored and have never
been rendered; the derivation reads only number, title, state and merge time.

**An erasure request against this repository cannot be satisfied without
rewriting history, which is the one thing the archive's rules forbid.** That is
a real and unresolved cost, not a technicality, and it is stated here and on the
site's About page rather than buried. Anyone who wants their data out should
open an issue; the answer will be a real answer about a real conflict, not a
form reply.

## Robots, rate and identification

Every request carries a descriptive User-Agent naming this repository, so any
operator who wants to block it can. Collection runs on a schedule measured in
hours, one request per source per run, serially. No endpoint is polled faster
than its own cache lifetime. Nothing here attempts to reach content behind
authentication, and a source that begins requiring a login is marked dark rather
than worked around.

## Credentials found in collected bytes

A vendor once published a live API key in its own public `llms.txt`. The
collector's credential gate holds any snapshot containing a credential pattern
out of the archive rather than committing it, and that source stays held until
the vendor fixes it. Nothing is written on the assumption that a published
secret was meant to be published.

## If you are a vendor and want this stopped

Open an issue, or block the User-Agent. Either works and neither will be argued
with.
