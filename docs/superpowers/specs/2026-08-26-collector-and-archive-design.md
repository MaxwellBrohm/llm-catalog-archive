# Collector and Archive: design

Date: 2026-08-26
Revision: 3. Revision 2 applied an adversarial review (5 blockers, 21 majors, 28
factual corrections); revision 3 applies the review of that revision.
Status: pending review of this document
Sub-project: A1 of A-F (see "Where this sits")

## 1. What this is

A deterministic collector that fetches a fixed list of endpoints on a schedule
and commits their responses, verbatim, to a git repository. Git history is the
archive. `git log -p <path>` is the diff query.

Nothing it parses is ever written. It fetches, checks health, decides whether
anything changed, and writes bytes. It has no opinion about what a model is,
what a price change means, or what counts as news. Every piece of
interpretation lives in the deriver (A2), which reads only from git history and
can be re-run from scratch over the whole archive at any time.

That separation is the entire point. A parsing decision made today is
reversible tomorrow, which matters because one day of live probing on
2026-08-25 to 26 found five URL relocations, one repository transfer, one
default-branch change and one vanished JSON endpoint. The world rots faster
than a schema can be got right.

### Non-goals for A1

Not in this sub-project: entity extraction, thread modelling, story writing,
ranking, dedup, rendering, the API, the CLI, the leaks desk, the accuracy
ledger, any use of a language model at all.

### Where this sits

| # | Sub-project | Status |
|---|---|---|
| **A1** | **Collector and archive** | this document |
| A2 | Deriver: archive to events | placeholder |
| B | Docs differ | placeholder |
| C | Open API, feeds, CLI | placeholder |
| D | Read surface / publication | placeholder |
| E | Leaks desk and accuracy ledger | placeholder |
| F | 3D front door, domain, distribution | placeholder |

Product order was decided separately: the data surface ships first (open,
keyless, full history, every event links its raw artifact), the leaks desk
second once the accuracy ledger has real resolved entries behind it, and the
publication third as a reading layer over data that already has users.

Positioning is explicitly not novelty. `llmstatus.ai` already publishes a
model-lifecycle feed in three formats, and `pricepertoken.com/pricing-history`
already publishes price history. The claim is open, keyless, joined and
artifact-linked, never "nobody tracks this."

## 2. Rules that govern every write

Violating any of these silently breaks a guarantee made elsewhere.

**R1. Verbatim.** The collector writes response bytes exactly as received. No
normalizing, parsing, schema, field stripping, re-ordering or pretty-printing
at write time. An earlier draft proposed stripping volatile fields; that was
wrong. Stripping is lossy, and lossy at write time destroys the recoverability
that justifies the whole design.

*Bytes means the decoded entity body.* Transfer- and content-encoding are
transport, not content: the collector sends `Accept-Encoding: gzip`, decodes,
and stores the decoded body. `content-encoding` is recorded in `headers.json`
so the wire form stays reconstructable. Without this clause an implementer
following R1 literally stores gzip blobs, `git log -p` shows nothing readable,
delta compression stops working, and R2's artifact link points at a binary.

`.gitattributes` marks `raw/**` and `backfill/**` as `-text` so git never
applies EOL or text normalization to a stored artifact. It must **not** also
unset `diff`: `-diff` makes git print `Binary files ... differ` in place of a
real diff, which would destroy the `git log -p` query this design rests on.

**R2. Verbatim is what makes the artifact link honest.** Auto-published events
link the raw artifact they came from. An artifact reshaped by us is not
evidence, it is our derivative. R1 is a precondition for the publishing gate.

**R3. Normalization happens in the deriver, at diff time, never at write time.**

**R4. Parsing is allowed for the health check and the commit decision, and
forbidden for the commit content.** This is the narrow exception that keeps R1
workable. The claim in section 1 is not "it parses nothing" but "nothing it
parses is ever written," which is the load-bearing version.

**R5. One stable path per source, overwritten in place, committed only on
change.** Measured at 615 commits over 691 days in a 2.52 MiB pack. Timestamped
filenames grow the working tree without buying anything and break `git log -p`
on a single path. **Scope: R5 governs `raw/` and `backfill/`. Files under
`meta/` are collector state, not captured artifacts, and follow section 8.**

**R6. Backfill never shares a path with go-forward capture.** Section 10.

**R7. History is never rewritten.** No force-push, no rebase of pushed commits,
no `git rm` intended as deletion, for the life of the repository. Section 11's
permalinks are commit shas, and the audit-trail claim the whole design rests on
requires them to be permanent. Enforced by branch protection.

## 3. Repository layout

```
llm-catalog-archive/
  .gitattributes             raw/** and backfill/** are -text (never -diff)
  .github/workflows/
    collect-fast.yml         */15 * * * *
    collect-daily.yml        20 0 * * *
  raw/                       go-forward captures, verbatim
    <source-id>/response.<ext>
    <source-id>/headers.json
  backfill/                  third-party archives, NOT verbatim captures
    models-dev/
      PROVENANCE.md
      models-dev.bundle
    kj-9-openrouter/         GATED on O2, see section 10
      PROVENANCE.md
      models.json
  meta/
    sources.json             the source table, versioned
    status.json              per-source liveness
    corrections.jsonl        append-only, empty at launch
    retractions.jsonl        append-only, empty at launch
  docs/superpowers/specs/
```

### 3.1 `meta/sources.json`

The single file that drives the collector. Unknown keys are a hard error. A
schema test asserts every row in section 4's tables has exactly one entry here
and vice versa.

```json
{
  "version": 1,
  "user_agent": "ainews-collector/1.0 (+https://github.com/OWNER/REPO)",
  "contact": "OWNER@example.com",
  "sources": [
    {
      "id": "openrouter-models",
      "url": "https://openrouter.ai/api/v1/models",
      "tier": "fast",
      "path": "raw/openrouter-models/response.json",
      "content_type": "json",
      "expected_root": null,
      "invariants": {
        "min_bytes": 400000,
        "required_key_path": "data",
        "min_records": 300,
        "canary": null,
        "size_band": [0.5, 2.0]
      },
      "magnitude_guard": { "max_shrink_pct": 25 },
      "freshness": { "kind": "none", "max_quiet_days": null },
      "predicate": { "type": "bytes" },
      "timeout_s": 60,
      "retries": 2,
      "max_redirects": 3,
      "rate_limit": { "max_auto_events_per_day": 8 },
      "notes": ""
    }
  ]
}
```

`id` is the directory name under `raw/`. Every non-default `predicate`,
`invariants` value and `freshness` setting carries its justification in `notes`,
so the exception list is a reviewable artifact rather than scattered code.

## 4. Source inventory, tiers and health

Every entry was probed live on 2026-08-26 and, where load-bearing,
independently re-probed by agents instructed to refute the first result.

### Fast tier: every 15 minutes

| Source | URL | Notes |
|---|---|---|
| `openrouter-models` | `https://openrouter.ai/api/v1/models` | 417 models. `cache-control: public, max-age=300, stale-while-revalidate=3600, stale-if-error=3600`. Size drifts live (687,878 then 687,941 on re-probe), so no size equality is ever asserted. |

The 300s TTL sets the floor at 5 minutes. 15 is chosen above it to leave
headroom for edge `age` skew (section 9) and to keep Actions-minute usage at
roughly 96 runs a day rather than 288.

Nothing else is in the fast tier **today**. `modelsdev-commits` is the one
source with measured sub-daily change; O3 resolves it, provisionally via
`git fetch` rather than a tier move.

### Daily tier: 00:20 UTC

| Source | URL | Notes |
|---|---|---|
| `arena-leaderboard` | `https://arena.ai/leaderboard` | Section 7. Hourly during the O4 measurement window. |
| `anthropic-sitemap` | `https://www.anthropic.com/sitemap.xml` | 515 URLs, 515 with `lastmod`, 67,354 bytes. Root URL excluded by name: its `lastmod` ticked 12:51:24.149Z to 13:04:36.700Z in 13 minutes. |
| `anthropic-deprecations` | `https://platform.claude.com/docs/en/about-claude/model-deprecations.md` | 13,410 bytes against 1,006,482 for the HTML. The forecasting artifact. Non-numeric families exist (`claude-fable-5`, `claude-mythos-preview`), so no `claude-(opus\|sonnet\|haiku)-N` regex. 8+ further tables follow the master one. |
| `claude-llms-txt` | `https://platform.claude.com/llms.txt` | 63,970 bytes. |
| `openrouter-llms-txt` | `https://openrouter.ai/docs/llms.txt` | 66,545 bytes. |
| `openrouter-sitemap` | `https://openrouter.ai/sitemap.xml` | 616,687 bytes, 5,051 `<url>`. **Not static:** `cache-control: public, max-age=0, must-revalidate`, `cf-cache-status: DYNAMIC`. Rebuilt several times a day, rewriting ~100 `<lastmod>` values per rebuild independent of content change. Predicate keys on the `<loc>` set only. Needs retry: a `curl: (35)` reset was observed. |
| `openai-llms-txt` | `https://developers.openai.com/api/docs/llms.txt` | 34,432 bytes. `platform.openai.com/llms.txt` 404s. `platform.openai.com/docs/llms.txt` is a **301 to this same URL**; its 81-byte body is the redirect text, so a collector that does not follow redirects archives that instead of the file. |
| `together-llms-txt` | `https://docs.together.ai/llms.txt` | 61,720 bytes. |
| `perplexity-llms-txt` | `https://docs.perplexity.ai/llms.txt` | 43,329 bytes. |
| `mistral-llms-txt` | `https://docs.mistral.ai/llms.txt` | 14,658 bytes. |
| `groq-llms-full-txt` | `https://console.groq.com/llms-full.txt` | 797,252 bytes. Groq has zero `.md` twins, so this is the only path to Groq content diffs. |
| `xai-llms-txt` | `https://docs.x.ai/llms.txt` | 1,465,407 bytes. Row-permuting, see section 7. No `llms-full` exists. |
| `modelsdev-commits` | `https://github.com/anomalyco/models.dev/commits.atom` | 20 entries, 20,239 bytes, no API rate limit. Observed 20-entry window spanning **24m29s**, so a daily poll loses commits and even a fast tier could. See O3. |
| `claude-status` | `https://status.claude.com/history.atom` | 25 entries, all with `<published>`, newest 2026-08-24T20:26:21Z. Key on `published`: 16 of 25 share a bulk backfill `updated` of 2026-08-14. |
| `openai-status` | `https://status.openai.com/history.atom` | 90 entries, **zero `<published>` elements**, `<updated>` only. Its date handling differs from `claude-status` and must not share code paths blindly. |

### Baselines

Hashes are volatile facts, not spec invariants, so they live in a dated file
(`ai-news-llmstxt-baseline-2026-08-26.tsv`) rather than in this table, recording
both raw and sorted md5 per source. O1 re-checks against that file.

### Explicitly excluded

| Endpoint | Why |
|---|---|
| `platform.claude.com/llms-full.txt` | 39,763,086 bytes per day. |
| `platform.claude.com/sitemap.xml` | 2,901 URLs, zero `lastmod`. |
| `ai.google.dev/*` | Bare curl: 404 at 83,928 bytes. Browser UA: OAuth redirect loop. Sitemap index 200s with a fresh lastmod while all three child sitemaps return HTTP 500 with a zero-byte body. See O5. |
| `qwenlm.github.io/blog/index.xml` | 200, valid XML, 44 items, newest post 2025-09-23. 337 days stale while Qwen shipped three flagship models. |
| `cohere.com/blog/rss.xml` | 1 MB of XHTML a Python XML parser **accepts** with `root=html`. Proves "parses as XML" is insufficient alone. |
| `alignment.anthropic.com/feed.xml`, `red.anthropic.com/rss.xml` | 200 + text/html catch-alls; `/zzz-not-a-real-path-9999` returns a byte-identical body. |
| `buttondown.com/ainews/rss` | 2.6 MB of valid RSS, newest item 2025-04-25. |
| `theneurondaily.com/feed` | Bare curl 403 at 6,673 bytes; browser UA 200 at 348,669 with a soft-404 redirect. Excluded on both readings. |
| `pytorch/pytorch/releases.atom` | 21,228 bytes: 6 `viable/strict/<runid>` CI tags, 3 `trunk/<sha>`, 1 `v2.14.0-rc8`. GitHub's `releases.atom` is a tags feed. |
| Reddit, anything | Section 12. |

### Health check

A response is healthy only if **all** hold:

1. Final status is 2xx.
2. It parses as its declared `content_type`, **and** the root element or
   required key path matches `expected_root` / `invariants.required_key_path`.
   The cohere case is why the parse alone is not enough.

   For the nine text-typed sources (the eight `llms.txt` family files plus
   the Anthropic deprecations `.md`), where "parses as its declared type" is
   vacuous, three cheap checks stand in for it, all declared per source:
   - **`canary`**: a known stable substring that must be present, chosen from
     content that has been in that file for months (a top-level heading, a
     section title). Absent canary means unhealthy, full stop.
   - **`interstitial_denylist`**: a module constant in the health check, not a
     per-source field, because it is the same list for every source and a
     per-source copy is a per-source chance to omit one. The body must not
     contain
     `__CF$cv$params`, `cf-mitigated`, `Just a moment`, `Enable JavaScript and
     cookies to continue`, or `Attention Required!`. A challenge page that
     happens to contain the canary is still caught here.
   - **`size_band`**: byte count within a declared ratio of the last accepted
     snapshot (default 0.5x to 2.0x). An 81-byte redirect body and a 350 KB
     SPA shell are both outside any sane band around a 64 KB text file.
3. Declared invariants hold: `min_bytes`, `min_records`, `canary`,
   `size_band`, and the shared interstitial denylist. An 81-byte redirect body is caught by
   size and never by parsing. Content collapse is **not** checked here: that is
   the magnitude guard's job (section 6.1), deliberately separate because health
   catches known-bad shapes and the guard catches unknown ones.
4. Redirects resolved within `max_redirects`. If the final effective URL differs
   from the declared URL, the source is marked **`relocated`**, reported, and
   not silently healthy. This is how the five relocations in section 1 get
   caught next time.
5. Freshness, per `freshness.kind`. For feeds, `max_quiet_days` is per-source,
   set high for incident feeds and low for activity feeds. **A stale feed is
   `stale`, not `failed`, and does not drive the exit code**, because a provider
   with a genuinely good quarter publishes no incidents for 60+ days and a daily
   failure email for that condition is how alerting channels get muted. For
   non-feed sources, `status.json` carries `days_since_last_content_change` and
   a per-source expected maximum, so a frozen `llms.txt` left serving after a
   docs migration warns instead of passing forever.

## 5. Schedule

`collect-fast.yml` runs `*/15 * * * *`. `collect-daily.yml` runs `20 0 * * *`,
an off-peak slot away from the top of the hour where scheduler contention is
worst.

It has **no relationship to kj-9**. Across all 615 kj-9 commits, zero landed
before 00:20 UTC: delay after its nominal `12 0 * * *` runs 81 to 494 minutes,
median 126, and the hour histogram is 01h:160, 02h:293, 03h:98, 04h:51, 05h:10,
08h:3. No daily slot can guarantee ordering against it. If kj-9 is ever a live
corroborator, ordering is resolved by fact rather than clock: read its HEAD
committer timestamp and defer if it is older than the artifact being
corroborated.

GitHub's scheduled workflows are best-effort. Nothing here may assume a run
happened at its nominal time; every timestamp comes from the response or the
commit. The cron nominal time is never written anywhere.

Both workflows declare the **same** concurrency group, which is the only thing
that serialises them against each other:

```yaml
concurrency: { group: collector-archive, cancel-in-progress: false }
```

## 6. The run

The order is fixed and cannot be implemented in any other sequence:

**fetch → health check → change predicate → write → commit → push → evaluate
counters → exit code.**

**A response that fails the health check is never written and never commits.**
It increments the source's consecutive-failure counter and updates
`status.json` only. Last-good bytes are never clobbered by an error page. This
matters most for the nine text-typed sources, where "parses as its declared type"
is vacuous: a 200 carrying a Cloudflare interstitial would otherwise be
committed, and `git log -p raw/claude-llms-txt/response.txt` would show the
entire 616-entry Anthropic doc index deleted in one commit, from which A2 would
emit 616 page-removal events with honest artifact links to a challenge page.

**The status commit is never downstream of the failure evaluation.** The
natural implementation evaluates first or aborts on an exception, which means
the unconditional daily commit fails to happen precisely when sources are
failing, re-arming the 60-day disable that section 8 exists to prevent.

**Identification.** Every request sends
`User-Agent: ainews-collector/1.0 (+https://github.com/OWNER/REPO)` and a
contact address, declared once in `sources.json` and identical for every
source. **Spoofing a browser or feed-reader UA is forbidden** by the same rule
that forbids circumventing bot detection: if a source only serves a fake UA, it
is not a source. The UA is recorded alongside the response headers. This is not
hypothetical tidiness: `ai.google.dev` and `theneurondaily.com` both return
materially different responses to a browser UA, and browser-UA spoofing appears
throughout the probe transcripts an implementer will read.

**Concurrency and politeness.** Sources are fetched with a concurrency limit of
4, at most one in-flight request per hostname, minimum 1s between consecutive
requests to the same host, in `sources.json` order. The daily tier has three
`openrouter.ai` URLs and two `platform.claude.com` URLs, and 15 sources at 60s
timeouts is the difference between roughly 15 minutes serial and about 1 minute
parallel, which decides whether the 00:20 run is still in flight at 00:30.

**Redirects** are followed to `max_redirects` (default 3). The final effective
URL is recorded in `headers.json`.

**Retries.** Default `timeout_s` 60, `retries` 2, backoff 2s then 8s. Retry only
on transport error (curl 28/35/52/56), HTTP 5xx, and 429. Never retry a 4xx
other than 429, and never retry a 2xx. **When the response carries
`content-length`, a body shorter than it is a failure, not a success**, and the
stored file is not overwritten: a 25s timeout against a HuggingFace endpoint
during probing truncated mid-body at 23,404 of 57,859 bytes and produced
unparseable JSON rather than an error status. One source's exhausted retry
chain counts as exactly one increment of its counter.

### 6.1 The magnitude guard

Independent of the health check, and deliberately not part of it. Health
gating catches **known** unhealthy shapes: the traps in section 4's fixture
list, the canary, the denylist. It cannot catch an unknown one, and the next
failure will not be a Cloudflare page.

**Rule: if an accepted snapshot would remove more than `max_shrink_pct` of
entries (for structured sources) or lines (for text sources) versus the last
accepted snapshot for that source, it is held for review instead of
committed.** Default 25%. The run records the hold in `status.json`, exits
zero (this is not a source failure), and reports it. A human accepts or
rejects; acceptance commits the held bytes unchanged.

This is a *write-time* gate, so it sits between the change predicate and the
write, and it is the general case of which the 616-page-deletion scenario is
one instance. It also catches the case health can never see: a source that
legitimately parses, carries its canary, sits inside its size band, and has
simply lost most of its content.

Growth is not guarded. A source doubling is a story; a source vanishing is
usually a bug, and the asymmetry is deliberate.

**Commits.** One commit per changed source per run, touching exactly that
source's `response.*` and its `headers.json`. Message:
`<source-id>: changed (<bytes> bytes, HTTP <status>)`. The daily status commit
is separate: `status: daily heartbeat <YYYY-MM-DD>`. Push is
`git pull --rebase origin <branch>` then push, up to 3 attempts, **never
`--force`** (R7).

## 7. Change predicates

R1 governs what is written. It does not govern whether to write. The commit
decision may look inside the response; the bytes written are still untouched.

Three predicate types:

- **`bytes`** (default): commit when the decoded body differs.
- **`mask`**: commit when the body differs after masking a declared list of
  regions. The list and its justification live in `sources.json`.
- **`extracted`**: commit when a declared extraction differs. For sources whose
  volatility is structural rather than a maskable substring.

### `arena-leaderboard`: `extracted`

An earlier revision specified a mask on the `userId` UUID alone. **Two
reviewers measured independently, hours apart, and both found three volatile
regions:**

1. `"userId":"<UUIDv7>"` beside `"userState":"provisional"`, whose embedded ms
   timestamp decodes to the fetch instant.
2. `posthogFlags`, 37 to 41 A/B assignments, of which 2 differed in both
   sessions. Any can re-roll on any request because the visitor is anonymous.
3. `window.__CF$cv$params={r:'<cf-ray>',t:'<base64 unix epoch>'}`, where `r`
   equals the response's own `cf-ray` and `t` decodes to the request's own
   clock. **This changes on every response by construction.**

Masking only the first leaves the responses unequal, so the predicate fires
every run and arena commits 5 MB forever, which is the exact outcome this
mechanism exists to prevent. After masking all three the responses are
byte-identical.

A mask list keyed on flag names also rots as arena ships experiments, so the
predicate is `extracted` over the record tuples
`(publicName, displayName, rating, votes)`. **CI asserts two back-to-back
fetches compare equal under the predicate**, so the next injected token fails
loudly instead of silently reverting arena to a daily 5 MB commit.

The underlying data stability is confirmed across both sessions: 1,008 records,
839 distinct `publicName`, 844 distinct `displayName`, 811 `rating` and 811
`votes` values, all identical between fetches. The response *size* is
per-request volatile (5,235,684 to 5,235,774 observed), so no fixed size is
asserted anywhere.

### `xai-llms-txt`: `extracted` over sorted table blocks

`bytes` is wrong here: the file's rows re-permute per request, so it would
commit 1.46 MB of pure permutation daily forever. `mask` cannot express it,
because reordering is not a maskable substring. R3 pushes the sort into the
deriver, but the deriver only ever sees what was committed and the commit
decision is upstream of it, so the predicate must be able to express
sort-equality itself.

The sorted md5 `b92fafe614002915ea5a5b5e5be3060b` was reproduced across three
independent captures hours apart while every raw md5 differed. Reviewers
disagree on magnitude: one measures ~12 changed lines and 270 differing bytes
across 6 runs (adjacent row swaps in two tables), the other describes a
shuffle. **The narrower measurement is adopted**, because it is the only one
with a byte count attached and it argues for sorting *within table blocks*
rather than the whole file, which preserves the deriver's ability to see a
legitimate section reorder.

### `openrouter-sitemap`: `extracted` over the `<loc>` set

Its ~100 per-rebuild `<lastmod>` rewrites are build noise, not content change.
Same treatment already given to `platform.claude.com/sitemap.xml`.

### Arena codename filter, corrected

An earlier revision said genuine reveals are "roughly 10 to 18" of the
differing rows and a raw count "overstates by three to six times." **That was
wrong and wrong in the dangerous direction.** Hand classification of all rows
gives **39 genuine reveals of 61** (36 of 55 distinct pairs), cross-checked
mechanically at 41 to 20. The raw count overstates by about **1.6x**. A deriver
built to the old figure would suppress roughly 30 real reveals per cycle.

**The filter enumerates the label-variant shape, not the reveal shape.** A row
is a label variant iff `publicName` and `displayName` share an alphanumeric
token: suffix additions (`-high`, `-low`, `-medium`, `-xhigh`,
`-no-system-prompt`), a trailing `-YYYYMMDD`, or a ` (max)` / ` (preview)`
parenthetical. Everything else is a reveal. The complete observed variant set is
small and enumerable and belongs in a fixture.

The positive filter proposed earlier (nonsense word, animal name,
`<month><year>-chatbotN`) misses `anonymous-0410`, `k2`, `cold_brew`,
`onyx-v1-4`, `lo-bah-png`, `nonnas-meatballs-open-weight` and `may-alpha`, all
of which are real reveals.

Wrap the extraction in a sanity assert (`>= 500 records?`): it is an
undocumented framework payload and will change shape without notice.

## 8. Liveness, status and alerting

GitHub disables scheduled workflows after 60 days of repository inactivity.
This interacts badly with commit-only-on-change: a broken collector stops
committing, which is the inactivity that triggers the disable, which makes the
break permanent. Absence of commits currently means both "nothing changed" and
"I am dead," and those must be separable.

`meta/status.json` carries, per source: last attempt, last success, last
change, `days_since_last_content_change`, consecutive failure count, health
state, most recent HTTP status, byte count, derived origin timestamp, and the
auto-event counter (section 11).

**Commit cadence.** Commit `meta/status.json` whenever its **meaningful fields**
differ from the committed copy, plus an unconditional daily commit for
liveness.

Meaningful fields are per-source last-success, HTTP status, byte count,
consecutive-failure count, health state and hold state. The comparison
**ignores any pure heartbeat timestamp**, because a last-attempt clock that
ticks every run would make every field-comparison trivially true and turn this
back into a commit-every-run rule.

The behaviour that falls out is the point: during an outage the counter
increments, so the meaningful content differs, so it commits every run and the
counter advances correctly. In steady health nothing meaningful moves and it
commits once a day.

Revision 1 committed only on daily plus failure transitions, which made the
counter unable to advance. Trace: the 00:15 fast run fails, transition
committed with count 1; 00:30 fails, reads 1, computes 2, this is neither a
transition nor the daily job, so nothing commits and the 2 dies with the
ephemeral runner; 00:45 reads 1 again. The counter pins at 1 for the whole
outage and N=8 is reached after 8 days rather than two hours. Committing on
counter change fixes it, and at 15-minute cadence the counters only move during
an outage, so it costs commits only when something is already wrong.

**Transitions have hysteresis.** A source becomes FAILING at consecutive-failure
count 2 and OK on the first success. Commits fire on the OK→FAILING and
FAILING→OK edges only, so a flaky source (and section 4 already expects a
`curl: (35)` on the OpenRouter sitemap) does not generate in/out commit pairs
indefinitely.

**Each job evaluates its own thresholds and exits non-zero itself:**
`collect-fast.yml` at N=8 for a fast-tier source (about two hours),
`collect-daily.yml` at N=3 for a daily source. The earlier revision put the
check only in the daily job, so a totally dead fast tier produced no email for
up to 24 hours.

**In-band alerting covers source failure. It cannot cover collector death.**
An alarm wired to the exit code of a run fires only when the run happens, and
every way the collector stops running produces silence: workflow disabled for
another reason, cron not firing, the job failing before the check, the repo
archived, Actions minutes exhausted, a YAML error, or action-runtime rot. So:

**Out-of-band dead-man's switch.** Every successful daily run pings a free
healthchecks.io-style check with a 26-hour grace period, so the *absence* of a
ping alerts. Alternative if a third party is unwanted: a second workflow in a
different repository that fails when `meta/status.json`, fetched from the raw
contents URL, has a `last_attempt` older than 26 hours. The in-repo exit code
covers source failure and the external check covers collector death; neither
covers the other.

**To probe before relying on the liveness argument:** that a commit pushed by
the Actions bot with the default `GITHUB_TOKEN` counts as repository activity
for the 60-day timer. The whole heartbeat argument rests on it and it is
unverified. Cheap insurance either way: have the daily job also call the Actions
API to re-enable the workflow.

## 9. Headers and timestamps

Every fetch records into `raw/<id>/headers.json`: `etag`, `last-modified`,
`date`, `age`, `cache-control`, `cf-cache-status`, `content-encoding`,
`content-length`, the final effective URL, and the UA sent.

**`headers.json` is a sidecar, written in the same commit as the body it
describes, and only when that body is accepted. Never on an independent
schedule.** If the body does not change, the headers do not update, so the
committed headers always describe the committed bytes. The earlier revision put
headers on the status schedule, which for the fast tier discarded ~95 of 96
daily header states and guaranteed the committed headers described a different
fetch than the body beside them: the etag might not be the etag of the
committed body, breaking conditional requests, and a permalink would carry
corroborating evidence that corroborates nothing. That is worse than having no
headers, because it looks like evidence.

Liveness is `status.json`'s job, not the sidecar's. A source that never changes
shows liveness through the daily status commit, and its sidecar correctly stays
frozen alongside its frozen body.

`headers.json` is the authority on the artifact's own fetch. `status.json`'s
copy is last-attempt liveness telemetry and includes failed attempts. Where they
disagree, `headers.json` wins for anything about a stored artifact.

**Two timestamps, both named.** `observed_at` is the runner's wall clock at
request completion, legitimate because it is measured rather than scheduled.
`origin_date` is response `date` minus `age`, recorded only when both are
present.

**Cache-generation skew.** A `cf-cache-status: HIT` is served from whichever
Cloudflare POP the runner reaches, and Actions runners are spread across regions
with no stable POP. Two adjacent polls can land on edges holding different cache
generations, so the archive records A, B, A, B for a value that changed once.
The `bytes` predicate cannot tell that from a real change, and the deriver would
emit a change event and a reversion event, both with honest artifact links.
OpenRouter's full header is `public, max-age=300, stale-while-revalidate=3600,
stale-if-error=3600`, so an edge may serve up to ~65 minutes past freshness,
which no polling rate fixes.

**Rule: reject and do not commit any response whose `origin_date` is older than
the one behind the currently stored bytes.** Count it as a skip, not a failure.
Any published timestamp derives from `origin_date`, never from commit time, and
`stale-while-revalidate` means capture time is an upper bound on change time.

This rule does not apply retroactively to backfill findings. kj-9 polls once a
day against a 300s TTL, and the `deepseek/deepseek-chat` sequence across four
months is not an edge-skew artifact.

## 10. Backfill

Backfill imports third-party git archives so the product launches with history
rather than accumulating it.

### Why separate trees, restated

**Neither backfill source is a verbatim artifact.** kj-9 stores
`curl … | jq '.data | sort_by(.id)'` output, which strips the response envelope
and re-sorts by id, while the live API returns `created` descending.
models.dev stores per-model TOML. Written into `raw/`, the deriver would hit a
silent format and ordering change at the cutover date, and an event derived from
that window would link "the raw artifact" and serve someone else's normalized
derivative, breaking R2.

Every derived event carries `provenance`: `observed-directly` or
`observed-via-third-party-archive`.

### `models-dev`: a bundle, not snapshots

`backfill/models-dev/models-dev.bundle` is a `git bundle` of the upstream
history: one file, ~18 MiB, committed once, never changing. The deriver clones
from it.

Materialised dated snapshots were considered and rejected. 8,416 commits over
~448 days is roughly 19 a day, so a `YYYY-MM-DD` filename collides outright, and
dated copies of the 4.1 MB `api.json` would be on the order of 1.8 GB of working
tree against a 53 MB upstream checkout. The bundle is the complete upstream
history, verbatim, in one artifact, and it satisfies R1 and R6 exactly.

| Property | Value (2026-08-26T14:28Z) |
|---|---|
| Commits | 8,416, and moving: 8,372 at 00:00Z, 8,392 at 06:00Z, 8,402 at 12:00Z |
| Range | 2025-06-04 to present |
| Size | 18.35 MiB packed, 53 MB checked out (7,347 model TOMLs) |
| Default branch | **`dev`, not `main`** |
| Licence | **MIT** |
| Coverage | 203 providers / 7,314 models live; the repo carries entries `api.json` does not emit |

The brief named this repo `sst/models.dev`. It was transferred; the old path
returns a 301 with a 212-byte stub in which every field a caller wants is null,
and `raw.githubusercontent.com/anomalyco/models.dev/main/...` 404s because the
default branch is `dev`.

### `kj-9-openrouter`: one stable path, and gated

Imported by **replaying the 615 upstream commits onto
`backfill/kj-9-openrouter/models.json`**, preserving upstream author and commit
dates. This applies R5 to backfill rather than exempting it: `git log -p` keeps
working, per-day granularity survives, the checkout stays under 1 MB, and the
native commit timestamps the precision claim derives from are preserved. The
earlier revision's `snapshots/YYYY-MM-DD.json` would have been ~245 MB of
working tree and would have silently collided on the days carrying two commits.

| Property | Value |
|---|---|
| Commits | 615 |
| Range | 2024-10-05 to 2026-08-26 |
| Span | 691 days, 613 distinct days committed, 88.7% |
| Largest gap | **6d 00:01:20** between consecutive commits (2025-01-02 01:50:48Z to 2025-01-08 01:52:08Z), i.e. 5 calendar days with none |
| Unparseable | 2 of 615 |
| Size | 2.52 MiB packed, 3.6 MB checked out |
| Licence | **None. No LICENSE file, no licence metadata.** |

Unparseable snapshots are imported verbatim like every other snapshot: they are
history, not a health check. Their paths are listed under `## Known-bad
snapshots` in `PROVENANCE.md` with the parse error. The deriver skips them and
logs the skip; the importer never drops a file.

**This tree is not committed until O2 resolves.** In a design whose central
claim is a permanent public audit trail, `git rm` does not remove content: 615
commits of an unlicensed third party's data would remain in every clone forever
unless history is rewritten, which R7 forbids and which would invalidate every
permalink. The earlier revision's "delete the tree and re-run the deriver"
fallback does not exist. The clone is 2.52 MiB and re-cloneable, so keeping it
local until the licence question is answered costs nothing. On refusal or no
answer, drop it and accept models.dev's 2025-06-04 start as the floor.

### What the replay yields

970 distinct model ids ever seen against 417 live, and 272 context changes,
both reproduced exactly on an independent replay. Price changes are
**definition-dependent and the definition must be stated inline**: 325 when
comparing `pricing.prompt` and `pricing.completion`, but **704** when diffing
the whole `pricing` object, because OpenRouter progressively added sub-keys
(`input_cache_read`, `input_cache_write`, `web_search`, `internal_reasoning`,
`image`, `audio`, `request`).

### 10.1 Worked examples, and the claim form they are allowed to take

**This subsection exists because the examples were being told wrong, and they
are the first thing the project would have shipped at scale.**

Earlier drafts described `deepseek/deepseek-chat`'s context sequence (128000,
65536, 64000, 16000, 131072, 16000) as "a model's usable context cut to an
eighth and restored." That is inference, not observation, and it is probably
wrong.

OpenRouter's `context_length` is the maximum across the providers currently
routing a model, not a property the lab controls. The catalog says so directly:
**38 of 417 models today carry a `top_provider.context_length` that disagrees
with the model's `context_length`**, including `deepseek/deepseek-v4-flash-0731`
at 1,310,720 against a top-provider 1,048,576. A provider joining or leaving the
routing pool moves the catalog number with nothing changing at the lab. So the
sequence above is at least as likely to be routing churn as a decision by
DeepSeek, and we have no evidence which.

**The rule, which binds every worked example in this document and every
templated event the collector's data produces:**

| Form | Status |
|---|---|
| "OpenRouter's catalog `context_length` for X changed from A to B on D" | Observation. Auto-publishes. |
| "X's usable context was cut to an eighth" | Inference. Held for review, and needs corroboration from the lab's own docs before anyone writes it. |

The mechanical form names the catalog as the subject and the field as the
object. It is safe precisely because it claims nothing about why. Every event
records both `context_length` and `top_provider.context_length`, so a reader can
see the routing explanation without us asserting one.

The same discipline applies to prices: "OpenRouter's listed prompt price for X
changed from A to B" is an observation; "X got 30% cheaper" is a claim about the
lab's pricing that a routing change can falsify.

Restated safely, the findings are:

- `z-ai/glm-5.2` has **51 distinct listed-price states** in OpenRouter's catalog
  since 2026-06-17.
- OpenRouter's catalog `context_length` for `deepseek/deepseek-chat` took the
  values 128000, 65536, 64000, 16000, 131072 and 16000 across four months. Cause
  unestablished.
- OpenRouter's catalog `context_length` for `google/gemini-2.0-flash-001`
  recorded **18 transitions between 2026-04-17 and 2026-05-30** across 20 states,
  7 of them in April. A six-week condition, not a one-month blip. Cause
  unestablished.

None of these is less interesting in the honest form. "A number in the catalog
teams depend on moved 18 times in six weeks and nobody said why" is the story,
and it is one we can stand behind.

### Precision, and the schema consequence

kj-9's cron is `12 0 * * *` but **0 of 615 commits landed before 00:20 UTC**;
the median commit lands about 2h18m after nominal. So a model appearing at 20:04
UTC is first recorded a median of roughly 2h18m after 00:12 the following day,
and the worst-case error is **6 days**, not 5.

The field is `first_seen_in_catalog_at`, literally, with siblings:

| Field | Type | Meaning |
|---|---|---|
| `provenance` | enum | `observed-directly` / `observed-via-third-party-archive` |
| `precision_seconds` | integer | worst-case error, machine-comparable |
| `precision_note` | string | human explanation |

`precision_seconds` values: kj-9 backfill **518400** (6 days); models.dev
backfill its own measured bound; fast tier 900 plus a cron-delay allowance;
daily tier 86400 plus the same. **Any renderer may show a date only when
`precision_seconds` is at or below the resolution it renders at.** That is what
makes the field load-bearing rather than decorative, and it is why the caveat
must be an integer rather than an adjective in prose.

Not `launched_at`, not `released_at`, not bare `first_seen`. A field named
`launched_at` will eventually be rendered as a launch date by something
downstream.

## 11. The publishing gate, as it constrains A1

The gate itself is D. Two of its rules constrain the archive now.

**The auto-publish line is who composed the sentence, not whether the fact is
machine-checkable.** Templated output assembled from structured fields
auto-publishes. Anything a language model wrote goes to review, however
factual. This survives the case that breaks machine-checkability: a model
writing a true sentence is still a model writing a sentence, which is what Nota
News and Prism News died of.

**Permalinks.** An artifact permalink is `<repo-url>/blob/<commit-sha>/<path>`,
where the sha is the commit that changed that artifact. Every event records that
sha. R5's overwrite-in-place does not break this: the sha pins the content. R7
is what makes it permanent, **and the repository is public** (O6). That was
already settled by the gate decision rather than by the permalink constraint: an
auto-published event links its raw artifact, and a private archive makes that
link unresolvable, which collapses the auto tier back into "trust me." The
permalink shape only makes the same conclusion unavoidable.

**Correction log and retraction path exist from the start.** `meta/corrections.jsonl`
and `meta/retractions.jsonl` are created empty in A1, with a CI check that their
diffs contain no deletions or modifications to existing lines. The
**append-only property** is an A1 decision because in a git-is-the-archive
design it is either an auditable JSONL from commit one or it is nothing. The
**record schema** belongs to D. Retraction semantics are fixed now: a retracted
event stays in the archive and stays resolvable at its permalink, marked
retracted, never deleted, because deletion breaks the audit-trail claim the
whole design rests on.

**Auto-tier rate limit.** Per source: at most `max_auto_events_per_day` events
(single digits for OpenRouter, whose observed baseline is ~1.2 new ids a day),
plus a proportional rule for large text sources: hold when one diff changes more
than X% of lines or more than Y lines. **Over-cap batches are held for review as
one grouped item, never dropped and never published individually.** The counter
lives in `meta/status.json` beside the failure counter.

The proportional rule is not optional decoration. The shared-`lastmod` rule
below is a *sitemap* rule and needs a `lastmod` field, so it cannot see the case
the constraint actually named: a provider reformatting its docs. Groq's
`llms-full.txt` is the only path to Groq content diffs and has zero `.md` twins,
so one Groq docs-platform migration is a whole-file rewrite with nothing to
threshold on.

**Shared-`lastmod` anomaly rule, bounded.** A `lastmod` value shared by **3 or
more** URLs at the same millisecond is one build artifact, and emits at most one
held-for-review item for the group. Groups of 2 pass through as individual
candidates, and an isolated single-page `lastmod` must still produce an event.
N=1 would suppress every ordinary edit. The Anthropic sitemap supplies both
positive fixtures (a five-page group, a six-post group) and the negative.

## 12. Legal constraints that bind the collector

Not legal advice. These are what the documents say, and where they were not
readable this says so.

**Store freely:** Epoch AI (CC-BY 4.0, confirmed in the README shipped in every
archive), `lmarena-ai/leaderboard-dataset` (`cc-by-4.0` in the HF `cardData`),
models.dev (MIT).

**Do not ingest at all: Reddit.** Developer Terms 4.1 and Data API Terms 3.1
require a separate agreement for commercial use; Data API Terms 2.4 forbids
using content to train a model; deletions must propagate "as soon as possible"
and "immediately"; on termination you must delete derived data and models.
Reddit may be read and linked by a human. It is not a collector source.

**Correction to the brief:** the widely-repeated "48-hour deletion window" does
**not appear in any readable Reddit document**. The only occurrence of "48" in
the Developer Terms is `48 C.F.R. 12.212`. Nor does "even if disassociated,
de-identified or anonymized" appear anywhere. The real standards are looser in
form and stricter in effect, because there is no fixed-hour safe harbour to
design a nightly batch against. Neither phrase may appear in anything this
project publishes. The cited support page is Cloudflare-403 to both curl and
WebFetch, so this is unverified-and-probably-wrong rather than definitively
refuted.

**Avoid entirely:** third-party scraper and SERP-proxy vendors. *Reddit, Inc. v.
SerpApi LLC*, 1:25-cv-08736 (S.D.N.Y.) is a five-party case, and the 7/31/2026
opinion predominantly denied the motions to dismiss, sustaining DMCA
1201(a)(1)(A) against **both** SerpApi and Perplexity, the buyer. Live and
unresolved: no final judgment, no appellate ruling.

**Also avoid:** anything circumventing an access control, rate limit or bot
detection, on the same theory. This is why section 6 forbids UA spoofing.

**Unverified, and must be checked before relying on them:** terms for
OpenRouter's API, the HuggingFace API, HN Algolia, CourtListener, the Federal
Register, arena.ai's payload, and every publisher feed. None was probed.
Absence of a probe is not absence of a restriction.

**Politeness limits observed:** GitHub core API 60/hour unauthenticated; GitHub
*search* a separate bucket at 10/minute unauthenticated, 30 with a token.
Reddit's `.rss` returned a bodyless 429 on a single first request with
`x-ratelimit-remaining: 0.0`.

## 13. Testing

**Pure, tested directly:** the health predicate in all five conditions; each
change predicate; the status-transition logic including hysteresis; the
consecutive-failure counter; the arena label-variant filter; the shared-`lastmod`
grouping at N=2 and N=3; the auto-event rate limiter.

**Fixture-driven, from bytes captured 2026-08-26:** each trap gets a fixture and
a test asserting it is classified unhealthy. The cohere XHTML a parser accepts.
The 337-day-stale Qwen feed. The byte-identical Anthropic catch-all. The pytorch
tags-as-releases feed. The 81-byte OpenAI redirect body. A Cloudflare
interstitial against a `text`-declared source, asserting **no write occurs**. A
catalog collapsed from 417 records to 3, asserting the **magnitude guard** holds
it for review rather than committing, and that the run still exits zero because
a hold is not a source failure. A challenge page carrying a source's canary
string, asserting the interstitial denylist catches it anyway. A body outside
`size_band` in both directions.
Two responses whose `age` headers imply reversed origin order, asserting the
older is discarded.

**R1 round-trip, because R1 is load-bearing and untested is untrue:** fetched
bytes equal bytes read back after commit, for a fixture containing CRLF, a
missing trailing newline, and invalid UTF-8. This is what `.gitattributes`
protects and what would otherwise fail silently while looking correct.

**Counter tests go through commit and checkout round-trips**, not in-memory: 8
synthetic consecutive failures must produce a non-zero exit on the 8th. Plus
daily-job driver tests for zero sources changed, one failing, and all failing,
each asserting the status commit is produced.

**Importer tests:** same-day duplicate upstream commits, the unparseable-snapshot
path, and bundle round-trip.

**CI invariants:** every commit touching `raw/<s>/response.*` also touches
`raw/<s>/headers.json`; `corrections.jsonl` and `retractions.jsonl` diffs
contain no deletions; every section 4 row has exactly one `sources.json` entry
and vice versa; two back-to-back arena fetches compare equal under its
predicate.

**Mutation testing, per the standing rule:** every assertion here must be
watched failing before it is trusted. The absence-style assertions ("this trap
is detected as unhealthy", "no write occurs") are the vacuous ones: the fixture
must be verified to actually contain the trap, and the check verified to pass on
a healthy fixture, or the test proves nothing.

**Not tested by mocking the network.** The source table's correctness is a
property of the world, checked by the daily health run rather than by a unit
test that passes forever against a stale mock.

## 14. Open questions

**O1. Re-hash against the dated baseline.** The stability window measured was
~6 minutes, which rules out per-request nonces but not a nightly rebuild
stamping unchanged files. Re-check every hashed endpoint, not only the llms.txt
family, against `ai-news-llmstxt-baseline-2026-08-26.tsv`. The OpenRouter
sitemap is the endpoint the concern actually bit.

**O2. kj-9 licence. Blocks committing that backfill tree at all** (section 10),
not merely its use. An issue is drafted for approval before posting: short and
factual, saying what the repo is being used for and asking for a licence
declaration, with no pressure and no deadline. Fallback on refusal or silence is
documented: drop the tree, accept models.dev's 2025-06-04 start.

**O3. `modelsdev-commits` window.** A 20-entry feed observed spanning **24m29s**
means even a 15-minute tier can lose commits, which rules out the fast-tier
option. Recommend treating models.dev's own git history as the durable record
via `git fetch` against the bundle's remote, using the feed only as a cheap
change trigger.

**O4. Arena cadence.** A daily poll cannot distinguish daily from sub-daily,
which is the one direction that matters. **Poll hourly for the two-week
measurement window**; the predicate keeps unchanged runs from committing, so the
cost is fetches, not commits. Afterwards, move to a daily poll scheduled just
after the observed batch hour rather than 00:20, since 00:20 lands ~2.7 hours
*before* the suspected 03:00 batch and would systematically capture the previous
day's data.

**O5. Gemini docs.** `ai.google.dev` has no working diff surface. Decide whether
coverage is load-bearing and, if so, find a mechanism.

**O6. RESOLVED. Public, named for the artifact rather than the product:
`llm-catalog-archive`.** The name must not be a brand, because it lives inside
every permalink forever under R7, and the eventual site name should be free to
differ without a rename propagating into published event links.

**O7. Size budget.** Set a per-source annual pack ceiling and a repo ceiling, so
O4's resolution is bounded by something. Reviewers disagreed on arena's cost
(~1.9 GB/year uncompressed sum versus 20 to 45 MB/year packed); the packed
figure is the credible one, since git delta-compresses and the kj-9 comparison
baseline is itself a packed number. Measure rather than argue.

**O8. Verify the `GITHUB_TOKEN` activity assumption** in section 8.
