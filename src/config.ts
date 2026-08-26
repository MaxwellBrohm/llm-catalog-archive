import { z } from 'zod';

const Invariants = z.strictObject({
  minBytes: z.number().int().nonnegative(),
  requiredKeyPath: z.string().nullable(),
  minRecords: z.number().int().nonnegative().nullable(),
  canary: z.string().nullable(),
  sizeBand: z.tuple([z.number().positive(), z.number().positive()]),
});

const Freshness = z.strictObject({
  kind: z.enum(['feed', 'content', 'none']),
  maxQuietDays: z.number().int().positive().nullable(),
});

const Predicate = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('bytes') }),
  z.strictObject({ type: z.literal('mask'), patterns: z.array(z.string()).min(1) }),
  z.strictObject({ type: z.literal('extracted'), extractor: z.enum(['arena', 'xai', 'sitemapLoc']) }),
]);

const SourceSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  url: z.url(),
  tier: z.enum(['fast', 'daily']),
  /**
   * `pending` sources are validated and reported but never fetched.
   *
   * The three volatile sources start pending. Under a byte predicate each
   * would commit a full blob on every run, and at 5.2 MB, 1.46 MB and 617 KB
   * that is hundreds of megabytes of junk in a history R7 forbids rewriting.
   * They flip to `active` in the task that gives them a real predicate.
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
  maxRedirects: z.number().int().nonnegative(),
  rateLimit: z.strictObject({ maxAutoEventsPerDay: z.number().int().positive() }),
  magnitudeGuard: z.strictObject({ maxShrinkPct: z.number().min(0).max(100) }),
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
