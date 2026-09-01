import { z } from 'zod';

const Invariants = z.strictObject({
  minBytes: z.number().int().nonnegative(),
  requiredKeyPath: z.string().nullable(),
  minRecords: z.number().int().nonnegative().nullable(),
  canary: z.string().nullable(),
  /**
   * Bounded, not merely ordered. `lo < hi` alone accepts [0.01, 100.0], which
   * admits the 350 KB SPA shell and the 81-byte redirect stub that the band
   * exists to reject. A lower bound above 1 or an upper bound below 1 would
   * exclude the last accepted size itself, so the ratios straddle 1 by
   * construction.
   */
  sizeBand: z.tuple([z.number().gt(0).lte(1), z.number().gte(1).lte(10)]),
});

const Freshness = z.strictObject({
  kind: z.enum(['feed', 'content', 'none']),
  maxQuietDays: z.number().int().positive().nullable(),
});

const Predicate = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('bytes') }),
  z.strictObject({ type: z.literal('mask'), patterns: z.array(z.string()).min(1) }),
  z.strictObject({
    type: z.literal('extracted'),
    /**
     * Six, not the three this enum shipped with. `sitemapDated` and
     * `atomStatus` were added by the launch-day double dry run, which found
     * `anthropic-sitemap` re-stamping 24 of its `lastmod` values per request
     * and `openai-status` permuting the component list inside every entry.
     * Neither was visible to the source-health sweep, because that compared
     * fetches taken minutes apart in one session and both depend on which
     * edge cache answers.
     *
     * `githubPulls` is the leaks desk's, and it is here for the same reason
     * the other five are: GitHub's search payload re-scores every item per
     * query and advances `updated_at` on any comment, so a byte predicate on
     * two 650 KB payloads commits half a megabyte a day of nothing.
     */
    extractor: z.enum(['arena', 'xai', 'sitemapLoc', 'sitemapDated', 'atomStatus', 'feedPosts', 'githubPulls']),
  }),
]);

const SourceSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  // Protocol bound, because a bare z.url() accepts javascript:alert(1) and
  // ftp://x. All 16 sources are https and a collector has no business
  // dereferencing anything else.
  url: z.url({ protocol: /^https$/ }),
  tier: z.enum(['fast', 'daily']),
  /**
   * `pending` sources are validated and reported but never fetched.
   *
   * The five volatile sources started pending. Under a byte predicate each
   * would commit a full blob on every run, and at 5.2 MB, 1.46 MB and 617 KB
   * that is hundreds of megabytes of junk in a history R7 forbids rewriting.
   * Four flipped to `active` once they had a real predicate and a double dry
   * run in which the second consecutive run committed nothing.
   *
   * `arena-leaderboard` is still pending, and its extractor is not the reason.
   * It is blocked at the health check: the live page carries Cloudflare's
   * `__CF$cv$params` beacon, which is on the shared interstitial denylist, and
   * `test/fixtures/trap-interstitial.html` carries that marker and no other,
   * so the denylist cannot simply drop it. See that source's notes.
   */
  status: z.enum(['active', 'pending']),
  path: z.string(),
  contentType: z.enum(['json', 'xml', 'text', 'html']),
  expectedRoot: z.string().nullable(),
  invariants: Invariants,
  freshness: Freshness,
  predicate: Predicate,
  timeoutS: z.number().int().positive(),
  retries: z.number().int().nonnegative(),
  // At least 1. Zero disables the relocation detection that spec health rule 4
  // depends on: five relocations were already found by following redirects and
  // comparing the effective URL.
  maxRedirects: z.number().int().min(1),
  rateLimit: z.strictObject({ maxAutoEventsPerDay: z.number().int().positive() }),
  // Capped at 90, because 100 is a guard that can never fire, spelled to look
  // like a configured one.
  magnitudeGuard: z.strictObject({ maxShrinkPct: z.number().min(0).max(90) }),
  notes: z.string(),
});

const FileSchema = z.strictObject({
  version: z.literal(1),
  userAgent: z.string().min(1),
  contact: z.string().min(1),
  sources: z.array(SourceSchema).min(1),
});

export type Source = z.infer<typeof SourceSchema>;
export type SourcesFile = z.infer<typeof FileSchema>;

/**
 * The loader is strict on purpose. An unknown key is a typo that would
 * otherwise be silently ignored, and a silently ignored predicate override is
 * how a source reverts to committing every run without anyone noticing.
 */
export function loadSources(json: unknown): SourcesFile {
  const f = FileSchema.parse(json);

  const seen = new Set<string>();
  for (const s of f.sources) {
    if (seen.has(s.id)) throw new Error(`duplicate source id: ${s.id}`);
    seen.add(s.id);

    // The trailing slash is load bearing: without it `raw/<id>-old/` passes
    // and two sources share one directory.
    if (!s.path.startsWith(`raw/${s.id}/`)) {
      throw new Error(`source ${s.id}: path must live under raw/${s.id}/, got ${s.path}`);
    }
    // "parses as its declared type" is vacuous for text, so a canary stands in.
    if (s.contentType === 'text' && !s.invariants.canary) {
      throw new Error(`source ${s.id}: text sources require invariants.canary`);
    }
    const [lo, hi] = s.invariants.sizeBand;
    if (lo >= hi) throw new Error(`source ${s.id}: sizeBand must be [lo, hi] with lo < hi`);
  }
  return f;
}

export function sourcesForTier(f: SourcesFile, tier: 'fast' | 'daily'): Source[] {
  return f.sources.filter((s) => s.tier === tier);
}

/** What the collector should actually fetch right now. */
export function activeSourcesForTier(f: SourcesFile, tier: 'fast' | 'daily'): Source[] {
  return sourcesForTier(f, tier).filter((s) => s.status === 'active');
}
