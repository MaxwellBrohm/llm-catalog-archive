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
| `trap-interstitial.html` | 348,670 | theneurondaily.com/feed | a bot-challenge page served at 200 | contains a denylist marker |
| `trap-openai-redirect-stub.txt` | 81 | platform.openai.com/docs/llms.txt | an 81-byte redirect body that only a size floor catches | 81 bytes |
| `trap-pytorch-tags.atom` | 28,345 | github.com/pytorch/pytorch/releases.atom | valid Atom, fresh timestamps, and zero actual releases | entries are CI tags |
