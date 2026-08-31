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
| `trap-interstitial.html` | 348,670 | theneurondaily.com/feed | a 200 that is not the feed: it is the site homepage, and it carries `__CF$cv$params` and NONE of the other four denylist markers | `<title>The Neuron</title>`; exactly one denylist marker |
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
newsletter's own homepage returned for a feed path, and the only denylist
marker it carries is `__CF$cv$params`, which Cloudflare injects into ordinary
proxied 200s rather than into challenges. That is a measured fact with a
consequence: the live arena.ai leaderboard carries the same marker, so
`checkHealth` rejects 5.2 MB of real content, and dropping the marker from the
denylist would leave this fixture undetected. See `arena-leaderboard`'s notes
in `meta/sources.json`.

`volatile-claude-status.atom` is a FROZEN copy of `raw/claude-status/`. The
mask tests must not read the live archive path: the collector rewrites it on
any run that sees a change, and a test anchored on a timestamp in it goes red
for a reason that has nothing to do with the code. That happened once, between
one collector run and the next, and is why this copy exists.
