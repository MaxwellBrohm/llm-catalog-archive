# The publication and the data product: design

Date: 2026-08-30
Status: draft, supersedes the sequencing (not the content) of the A1 spec
Companion: `2026-08-26-collector-and-archive-design.md`

## 1. What this corrects

The original brief asks for a news site for developers, with a saleable data
byproduct. Four days of work produced a collector, a docs differ, and a
changelog with no narration. That is steps 1 and 3 of the brief's build order,
and a thin slice of step 4.

**The drift, stated plainly.** Of the three gaps the brief names, the research
partly killed one: gap 3, the narrated changelog, is occupied by `llmstatus.ai`.
That is the one we built, minus the narration. The two gaps that survived, the
queryable entity archive (gap 1) and the graded leaks desk (gap 2), are
untouched, and we hold the best raw material anyone has for gap 2.

The cause was a framing error: after the research, the choice was put as *data
surface versus publication*, and the brief already answers it the other way.
"Sell the structured data to teams instead, **later, once there is an
audience**. The differ has to exist anyway **to produce the news**." The data is
a byproduct. It became the product.

## 2. The shape

Three things, in this dependency order. The publication is the point; the data
product funds it; the archive feeds both.

```
  archive (built)  ->  entity model  ->  publication      <- readers, free forever
                            |
                            +-------->  data product      <- teams, paid
```

**The publication is free forever, no ads, no reader paywall.** Ads give a
publication a negative incentive to deflate a launch, which is the exact
failure the editorial premise exists to correct.

**The data product funds the publication.** It aligns the business with the
premise: you get paid for being right, which is what readers want too.

## 3. The three data tiers

Sell everything collected; push what is unique. The marginal cost of exposing
data already being collected is zero, so the only question per dataset is which
shelf it sits on.

### Tier U: nobody has this

| Dataset | Why it is unique | State |
|---|---|---|
| **Arena codename map** | 39 verified codename-to-real-model reveals in an undocumented Next.js payload. Two daily diffs: a new `publicName` means a model entered testing; a `publicName` gaining a `displayName` means it was just unmasked. Not on HuggingFace. Published by no one. | extractor specified, not built |
| **Docs differ** | Nine providers' `llms.txt`, sitemaps and the deprecations `.md`, diffed daily. Prior art: one repo at 1 star. | **built and running** |
| **Upstream PR leak feed** | `transformers` and `vllm` PRs naming models with zero HuggingFace repos. Qwen4Exp was found this way, merged, with no weights in existence. | not built |
| **The join** | Nobody joins catalog + price + lifecycle + docs diffs + leak signals in one surface. The research concluded this is the only surviving gap. | not built |

### Tier B: better than what exists

Not cheaper. **Accessible.** The incumbents are not expensive, they are shut.

| Dataset | Incumbent | Their gap |
|---|---|---|
| Price history | `pricepertoken.com` | No API and no feed. `/api/pricing-history` returns `{"api_version":"deprecated"}` naming a successor that 404s. |
| Lifecycle events | `llmstatus.ai` | Structured feed exists and is good; the API is 401-walled. |
| Catalog history | `models.dev` | Current state only. History exists solely as `git log -p` over 5,500 sync PRs. |

### Tier F: commodity, free forever

Current model list, current prices, current context windows, current
deprecation status. Costs nothing to serve, we collect it regardless, and it is
the front door that gets Tier U looked at.

**Pricing principle:** simple enough to understand without a call, cheap enough
that a team expenses it without asking, and never a blocker to reading the
news. The killer query the brief names is a webhook, not an article: *which
models I depend on have a retirement floor inside my planning horizon, and what
breaks.* No paid tier ships at launch; it responds to demand that is visible.

## 4. The entity model

This is the schema decision everything else depends on, and deferring it was
the error. Raw storage makes it **reversible**, which is why it is safe to
build now and change later, but not building it at all means there is no
publication, only diffs.

**A story is a persistent entity that accretes events over time**, not a dated
post. A codename leak in August, the launch in October and the price change in
December are one thread.

```
Entity   lab | model | api-surface | benchmark
Event    an observation, derived from the archive, immutable, artifact-linked
Thread   a named entity plus every event that attaches to it, newest first
```

Events derive from git history by replay, so the derivation is a pure function
of the archive and can be re-run from scratch when the model changes. That is
what makes this reversible.

**Attachment is deterministic first, judged second.** Entity extraction from an
event is mechanical: a model id, a lab name, an API path. Where mechanical
attachment is ambiguous, the event is held rather than guessed. No model
attaches events silently.

**Quiet days.** A day with no new events still has live threads worth reading,
which is the brief's stated reason for wanting threads at all.

## 5. The publication

Sections, all one publication rather than separate products:

- **Everything**, reverse chronological, the front page.
- **Rumors and leaks**, graded (section 6).
- **Changelog**, the narrated diff, which is where today's changelog surface goes.
- **Threads**, the entity archive: every lab, model and API surface with its history.

**Every story is a real, fast, permalinked, server-rendered HTML page.** The
archive is only valuable if it is linkable and indexable, Google sees nothing
inside WebGL, and most shared links open on a phone.

**The 3D front door is an index, never a substitute.** A locked-camera wall of
billboarded tabs, deep-linked, built over HTML that already works. Locking the
camera avoids the usual failure where a 3D site is annoying to navigate.

**Design language forked from MaxOS**, not its desktop shell: near-black grounds
(`#050505` void, panel ramp to `#1a1a1e`), orange as the only live colour
(`#ff6a00`), roughly 90% black and 9% orange, Space Grotesk display, Inter UI,
JetBrains Mono data. Matte slabs with a faint orange edge light. A news site is
a reading surface, not an OS metaphor.

## 6. The leaks desk

The gap that survived the research and the one with the best raw material.

**Every item carries a sourcing tier**, and the tier is about the artifact, not
about confidence:

| Tier | Means | Example |
|---|---|---|
| `confirmed-artifact` | A publicly observable artifact exists and is linked | A merged `transformers` PR naming a model with no HF repo |
| `credible` | A named source with a track record in the ledger | |
| `unconfirmed` | Reported, no artifact | |

**The public accuracy ledger.** Every rumor, and whether it panned out. Nobody
in AI does this and it is immediately citable. It is also the thing that makes
the data product worth paying for: a scorecard is evidence of being right.

**The defamation line, which is a copy rule and not a disclaimer.** "A model
named X appears in Y's picker" and "X is Y's next flagship" are different
claims and must never be merged into one sentence. The first describes an
artifact. The second attributes intent to a company.

**Never rehost.** Describe and screenshot. Publicly observable artifacts are not
trade secrets; participation, not knowledge, is the line.

## 7. Build order

1. **Entity model.** Events by replay, entities, threads. Pure over the archive.
2. **Publication.** Thread pages, section pages, RSS. HTML first.
3. **Leaks desk.** Arena codename poller, upstream PR feed, tiers, accuracy ledger.
4. **3D front door** over the working HTML.
5. **Data product.** Free keyless API and CLI over all three tiers.
6. **Distribution.**

The collector is frozen where it is: 11 of 16 sources collecting daily, health
gate and heartbeat in place. Its five remaining hardening tasks are real and
resumable, and they are not the product.

## 8. Distribution, answered concretely

The brief is right that this is the part everyone skips, so it gets an answer
before launch rather than after.

**How does person #1000 find this?** The free keyless API and CLI, because Show
HN explicitly excludes "newsletters, lists, and other reading material" and
requires something people can run. That is exactly how `llmstatus.ai` packaged
itself, which is unlikely to be a coincidence. The CLI is the front door for
developers; the publication is what they stay for.

Secondary: the accuracy ledger is citable, and the arena codename map is
shareable in a way a card grid is not.

Not available: lobste.rs is invite-only and treats AI-industry news as
off-topic. Reddit is read-and-cite only, never ingest.
