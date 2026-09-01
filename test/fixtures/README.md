# Fixtures

Every file here is a real captured response, not a synthetic. Each exists to
prove exactly one property, and a fixture whose property has silently stopped
being true is a test that proves nothing. Re-verify before trusting any of
them.

The byte counts below are the ones captured on 2026-08-26. A file whose size no
longer matches has been recaptured, and its property needs rechecking before
any test built on it is trusted.

Captured 2026-08-26 with:
`curl -sSL -m 90 -A '<the collector UA>' -o <file> <url>`

**`-L` is not optional.** Two of these sources now answer with a redirect that
`curl` without `-L` stores as a 15-byte or 0-byte stub, which silently turns
their tests vacuous. That happened once during Task 6 and is why this note
exists.

| File | Bytes | URL | Property it proves | Verify with |
|---|---:|---|---|---|
| `healthy-claude-llms.txt` | 72,234 | platform.claude.com/llms.txt | a healthy text source | non-empty, carries its canary |
| `healthy-openrouter.json` | 685,304 | openrouter.ai/api/v1/models | a healthy json source | `data` array over 300 entries |
| `healthy-anthropic-sitemap.xml` | 67,487 | www.anthropic.com/sitemap.xml | a healthy xml source | root is `<urlset>` |
| `trap-cohere-xhtml.xml` | 1,024,672 | cohere.com/blog/rss.xml | **an XML parser ACCEPTS it and the root is `<html>`**, so "it parses" is not a sufficient health check | `ET.parse()` succeeds, root tag is `html` |
| `trap-qwen-stale.xml` | 39,167 | qwenlm.github.io/blog/index.xml | 200, valid XML, parses, and years stale | newest item date is far in the past |
| `trap-anthropic-catchall.html` | 64,176 | alignment.anthropic.com/feed.xml | a feed path that returns the blog homepage | byte-identical to `trap-anthropic-404path.html` |
| `trap-anthropic-404path.html` | 64,176 | alignment.anthropic.com/zzz-not-a-real-path-9999 | the pair above, for the identity check | `cmp` against the catch-all |
| `trap-interstitial.html` | 345,910 | theneurondaily.com/feed | a 200 that is not the feed: it is the site homepage. It carries the Cloudflare **beacon** `__CF$cv$params` and ZERO challenge markers, which is the measurement that got `__CF$cv$params` taken off the denylist | `<title>The Neuron</title>`; zero denylist markers; carries `/cdn-cgi/challenge-platform/scripts/` and not `/h/` |
| `trap-cf-challenge-udemy.html` | 5,575 | www.udemy.com/ | a REAL Cloudflare managed challenge, captured at HTTP 403 on 2026-08-31. Carries `cf_chl_opt`, `/cdn-cgi/challenge-platform/h/`, `Just a moment` and `Enable JavaScript and cookies to continue`, and carries NO `__CF$cv$params` | `<title>Just a moment...</title>`; four denylist markers |
| `trap-cf-challenge-indeed.html` | 27,518 | www.indeed.com/ | the other real challenge, and it earns its place by having NO `Just a moment` title. A denylist of human-readable strings alone would pass it | `<title>Security Check - Indeed.com</title>`; three denylist markers, no `Just a moment` |
| `trap-openai-redirect-stub.txt` | 81 | platform.openai.com/docs/llms.txt | an 81-byte redirect body that only a size floor catches | 81 bytes |
| `arena-flight-slice.txt` | 42,000 | arena.ai/leaderboard | a real slice of the Next.js flight payload, in the **backslash-escaped** form the live page serves: `\\"publicName\\":\\"` matches and the bare `"publicName":"` matches ZERO times | 34 records, 29 distinct names, `cold_brew` maps to `muse-video` |
| `arena-pairs-2026-08-31.tsv` | n/a | arena.ai/leaderboard | the COMPLETE set of 57 distinct pairs where `publicName` differs from `displayName`, each hand classified. 39 reveals, 18 variants, so a raw count overstates reveals by about 1.5x | 57 data lines, 39 ending `reveal` |
| `github-pulls-transformers.json` | 108,659 | api.github.com/search/issues (transformers, model support in title) | **`merged_at` is present in the search payload itself**, on `items[].pull_request.merged_at`, so merged and abandoned are distinguishable with no second `/pulls/<n>` fetch | 18 items, 8 with a non-null `merged_at` |
| `trap-pytorch-tags.atom` | 28,345 | github.com/pytorch/pytorch/releases.atom | valid Atom, fresh timestamps, and zero actual releases | entries are CI tags |
| `volatile-anthropic-sitemap-a.xml` | 68,273 | www.anthropic.com/sitemap.xml | **the pair**: two live edge generations minutes apart, byte-unequal, with an identical `<loc>` set and 25 of 522 `lastmod` values oscillating between two stamps | `cmp` fails; the `<loc>` sets are equal |
| `volatile-anthropic-sitemap-b.xml` | 68,273 | www.anthropic.com/sitemap.xml | the other half of that pair | as above |
| `healthy-openai-status.atom` | 84,279 | status.openai.com/history.atom | 84 Atom entries, a feed-level `<updated>` that re-stamps per generation, and a component list repeated in `summary` and `content` | 84 `<entry>`, 592 `<li>` |
| `volatile-claude-status.atom` | 33,371 | status.claude.com/history.atom | 25 entries, and exactly one `<updated>` outside them: the feed-level line the `mask` predicate exists to remove | 26 `<updated>`, 25 of them inside an `<entry>` |

`volatile-anthropic-sitemap-a.xml` and `-b.xml` are captured four minutes apart
on 2026-08-31 and are the only fixture PAIR here whose property is a
difference. They exist because `sitemapDated` cannot be tested honestly against
one file: the rule it implements is "drop any `lastmod` shared by three or more
URLs at the same millisecond", and only a real pair shows that the 25 values
which oscillate are exactly the ones that share a stamp. If `cmp` ever reports
them identical they have been recaptured from one generation and prove nothing.

The four shared groups in that capture are 25, 22, 13 and 11 URLs, so 71 of the
522 rows lose their stamp under the rule and 451 keep it. Those counts are
asserted in `test/predicate.test.ts` and will move if the fixture is recaptured.

`trap-interstitial.html` is misnamed and the name is kept so the tests that
reference it stay findable. It is not a Cloudflare challenge page. It is the
newsletter's own homepage returned for a feed path, and the only Cloudflare
string it carries is `__CF$cv$params`, the challenge-platform BEACON, which
loads on ordinary proxied 200s wherever JS Detections or Bot Fight Mode is on.

That fact used to be recorded here as an unresolvable tradeoff, and it was
resolved on 2026-08-31 by measuring the other side. Three live captures:

| capture | HTTP | `__CF$cv$params` | `cf_chl_opt` | `/cdn-cgi/challenge-platform/h/` |
|---|---:|---:|---:|---:|
| `trap-cf-challenge-udemy.html` (real challenge) | 403 | 0 | 7 | 1 |
| `trap-cf-challenge-indeed.html` (real challenge) | 403 | 0 | 7 | 1 |
| `arena.ai/.../orchestrate/chl_page/v1` (real challenge, not kept) | **200** | 0 | 6 | 1 |
| `arena.ai/leaderboard` (ordinary page) | 200 | 1 | 0 | 0 |
| `crunchbase.com` (ordinary page) | 200 | 1 | 0 | 0 |
| `trap-interstitial.html` (ordinary page) | 200 | 1 | 0 | 0 |

The marker had the sign backwards: a real challenge does not carry it and
every ordinary Cloudflare-fronted page does. It is off the denylist, and
`arena-leaderboard` is archiving. The arena `chl_page` row is why the challenge
fixtures are presented at 200 in `test/health.test.ts` even though both were
captured at 403: a challenge really can arrive inside the 2xx window, where the
status line cannot catch it and only the denylist can.

`test/health.test.ts` sweeps every denylist marker against every stored capture
and against the ordinary pages above, and asserts both challenge fixtures are
still caught. A marker added without clearing both halves turns that file red.

`trap-interstitial.html` was **345,910 bytes from 2026-08-31, not the 348,670
it was captured at.** It arrived carrying a real AWS access key id twelve
times, in the `X-Amz-Credential` parameter of presigned S3 URLs the newsletter
published for its own audio files, and the key id and the signatures have been
redacted out of it. History was left alone: an access key id is the public half
of the pair, AWS puts it in the headers of every signed request by design, and
the grants expire 2026-09-02, so it was not worth rewriting a published history
over. The property this fixture proves is untouched by the redaction.

**No test asserts against that credential.** Asserting against a real one makes
it part of the test contract, and then the repository fights the next person
who tries to clean it up. `test/secrets.test.ts` proves the same thing about
the gate using a synthetic presigned URL built from the seeded generator: a
fake key id, a fake signature, the real URL shape.

Neither challenge fixture carries a credential. The `cH`, `md`, `mdrd` and
`__cf_chl_tk` blobs in them are single-use, IP-bound, minutes-long challenge
nonces that authorise nothing.

None of this is trusted to a paragraph. `test/secrets.test.ts` sweeps the
credential patterns over **every tracked file in the repository**, not just the
collector's captures, because a hand-committed fixture is third-party bytes
arriving by a route the write-time gate never sees. That sweep is how this one
got here, and it is now the thing that stops the next one.

`volatile-claude-status.atom` is a FROZEN copy of `raw/claude-status/`. The
mask tests must not read the live archive path: the collector rewrites it on
any run that sees a change, and a test anchored on a timestamp in it goes red
for a reason that has nothing to do with the code. That happened once, between
one collector run and the next, and is why this copy exists.
