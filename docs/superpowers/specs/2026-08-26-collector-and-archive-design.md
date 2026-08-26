# Collector and Archive: design

Date: 2026-08-26
Status: approved in outline, pending review of this document
Sub-project: A1 of A-F (see "Where this sits")

## 1. What this is

A deterministic collector that fetches a fixed list of endpoints on a schedule
and commits their responses, verbatim, to a git repository. Git history is the
archive. `git log -p <path>` is the diff query.

It parses nothing. It has no opinion about what a model is, what a price
change means, or what counts as news. Every piece of interpretation lives in
the deriver (A2), which reads only from git history and can be re-run from
scratch over the whole archive at any time.

That separation is the entire point. It means a parsing decision made today is
reversible tomorrow, which matters because one day of live probing on
2026-08-25 to 26 found five URL relocations, one repository transfer, one
default-branch change and one vanished JSON endpoint. The world rots faster
than a schema can be got right.

### Non-goals for A1

Not in this sub-project: entity extraction, thread modelling, story writing,
ranking, dedup, rendering, the API, the CLI, the leaks desk, the accuracy
ledger, any use of a language model at all. A1 produces bytes on disk and
nothing else.

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

These came out of review and are load-bearing. Violating any of them silently
breaks a guarantee made elsewhere.

**R1. Verbatim.** The collector writes response bytes exactly as received. No
normalizing, no parsing, no schema, no field stripping, no re-ordering, no
pretty-printing at write time. An earlier draft proposed stripping volatile
fields; that was wrong. Stripping is lossy, and lossy at write time destroys
the recoverability that justifies the whole design. The CDN hash discarded
today is the fingerprint needed in March.

**R2. Verbatim is what makes the artifact link honest.** Auto-published events
must link the raw artifact they came from. An artifact that has been reshaped
by us is not evidence, it is our derivative. R1 is a precondition for the
publishing gate, not an aesthetic preference.

**R3. Normalization happens in the deriver, at diff time, never at write
time.** `docs.x.ai/llms.txt` is the worked example: 1,465,407 bytes whose
markdown table rows are randomly permuted per request, producing three
different md5s across three fetches while `sort <file> | md5sum` was identical
every time (`b92fafe614002915ea5a5b5e5be3060b`). The file is stored as
received; the deriver sorts before comparing.

**R4. Parsing is allowed for the commit decision, forbidden for the commit
content.** This is the narrow exception that keeps R1 workable. See section 6.

**R5. One stable path per source, overwritten in place, committed only on
change.** Not timestamped filenames. This is the pattern `kj-9` and
`models.dev` both use, measured at 615 commits over 691 days in a 2.8 MB
clone. Timestamped filenames grow the working tree without buying anything,
and they break `git log -p` on a single path.

**R6. Backfill never shares a path with go-forward capture.** Section 7.

## 3. Repository layout

```
ainews/
  .github/workflows/
    collect-fast.yml         every 15 min
    collect-daily.yml        daily, 00:20 UTC
  raw/                       go-forward captures, verbatim
    openrouter-models/response.json
    arena-leaderboard/response.html
    anthropic-sitemap/response.xml
    anthropic-deprecations/response.md
    claude-llms-txt/response.txt
    openrouter-llms-txt/response.txt
    openrouter-sitemap/response.xml
    openai-llms-txt/response.txt
    together-llms-txt/response.txt
    groq-llms-full-txt/response.txt
    mistral-llms-txt/response.txt
    perplexity-llms-txt/response.txt
    xai-llms-txt/response.txt
    modelsdev-commits/response.atom
    claude-status/response.atom
    openai-status/response.atom
  backfill/                  third-party archives, NOT verbatim, see s7
    kj-9-openrouter/
      PROVENANCE.md
      snapshots/YYYY-MM-DD.json
    models-dev/
      PROVENANCE.md
      snapshots/...
  meta/
    sources.json             the source table, versioned
    status.json              per-source liveness, see s8
  docs/superpowers/specs/
```

Each `raw/<source>/` directory also carries a `headers.json` recording the
response headers of the most recent successful fetch (section 9).

## 4. Source inventory and tiers

Every entry below was probed live on 2026-08-26 and, where load-bearing,
independently re-probed by a second agent instructed to refute the first.

### Fast tier: every 15 minutes

| Source | Path | Evidence for the cadence |
|---|---|---|
| OpenRouter catalog | `https://openrouter.ai/api/v1/models` | `cache-control: max-age=300`, `cf-cache-status: HIT`. Polling faster than 5 min returns the same cached bytes. 15 min is the smallest interval that is never wasteful. 417 models, 687,878 bytes. |

Nothing else is in the fast tier. Every other source either lacks evidence for
sub-daily change or has evidence against it.

### Daily tier: 00:20 UTC

| Source | Path | Notes |
|---|---|---|
| Arena leaderboard | `https://arena.ai/leaderboard` | See section 6. Cadence to be measured, not assumed. |
| Anthropic sitemap | `https://www.anthropic.com/sitemap.xml` | 515 URLs, 515 with `lastmod`, 67,354 bytes. |
| Anthropic deprecations | `https://platform.claude.com/docs/en/about-claude/model-deprecations.md` | 13,410 bytes, versus 1,006,482 for the HTML. The forecasting artifact. |
| Anthropic docs index | `https://platform.claude.com/llms.txt` | md5 `c6f28f2def3baf0ced86de167ab73b0f`, reproduced cross-session. |
| OpenRouter docs index | `https://openrouter.ai/docs/llms.txt` | md5 `a49696379da0cc2e249964675d2ae5f6`. |
| OpenRouter sitemap | `https://openrouter.ai/sitemap.xml` | md5 `3eded80e36354bc149d152427764ca7e`, and its newest `lastmod` matched to the millisecond across fetches, so the file is genuinely static rather than regenerated per request. Needs retry: a `curl: (35)` reset was observed. |
| OpenAI docs index | `https://developers.openai.com/api/docs/llms.txt` | 34,432 bytes, md5 `a7a8969e05ceb91b37187edcff88902a`. **Not** `platform.openai.com/llms.txt`, which 404s, and **not** `platform.openai.com/docs/llms.txt`, which is a 301 to an 81-byte stub. A differ pointed at the stub reports "no changes" forever. |
| Together docs index | `https://docs.together.ai/llms.txt` | md5 `63892d959ca9ce0e3011d5a9a8fb2990`. |
| Groq docs full | `https://console.groq.com/llms-full.txt` | 797 KB. Groq has zero `.md` twins, so this is the only path to content-level Groq diffs. |
| Mistral docs index | `https://docs.mistral.ai/llms.txt` | 15 KB. |
| Perplexity docs index | `https://docs.perplexity.ai/llms.txt` | 43 KB. |
| xAI docs index | `https://docs.x.ai/llms.txt` | 1.46 MB, permuted rows, see R3. No `llms-full` exists. |
| models.dev commits | `https://github.com/anomalyco/models.dev/commits.atom` | 17,855 bytes, no API rate limit. **20-entry window spans under 8 hours at burst rate**, so a daily poll loses commits. See open question O3. |
| Anthropic status | `https://status.claude.com/history.atom` | The one real Anthropic feed. Mixes `published` and `updated`; 16 of 25 entries share a bulk backfill `updated` of 2026-08-14. Key on `published`. |
| OpenAI status | `https://status.openai.com/history.atom` | |

### Explicitly excluded, with reasons

| Endpoint | Why |
|---|---|
| `platform.claude.com/llms-full.txt` | 39,763,086 bytes. 39.8 MB per day. |
| `platform.claude.com/sitemap.xml` | 2,901 URLs, zero `lastmod`. Add/remove detection only. |
| `ai.google.dev/*` | llms.txt loops through Google OAuth until curl bails at 50 redirects. Sitemap index returns 200 with a fresh lastmod while **all three child sitemaps return HTTP 500 with a zero-byte body**. Gemini docs coverage needs a different mechanism; flagged, not solved. |
| `qwenlm.github.io/blog/index.xml` | 200, valid XML, 44 items, newest post 2025-09-23. 337 days stale while Qwen shipped three flagship models. The StrictlyVC trap. |
| `cohere.com/blog/rss.xml` | 1 MB of XHTML that a Python XML parser **accepts** with `root=html`. Proves "does it parse as XML" is not a sufficient gate on its own. |
| `alignment.anthropic.com/feed.xml`, `red.anthropic.com/rss.xml` | 200 + text/html catch-alls. `/zzz-not-a-real-path-9999` returns a byte-identical body. |
| `buttondown.com/ainews/rss` | 2.6 MB of valid RSS, newest item 2025-04-25, channel title says "MOVED TO news.smol.ai". |
| `theneurondaily.com/feed` | 200 at ~348 KB of React SPA HTML. |
| Reddit, anything | Section 11. |
| `pytorch/pytorch/releases.atom` | All 10 entries are `viable/strict/<runid>` CI tags. 200, valid Atom, fresh timestamps, completely wrong. GitHub's `releases.atom` is a tags feed. |

### Health-check rule

A source is healthy only if **all** of: the status is 2xx, the body parses as
its declared type, and, for feeds, the newest item is within 60 days. Any one
failing marks it unhealthy. The cohere case above means the parse check must
also assert the root element is the expected one, not merely that a parser
accepted the bytes.

## 5. Schedule and the tier justification

`collect-fast.yml` runs `*/15 * * * *`. `collect-daily.yml` runs `20 0 * * *`,
deliberately eight minutes after `kj-9`'s `12 0 * * *` so that if that repo is
ever used as a live corroborator its commit has landed first.

GitHub's scheduled workflows are best-effort and can be delayed by minutes
under load. Nothing in this design may assume a run happened at its nominal
time; every timestamp comes from the response or the commit, never from cron.

## 6. Change detection, and the one place parsing is allowed

R1 says the collector writes verbatim bytes. It does not say the collector must
commit every fetch. The commit decision is allowed to look inside the response;
what gets written is still the untouched bytes.

This exists because of a measured problem. `arena.ai/leaderboard` returns
5,235,084 bytes and carries a **per-request provisional `userId`** (a UUIDv7,
first differing byte at offset 477189 between two fetches). Two fetches seven
minutes apart differed by six bytes, while the 1,008 model records, all 810
`rating` values, all 810 `votes` values and the entire `publicName` to
`displayName` map were **identical**. Committing on byte difference would
therefore commit a 5 MB blob every run forever, and every commit would record
nothing but a fresh anonymous session identifier in a public repository.

So each source declares a change predicate in `meta/sources.json`:

- `bytes` (the default): commit when the response bytes differ. Used by every
  source except arena.
- `ignore-pattern`: commit when the bytes differ after masking a declared
  regex. Arena uses this, masking the `userId` UUID.

The predicate never alters what is written to disk. It only decides whether to
write. Every predicate other than `bytes` must be declared in
`meta/sources.json` with the reason recorded, so the exception list is a
reviewable artifact rather than scattered code.

Arena also gets a recorded caveat: the committed HTML still contains one
provisional session id on the runs where the data genuinely changed. It is our
own id, anonymous and provisional, so the risk is untidiness rather than
disclosure, but it is a known property of the archive and belongs in the
repository README.

### Arena cadence: measured, not asserted

Evidence available today says the arena data is **not** continuously updated:
ratings, votes and the codename map were static across seven minutes, and the
companion dataset `lmarena-ai/leaderboard-dataset` reported `lastModified`
2026-08-26T03:01:35Z. That is consistent with a daily batch around 03:00 UTC
and is not proof of it. Two fetches cannot establish a cadence.

Therefore: arena starts in the daily tier, and the true cadence is derived from
the archive's own commit timestamps after two weeks of collection. If the
interval turns out to be sub-daily the tier moves; if it is weekly the tier
moves the other way. This is an action item, not a permanent decision.

### A correction to carry forward

Of the 60 rows where `publicName != displayName`, the majority are label
variants, not codename reveals: `grok-4.6` to `grok-4.6-high`, `glm-5.3` to
`glm-5.3 (max)`, `gpt-5.4-no-system-prompt` to `gpt-5.4`. Genuine reveals are
roughly 10 to 18 of them (`kiteki` to `qwen3.5-max-preview`, `deep-octo` to
`minimax-m2.7`, `significant-otter` to `gemma-4-26b-a4b`, `thunbergia-alpha` to
`qwen3.8-max`, `august26-chatbot1` to a specific NVIDIA Nemotron build).

Any deriver that reports the raw count of differing rows as "codenames
revealed" will overstate by three to six times. The filter is a property of the
publicName string (nonsense word, animal name, or `<month><year>-chatbotN`
pattern), not of the inequality. Counts are 1,008 records, 839 distinct
`publicName`, 844 distinct `displayName`, reproduced three times across two
independent sessions.

## 7. Backfill

Backfill imports two third-party git archives so the product launches with
history rather than accumulating it. Both were cloned and analysed on
2026-08-26.

### The separation rule, and why it is not optional

**Neither backfill source is a verbatim artifact.**

`kj-9/openrouter-models-json` stores the output of
`curl … | jq '.data | sort_by(.id)'`. That strips the response envelope and
re-sorts entries by id. The live API returns entries ordered by `created`
descending, verified byte-identical across three fetches. So the backfill and
the go-forward capture differ in both shape and ordering.

`anomalyco/models.dev` stores per-model TOML files, a different structure
entirely.

If either were written into `raw/`, the deriver would hit a silent format and
ordering change at the cutover date, and any event derived from that window
would link "the raw artifact" and serve someone else's normalized derivative.
That breaks R2 directly.

Hence R6: `backfill/kj-9-openrouter/` and `backfill/models-dev/` are separate
trees. Each carries a `PROVENANCE.md` naming the upstream source, the exact
transform applied upstream, the licence status, and the import date. Every
derived event carries a provenance field distinguishing `observed-directly`
from `observed-via-third-party-archive`.

This also makes the licence question survivable: if `kj-9` never adds a LICENSE
and the decision is to drop it, that is one tree deleted and a deriver re-run,
not an unpicking operation against a merged archive.

### `kj-9/openrouter-models-json`

| Property | Value |
|---|---|
| Commits | 615 |
| Range | 2024-10-05 to 2026-08-26 |
| Span | 691 days, 613 distinct days committed, 88.7% |
| Largest gap | 5 days (2025-01-02 to 2025-01-08) |
| Unparseable snapshots | 2 of 615 |
| Clone size | 2.8 MB |
| Cron | `12 0 * * *`, commits only on change |
| Licence | **None. No LICENSE file, no licence metadata.** |

Replaying all 615 commits yields 970 distinct model ids ever seen against 417
live today, 325 models with at least one price change, and 272 with a context
window change. Sample findings that demonstrate the value:
`z-ai/glm-5.2` has 51 distinct price states since 2026-06-17;
`deepseek/deepseek-chat` context went 128000, 65536, 64000, 16000, 131072,
16000 across four months; `google/gemini-2.0-flash-001` flapped between
1000000 and 1048576 five times in April 2026.

**Licence status is unresolved and must be resolved before launch.** Default is
all rights reserved. The mitigating facts are that the payload is a mechanical
transformation of a public unauthenticated API and the items are facts rather
than authorship, and that what is actually being used is the observation
timestamps rather than the file. Those are mitigations, not a licence. Action:
open an issue on the repository asking for one, before launch rather than
after. If declined or unanswered, drop the tree and accept models.dev's
2025-06-04 start as the floor.

### `anomalyco/models.dev`

| Property | Value |
|---|---|
| Commits | 8,405 |
| Range | 2025-06-04 to 2026-08-26 |
| Clone size | 21 MB |
| Default branch | **`dev`, not `main`** |
| Licence | **MIT** |
| Coverage | 202 providers, 7,303 models |

The brief named this repo as `sst/models.dev`. It was transferred; the old path
returns a 301 with a 198-byte stub in which every field a caller wants is null.
`raw.githubusercontent.com/anomalyco/models.dev/main/...` 404s because the
default branch is `dev`.

### Precision, and the schema consequence

`kj-9`'s cron is `12 0 * * *`, so a model that appeared at 20:04 UTC is first
recorded at 00:12 the following day. First-appearance dates from backfill carry
a **typical error of one day and a worst case of five**.

The field is therefore named `first_seen_in_catalog_at`, literally, with
sibling `provenance` and `precision` fields. Not `launched_at`, not
`released_at`, not `first_seen` unqualified. A field named `launched_at`
anywhere in the schema will eventually be rendered as a launch date by
something downstream, and a one-day-typical, five-day-worst caveat is exactly
the kind of qualification that survives in a document and dies in a template.
The name carries the caveat because the name is the only thing that always
travels with the value.

## 8. Liveness, status, and failure alerting

GitHub disables scheduled workflows after 60 days of repository inactivity.
This interacts badly with "commit only on change": a broken collector stops
committing, which is exactly the inactivity that triggers the disable, which
makes the break permanent and silent. Absence of commits currently means both
"nothing changed" and "I am dead," and those must be separable.

**`meta/status.json`** carries, per source: last attempt, last success, last
change, consecutive failure count, most recent HTTP status, byte count, and the
recorded response headers.

**Commit cadence for status.json**, per review: not on every fast-tier run. At
15 minutes that would be roughly 96 commits a day and 35,000 a year, against
`kj-9`'s 615 in 691 days, and it would buy nothing because the 60-day clock
needs daily granularity rather than quarter-hourly. So:

- committed once per day, by the daily job, unconditionally;
- committed immediately on any transition **into** failure for a source;
- committed immediately on any transition **out of** failure.

That guarantees at least one commit per day regardless of whether the world
changed, so the 60-day clock never starts, while keeping the history legible
and `git log -p raw/openrouter-models/response.json` fast.

**Alerting** needs no third-party service. The daily job exits non-zero when
any source has failed N consecutive runs (N=3 for daily sources, N=8 for the
fast tier, roughly two hours). GitHub emails the repository owner on scheduled
workflow failure by default. Alerting is therefore a property of the exit code,
with no secret to rotate and nothing to pay for.

## 9. Response headers

Every fetch records `etag`, `last-modified`, `date`, `age`, `cache-control` and
`cf-cache-status` into `raw/<source>/headers.json`. This is cheap, parses
nothing, and does three jobs: it enables conditional requests later
(`If-None-Match`, `If-Modified-Since`) without a redesign, it is the
corroborating evidence for timestamp claims the publication will make, and it
distinguishes a cached response from a fresh one when reconstructing what was
actually observed and when.

Headers are recorded on every successful fetch but committed on the same
schedule as `status.json`, for the same reason.

## 10. The publishing gate, as it constrains A1

The gate itself is D, but two of its rules constrain the archive now.

**The auto-publish line is who composed the sentence, not whether the fact is
machine-checkable.** Templated output assembled from structured fields
auto-publishes. Anything a language model wrote goes to review, however
factual. This is a better line than machine-checkability because it survives
the case that breaks it: a model writing a perfectly true sentence is still a
model writing a sentence, and that is precisely what Nota News and Prism News
died of.

**Consequences A1 must satisfy:**

1. Every auto-published event links the raw artifact it came from. Requires R1
   and R2, and requires stable per-commit permalinks into the archive.
2. An append-only correction log and a retraction path exist from the start,
   not added later.
3. The auto tier is rate-limited so a provider reformatting its docs cannot
   emit a flood of spurious changes. Batch anomalies hold for review.

**The anomaly threshold has a concrete rule from the probe data:** any `lastmod`
value shared by N URLs at the same millisecond is a build artifact, not N
stories. The Anthropic sitemap demonstrates it twice, with five top-level pages
sharing one build timestamp and six economic-index posts sharing another. The
site-root URL is worse still: its `lastmod` ticked from 12:51:24.149Z to
13:04:36.700Z in thirteen minutes and will fire on every poll. It is excluded
by name.

## 11. Legal constraints that bind the collector

Not legal advice. These are what the documents say, and where they were not
readable this says so.

**Store freely:** Epoch AI data (CC-BY 4.0, confirmed in the README shipped in
every archive), `lmarena-ai/leaderboard-dataset` (`cc-by-4.0` in the HF
`cardData`), models.dev (MIT).

**Do not ingest at all: Reddit.** Four verified constraints: Developer Terms
4.1 and Data API Terms 3.1 require a separate agreement for commercial use;
Data API Terms 2.4 forbids using content to train a model; deletions must
propagate "as soon as possible" and "immediately"; on termination you must
delete derived data and models. Reddit may be read and linked by a human. It is
not a collector source.

**Correction to the brief:** the widely-repeated "48-hour deletion window" does
**not appear in any readable Reddit document**. The only occurrence of "48" in
the Developer Terms is `48 C.F.R. 12.212`. Nor does the phrase "even if
disassociated, de-identified or anonymized" appear anywhere. The real standards
are looser in form and stricter in effect, because there is no fixed-hour safe
harbour to design a nightly batch against. Neither phrase may appear in
anything this project publishes. (The cited support page is Cloudflare-403 to
both curl and WebFetch, so this is marked unverified-and-probably-wrong rather
than definitively refuted.)

**Avoid entirely:** third-party scraper and SERP-proxy vendors. *Reddit, Inc.
v. SerpApi LLC*, 1:25-cv-08736 (S.D.N.Y.), is a five-party case, not two, and
the 7/31/2026 opinion predominantly denied the motions to dismiss, sustaining
DMCA 1201(a)(1)(A) against **both** SerpApi and Perplexity, the buyer. Buying
laundered data did not insulate the buyer at the pleading stage. Live and
unresolved: no final judgment, no appellate ruling.

**Also avoid:** anything that circumvents an access control, rate limit or bot
detection, on the same 1201 theory.

**Unverified, and must be checked before relying on them:** terms for
OpenRouter's API, the HuggingFace API, HN Algolia, CourtListener, the Federal
Register, and every publisher feed. None was probed. Absence of a probe is not
absence of a restriction.

**Politeness limits observed:** GitHub core API is 60/hour unauthenticated;
GitHub *search* is a separate bucket at 10/minute unauthenticated and 30 with a
token. Reddit's `.rss` returned a bodyless 429 on a single first request with
`x-ratelimit-remaining: 0.0`, so a status-blind poller would read that as an
empty feed.

## 12. Testing

The collector is mostly I/O, so the tests concentrate on the parts that are
pure and on the failure modes that are silent.

**Pure, tested directly:** the health-check predicate (status, body parse, root
element, freshness), the change predicates (`bytes` and `ignore-pattern`), the
status-transition logic that decides when to commit `status.json`, and the
consecutive-failure counter that drives the exit code.

**Fixture-driven, from bytes captured today:** each trap gets a fixture and a
test asserting it is classified unhealthy. The cohere XHTML body that a parser
accepts. The 337-day-stale Qwen feed. The byte-identical anthropic catch-all.
The pytorch tags-masquerading-as-releases feed. The 81-byte OpenAI redirect
stub. These are the cases where a naive check returns "healthy" forever, and
each one is a real captured response rather than a synthetic.

**Mutation testing, per the standing rule:** every assertion here must be
watched failing before it is trusted. Specifically, the absence-style
assertions ("this trap is detected as unhealthy") are the vacuous ones: the
fixture must be verified to actually contain the trap, and the check must be
verified to pass on a healthy fixture, or the test proves nothing.

**Not tested by mocking the network.** The source table's correctness is a
property of the world, not of the code, and it is checked by the daily health
run rather than by a unit test that would pass forever against a stale mock.

## 13. Open questions to resolve before or during implementation

**O1. Re-hash the nine llms.txt files against the recorded md5s.** The stability
window measured was roughly six minutes. That rules out per-request nonces and
randomized ordering, which is what would have killed the differ. It does **not**
rule out a nightly rebuild that rewrites an unchanged file with a new build
stamp. Re-hash tomorrow against the values in section 4 and confirm the ones
with no docs changes still match. Do this before writing the differ, because a
nightly stamp would make every daily diff noise.

**O2. `kj-9` licence.** Open the issue. Decide the fallback explicitly.

**O3. models.dev `commits.atom` window.** The feed holds 20 entries and, at
observed burst rate, 20 entries can span under 8 hours. A daily poll therefore
loses commits permanently. Either move it to the fast tier, or poll the REST
commits endpoint with pagination, or accept that models.dev's own git history is
the durable record and treat the feed purely as a change trigger. Recommend the
third: the repository is cloned for backfill anyway, so a `git fetch` is a
complete and gap-free alternative to the feed.

**O4. Arena cadence.** Measure from the archive after two weeks. Section 6.

**O5. Gemini docs.** `ai.google.dev` has no working diff surface at all. Decide
whether Gemini docs coverage is load-bearing and, if so, find a mechanism.
Flagged now rather than discovered later.

**O6. Repository name and public/private.** The name is deliberately undecided;
`ainews` is a working directory name and not a brand. Public is assumed, per
the git-as-public-audit-trail argument, but nothing here depends on it.
