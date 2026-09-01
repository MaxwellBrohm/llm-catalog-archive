# llm-catalog-archive

A byte-level archive of what model providers actually publish, and a publication
derived from it. Every sentence on the site links to the exact bytes it came
from, at the exact commit that stored them.

Live: <https://maxwellbrohm.github.io/llm-catalog-archive/>

## Try it

This is the first thing to run. It needs no key, no signup and no install.

```bash
npx -y github:MaxwellBrohm/llm-catalog-archive leaks --tier confirmed-artifact
```

Output, run against the published API on 1 September 2026. The archive is live,
so your run will differ; what should not differ is that every row is a real
record with an artifact permalink behind it:

```
WHEN                                    TIER                TYPE                  SUBJECT
2026-09-01T05:22:37.000Z (origin_date)  confirmed-artifact  expiration_scheduled  nex-agi/nex-n2-mini
2026-09-01T05:22:37.000Z (origin_date)  confirmed-artifact  expiration_scheduled  nex-agi/nex-n2-pro
2026-08-31T19:06:32.000Z (origin_date)  confirmed-artifact  codename_entered      teffa-alpha
2026-08-31T19:06:32.000Z (origin_date)  confirmed-artifact  codename_entered      yangcheng
2026-08-30T21:14:08.000Z (origin_date)  confirmed-artifact  expiration_scheduled  moonshotai/kimi-k2.5

5 item(s). The tier is about the artifact, not about confidence.
0 refusal(s): changes the desk read and declined to derive from.
```

`teffa-alpha` and `yangcheng` are names that appeared in a public leaderboard
payload and are attached to no announced model. The tier says the artifact is a
capture we hold, not that anyone is confident about what the name means.

## The query this exists for

"Does anything I depend on retire inside my planning horizon?"

```bash
npx -y github:MaxwellBrohm/llm-catalog-archive retiring --within 90d
```

It exits 1 when something is inside the window, so it works as a CI gate. It
exits **2** when it cannot answer for a name you asked about, which matters more
than it sounds: retirement floors are collected from provider deprecation
tables, and the archive currently holds one such table. A gate that returned 0
for every other vendor would be passing on ignorance rather than on evidence, so
it refuses to, and every run prints which providers it actually covers.

It will not join an OpenRouter catalogue id to a provider's own API model name.
`anthropic/claude-opus-4.1` and `claude-opus-4-1-20250805` are different strings
issued by different parties, and guessing wrong about a retirement date is worse
than saying "not recorded".

## The rest of the CLI

```
llmcat models [--lab <lab>] [--limit <n>]     the current catalogue state
llmcat watch <model-id> [--once]              everything attached to one model
llmcat price-history <model-id>               every listed-price change
llmcat leaks [--tier <tier>]                  the desk
llmcat retiring [--within 90d] [--models a,b] the killer query
```

Every command takes `--json` to print records instead of a table, and
`--api <base>` to read a local mirror instead of the network.

## The API

Flat JSON on the same GitHub Pages deployment, no key and no rate limit:
<https://maxwellbrohm.github.io/llm-catalog-archive/api/v1/index.json>

`index.json` lists every other file, including which micro-categories and which
labs exist, so a client can tell "this lab has nothing" from "the deploy broke".

## What it will not say

The subject of every generated sentence is an artifact, never a company and
never a reason. "OpenRouter's catalog `context_length` for X changed from A to
B" is an observation. "X's usable context was cut" is an inference, and one live
case shows why it is the wrong one: a catalogue `context_length` rose from
1048576 to 1310720 while the `top_provider.context_length` beside it fell to
262144. The headline number went up by a quarter while what the routed provider
serves fell by three quarters.

There is no language model anywhere in the generator. Templates are filled from
diffs and from the sidecar committed beside the bytes.

It also declines to print dates it cannot support. Every
`first_seen_in_catalog_at` field is currently null, because the measured
worst-case error for that source is 348,766 seconds against an 86,400-second
gate. Publishing 621 nulls instead of 621 plausible dates is the point, not a
gap.

## How it works

1. A scheduled job fetches each source and stores the response verbatim under
   `raw/<source-id>/`, with a headers sidecar, one stable path per source,
   overwritten on change. Nothing is normalised at write time.
2. Git history is the database. `git log -p raw/openrouter-models/response.json`
   is the query.
3. At deploy time a pure derivation reads that history and emits typed events,
   entity threads, the leaks desk, the JSON API and the site. Generated output
   is never committed.

Rules the collector holds to, in `docs/superpowers/specs/`: bytes are stored
verbatim, history is never rewritten, backfill never shares a path with
go-forward capture, and a snapshot that would remove more than a configured
share of a source's units is held rather than written.

## Development

```bash
npm ci
npm test          # 2,324 tests
npm run typecheck
npm run build:site
```

`bin/llmcat.mjs` is generated from `bin/llmcat.ts` and committed, because
`npx github:...` installs the repository and runs the bin with no build step
available. Run `npm run build:bin` after changing the CLI; CI regenerates and
diffs it, and separately runs the documented `npx` command from a cleared cache,
because both of the ways that command has broken were invisible from inside the
repository.

## Licence and the collected bytes

Code is MIT. The contents of `raw/` and `backfill/` are **not** covered by it:
they are other people's files, stored verbatim, and each remains the property of
whoever published it. See [DATA.md](DATA.md) for what is collected, the personal
data it contains, and the unresolved conflict between an erasure request and an
archive that never rewrites history.
