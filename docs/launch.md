# Launch: what to post, when, and what not to claim

Nothing here has been posted. This is a draft for you to review, edit and submit
yourself when you decide to.

## The recommendation: not yet

The archive is 6 days old. Every number it publishes gets better with time and
several of them are currently thin in ways a reader will notice:

- **The leaks desk holds 2 codenames.** `teffa-alpha` and `yangcheng`. That is a
  real signal and it is also two rows. At 20 rows it is a dataset.
- **`first_seen_in_catalog_at` is null on all 621 models**, because the measured
  worst-case error is 348,766 seconds against an 86,400 second gate. That is the
  thesis working, and it is also a column of nulls. It fills in as the capture
  history tightens.
- **The accuracy ledger has 1 resolved claim.** A scorecard reading "0% over one
  claim" invites a fair objection about sample size.
- **Retirement floors cover one provider.** `llmcat retiring` says so on every
  run, which is the right behaviour, and it still means the killer query answers
  for Anthropic and nobody else.

None of this is broken. All of it is early. Two to four more weeks of collection
turns each of those from a demo into evidence, and none of it needs code.

**The one thing worth waiting for specifically**: more resolved expiry claims.
"Here is a field OpenRouter publishes, here is how often it is right" is a
finding. One data point is an anecdote.

## The strongest angle, when you do post

Not the front page and not the 3D wall. **The byte-level documentation differ.**

Nobody else diffs provider documentation daily with the raw bytes linked at a
commit sha. The single most shareable artifact this project can produce is one
well-timed post of one diff: *here is the exact hour a provider's llms.txt
changed, here are the bytes, here is the permalink.* That is a per-event loop
that runs forever, not a one-shot launch.

The second strongest is the expiry scorecard, for the same reason: it answers a
question a developer has actually wondered about, with evidence.

## Draft Show HN post

> **Show HN: I diff what LLM providers publish, and link the exact bytes**
>
> I built a byte-level archive of what model providers actually publish: catalog
> endpoints, llms.txt files, documentation indexes, status feeds, deprecation
> tables. A scheduled job stores every response verbatim, git history is the
> database, and at deploy time a pure function turns the diffs into typed events.
>
> Every sentence on the site links to the exact bytes it came from, at the commit
> that stored them. There is no language model anywhere in the generator: every
> claim is a template filled from a diff and a headers sidecar.
>
> Two things it does that I could not find elsewhere:
>
> - It scores the catalog's own predictions. OpenRouter publishes an
>   `expiration_date` per model. The archive records that as a claim and checks
>   it against a later capture. So far one has come due and the model was still
>   listed.
> - It refuses to print dates it cannot support. Every `first_seen_in_catalog_at`
>   is null, because the measured worst-case error for that source is 348,766
>   seconds against the 86,400 second resolution the field would render at.
>   Publishing 621 nulls instead of 621 plausible dates is the point.
>
> Keyless JSON API and a CLI, no signup, no rate limit:
>
>     npx -y github:MaxwellBrohm/llm-catalog-archive retiring --within 90d
>
> It exits 2 when it cannot answer for a name you asked about, because a CI gate
> that returns 0 on no data is worse than no gate.
>
> Free, no ads, no reader paywall. Site: <URL>. Code: <URL>.

## Pre-launch checklist

Run these the morning you post. Every one has been verified at least once, so a
failure means something changed.

- [ ] `npx vitest run` is green
- [ ] `rm -rf ~/.npm/_npx && npx -y github:MaxwellBrohm/llm-catalog-archive help`
      prints the help, from a directory that is not the repo
- [ ] The README's first code block still produces roughly what it pastes
- [ ] `curl -s <site>/api/v1/index.json | jq '.endpoints'` resolves
- [ ] `llmcat retiring --within 90d`, and its exit code is what you expect
- [ ] The liveness workflow ran today and closed rather than opened an issue
- [ ] `grep -rniE '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' build/site` is empty
- [ ] The front page loads with JavaScript disabled and the thread list is complete

## Objections you should expect, and the honest answer to each

**"models.dev already does this and has 7,478 models."** True, and the site says
so with the numbers, and points at them. This archive tracks one catalog and a
handful of documentation indexes. What is different is that every value is
addressed by commit and linked to the bytes it came from.

**"pricepertoken has price history."** Also true, at a keyless
`/_payload.json`. The site says that too. An earlier version of that sentence
claimed they had no API, which was wrong, and the page now says it was wrong.

**"Your leaks desk has two items."** Correct. That is why waiting is the
recommendation.

**"An archive of other people's bytes has a GDPR problem."** It does, it is
stated on the About page and in DATA.md, and the conflict between an erasure
request and a history that is never rewritten is described as a real unpaid cost
rather than a technicality.

## What not to do

- Do not claim the archive is comprehensive. It tracks 18 sources.
- Do not describe a derived event as a scoop. The desk describes stored
  artifacts and predicts nothing.
- Do not put a company in the subject of a sentence. The whole copy rule exists
  to prevent exactly the headline that would get the most clicks.
