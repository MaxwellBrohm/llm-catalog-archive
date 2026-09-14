# The posting desk

A scheduled agent reads the archive once a day, decides whether anything is
worth interrupting a stranger about, drafts the posts, and puts them on a review
page. Nothing leaves the building without a person pressing a button.

## Why it is not fully automatic

Not a technical limit. Three reasons, in the order they cost you if ignored.

**Hacker News forbids automated submission**, and the pattern that gets an
account shadowbanned is exactly the pattern this would produce: a young account
whose entire history is links to one domain, submitted on a timer. Reddit is the
same, and the sanction there is a sitewide ban that is difficult to appeal.
Losing either account costs the two channels that matter most to this project,
permanently, in exchange for saving about ten seconds a day.

**Credibility is the only asset here.** A site whose proposition is "we only say
what the stored bytes support" cannot afford one auto-posted claim that turns
out to be a source glitch. The scorer cannot tell a genuinely rare event from a
broken feed emitting a malformed one, and rarity is what it ranks on, so the
failure mode of an unattended posting routine is to enthusiastically announce
the most broken thing that happened that day.

**The queue is short by design.** Most days produce nothing. That is not the
system failing to find news, it is the archive being honest that a few hundred
catalogue changes contained nothing a developer needs to be told about. A
routine that posted every day would have to lower the floor until it did.

## One place, not six

The desk recommends a single venue per finding and puts the rest behind a
disclosure. That is not tidiness. Six equal buttons is not a recommendation, it
is a menu, and the thing a menu invites is pressing all of it, which is what a
community reads as spam and what actually costs the account. It also puts the
decision back on whoever is holding the phone at eight in the morning, at the
moment they have the least information.

**A venue is a place, not a platform.** Reddit is not a destination; r/LocalLLaMA
is. The subreddit is the difference between a post that lands and one that is
removed within the hour, so it is part of the address in `src/desk/venues.ts`
rather than left to the person pressing the button. Reddit's bare `/submit` is a
chooser, and routing that ends at a chooser has not routed anything.

The reason shown under the button belongs to the PAIRING of type and venue, not
to the venue. Two types share r/LocalLLaMA for different reasons, and reusing
one venue's description for both produced a desk that told the reader a merged
vLLM pull request mattered because it was "an unreleased model sighting".

**These are editorial judgements and nothing in the repository can verify them.**
No code here can read a subreddit's current rules, so every route is a claim
about an audience that can be wrong. What keeps them correctable rather than
folklore is `meta/posted.jsonl`: it records the venue each item actually went
to, so after a few dozen posts there is evidence, and the table should be
revised against that rather than against anyone's intuition.

Deliberate omissions matter as much as the inclusions. r/MachineLearning removes
news and product posts, so sending a catalogue diff there wastes the item and
earns a strike. Vendor subreddits beyond r/OpenAI and r/ClaudeAI are left out
rather than guessed at, because a subreddit that has been renamed swallows the
post silently; those items fall through to r/LocalLLaMA, which is a real
audience for them.

## The split

| Platform | How it goes out | Why |
| --- | --- | --- |
| Hacker News | prefilled submit form, human presses submit | automated submission is against the site guidelines |
| Reddit | prefilled submit form, human presses submit | same, and self-promotion by bot is banned per subreddit |
| X | prefilled intent, human presses post | posting through the API costs money at the tier that allows it |
| LinkedIn | prefilled share, human presses post | API posting needs app review |
| Bluesky | may be automated | open API, no approval, permits it |
| Mastodon | may be automated | open API, permits it |

Bluesky and Mastodon are the only two where a machine may post and nothing is
being circumvented. They are also the two with the smallest audience for this,
so the honest summary is that automation buys very little here and the two-tap
flow buys everything.

## What the score means

`src/desk/surprise.ts`. The score is the information content of the event's
type measured over the whole archive: `-log2 P(type)`, Laplace smoothed. A kind
of event that has happened twice in four hundred captures carries about 7.7
bits; one that happens every third capture carries about 1.6. Staleness is
charged at one bit per day, so a two-day-old item needs four times the rarity of
a fresh one to reach the same score. The floor is 4.5 bits.

The property worth having is that the ranking moves on its own. When model
retirements become routine they stop being news here, without anyone editing a
weight, because the archive's own distribution is the weight.

The property it does NOT have is any sense of whether a stranger cares. Rarity
is a proxy for "not routine", and a source that breaks once is maximally rare
and completely uninteresting. That gap is what the human at the desk is for.

## The rule the drafter will not break

A draft carries the deriving module's sentence byte for byte, or there is no
draft. It is never shortened to fit a platform's limit, because prefix
truncation can invert a claim and not merely weaken it: "no models were removed
from the catalogue" cut to length becomes "no models were removed". There is no
length at which cutting is safe, so a platform whose limit the sentence cannot
meet gets nothing and the desk reports the shortfall. A person may write a title
there. A machine may not.

In practice this means Hacker News almost always needs a human title, because
the derived sentences run 130 to 190 characters against an 80 character limit.
That is the correct division of labour rather than a gap: an HN title is an
editorial judgement and the machine has no business making one.

## Running it

    npm run desk

Prints the queue as JSON, including the funnel counts and the reasoning behind
each score. Read-only: it touches git through the same history reader the site
generator uses, writes nothing and posts nothing.

`meta/posted.jsonl` is the append-only record of what went out and where. It is
the cooldown's memory and the deduplication key, so the routine is restartable
on any machine with a clone and cannot double-post because a process died.

It has exactly one writer: the desk's own function, which appends a row through
the GitHub API when a platform button is pressed. The daily routine never writes
it, because two writers to an append-only file is how one of them ends up
clobbering the other, and because by the time the routine clones, the rows are
already there and the cooldown has already been applied.

The reason the writer is the web function rather than the routine is a wall, not
a preference: the routine's sandbox cannot reach the desk and the desk cannot
reach the routine. GitHub is the only thing both can talk to.

### Titles, and why they are not a paraphrase

Hacker News caps a title at 80 characters and the derived sentences run 130 to
190, so for the first week the desk refused HN every day and a person wrote the
title by hand for the one venue that matters most. That lasted a week.

A title is now composed from the event's own typed fields: `Arena codename
"kiana" resolves to qwen3.8-max-0902`, `vllm merges DeepSeek-V4-Flash-Vision-Exp
support`. This is not the rule eroding, and the difference is exact:

- every VALUE in the title (a codename, a model id, a repository, a date) is
  copied byte for byte from the event; the template supplies only the connective
  words between them. A test asserts this as a property over every template.
- it is a template, not a language model, so it cannot decide that
  "DeepSeek-V4-Flash-Vision-Exp" reads better as "DeepSeek V4". That freedom is
  the whole hazard, and a template does not have it.
- it is never truncated. A filled template over 80 characters returns nothing
  and the desk asks a person, as before.
- the draft records `titleBy: "template"` so nobody later mistakes a composed
  title for the derived sentence. The sentence itself is still never rewritten.

The HN form is prefilled with the composed title and can be edited there before
submitting, which is the right place to edit it: on the platform, by the person
pressing the button.

### Reddit is retired, and Hacker News is capped at two a day

Every real Reddit post this desk produced was removed within seconds. The
subreddits gate on karma, and an account whose entire history is links to one
domain is the exact pattern those gates exist for, so they keep firing after the
karma is earned. Reddit is routed nowhere as of 2026-09-14; it comes back the
day the account has a history there that is not this site.

Hacker News gets at most two candidates a day, the two highest-scoring. The
number is HN's: a new account is rate-limited past about two submissions in ten
minutes, and one that keeps submitting a single domain is flagged regardless of
pace. A desk offering five HN buttons also trains a person to press all five,
which is the behaviour that gets an account marked as a spammer.
