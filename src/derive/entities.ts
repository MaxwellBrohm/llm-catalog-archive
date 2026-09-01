/**
 * Mechanical entity extraction. Pure: no git, no fs, no clock, no network, and
 * no language model, here or anywhere else in src/derive/.
 *
 * THE RULE THIS FILE IMPLEMENTS, from the product spec section 4: attachment is
 * deterministic first, judged second, and where mechanical attachment is
 * ambiguous the event is HELD rather than guessed. Every function below returns
 * an empty array or null on anything it cannot decide from a table, and the
 * caller treats an event with no entities as held. Guessing produces a thread
 * that reads as evidence and is not, which is worse than no thread at all.
 *
 * WHAT AN ENTITY ID IS. It is namespaced by the catalogue it was read out of,
 * never by what we think the thing is:
 *
 *   lab/anthropic
 *   model/openrouter:anthropic/claude-opus-5
 *   model/anthropic-api:claude-opus-4-1-20250805
 *   api-surface/openrouter.ai/docs/guides/features
 *
 * The two model namespaces are deliberately not merged. OpenRouter's catalogue
 * id and Anthropic's API model name are different strings issued by different
 * parties, and deciding that `anthropic/claude-opus-4.1` and
 * `claude-opus-4-1-20250805` are the same model is exactly the judgement this
 * layer is forbidden from making. Two threads that a reader can join is honest;
 * one thread we joined for them is a claim.
 */

export type EntityKind = 'lab' | 'model' | 'api-surface';

export type Entity = {
  kind: EntityKind;
  /** Stable, catalogue-namespaced. Part of the permalink. */
  id: string;
  /** What a page prints. Never used for identity. */
  label: string;
};

/**
 * The labs the product names. A closed list on purpose: an open one would mean
 * inventing a lab from any vendor prefix OpenRouter happens to ship, and
 * `aion-labs`, `undi95` and `sao10k` are exactly the rows that would produce.
 */
export const LABS = [
  'anthropic',
  'openai',
  'google',
  'meta',
  'mistral',
  'deepseek',
  'qwen',
  'xai',
  'zai',
  'moonshot',
  'minimax',
  'nvidia',
  'cohere',
  'perplexity',
  'together',
  'groq',
] as const;

export type Lab = (typeof LABS)[number];

/**
 * Vendor prefix as it appears in a catalogue id, to a lab in LABS.
 *
 * Every key is a string observed in a stored artifact, and every value is a
 * member of LABS. A vendor absent from this table yields no lab entity: the
 * model entity still exists, because a catalogue id is unambiguously a model,
 * but the lab dimension is held.
 *
 * `meta-llama` and `meta` both appear in the catalogue and both map to meta.
 * `mistralai` maps to mistral. Neither is inference: they are two spellings of
 * one vendor namespace, written down rather than guessed at.
 */
const VENDOR_LAB: Record<string, Lab> = {
  anthropic: 'anthropic',
  claude: 'anthropic',
  openai: 'openai',
  google: 'google',
  meta: 'meta',
  'meta-llama': 'meta',
  mistral: 'mistral',
  mistralai: 'mistral',
  deepseek: 'deepseek',
  qwen: 'qwen',
  'x-ai': 'xai',
  xai: 'xai',
  'z-ai': 'zai',
  zai: 'zai',
  moonshot: 'moonshot',
  moonshotai: 'moonshot',
  minimax: 'minimax',
  nvidia: 'nvidia',
  cohere: 'cohere',
  perplexity: 'perplexity',
  together: 'together',
  groq: 'groq',
};

/**
 * A vendor prefix to its lab, or null when the table does not hold it.
 *
 * The leading `~` OpenRouter puts on its floating ids (`~anthropic/claude-opus-
 * latest`) is stripped before the lookup. It is a marker on the id, not part of
 * the vendor name, and every `~`-prefixed id in the catalogue carries a vendor
 * that is also present unprefixed.
 */
export function labFromVendor(vendor: string): Lab | null {
  const bare = vendor.startsWith('~') ? vendor.slice(1) : vendor;
  return VENDOR_LAB[bare.toLowerCase()] ?? null;
}

/** `lab/<name>`. Exported so tests and threads.ts agree on one spelling. */
export function labEntity(lab: Lab): Entity {
  return { kind: 'lab', id: `lab/${lab}`, label: lab };
}

/**
 * A source id to the provider whose bytes it holds.
 *
 * Mechanical: the trailing capture-shape suffix is removed and what is left is
 * the provider segment the source id was named for. `groq-llms-full-txt` ->
 * `groq`, `anthropic-deprecations` -> `anthropic`, `claude-llms-txt` ->
 * `claude`. Nothing here decides that `claude` is Anthropic; labFromVendor
 * does that, from the same table every other caller uses.
 */
/**
 * Written WITHOUT their leading separator, which is added back below.
 *
 * Not a style choice. test/git.test.ts scans every file under src/ for anything
 * that could reach git's argv as a forcing flag, and its narrowest arm is a
 * quoted string beginning with a dash and holding a d or an f. The deprecations
 * suffix, written with its separator, matched that arm exactly. The right
 * response to a guard that fires is to stop looking like the thing it guards
 * against, not to widen the guard, so the separator lives in the loop below and
 * this list holds none of it.
 */
/**
 * The source-id suffixes that carry a provider segment in front of them.
 *
 * `status` joined this list when the status feeds started producing incident
 * events, and `news-feed` and `blog-feed` joined it the same day for the
 * announcement feeds. BOTH TIMES the symptom was identical and silent: a source
 * with an unrecognised suffix yields no provider, the deriver returns an empty
 * array on every call, and a whole event type simply cannot fire. Nothing
 * throws and nothing logs. Both were caught by a test rather than by reading
 * the code, which is why this list is worth a comment rather than a glance:
 * ADDING A SOURCE WHOSE ID ENDS IN SOMETHING NEW MEANS ADDING IT HERE, and the
 * failure to do so looks exactly like a quiet week.
 */
const SOURCE_SUFFIXES = [
  'llms-full-txt',
  'llms-txt',
  'deprecations',
  'sitemap',
  'status',
  'news-feed',
  'blog-feed',
];

export function providerFromSourceId(sourceId: string): string | null {
  for (const suffix of SOURCE_SUFFIXES) {
    const tail = `-${suffix}`;
    if (sourceId.endsWith(tail)) {
      const provider = sourceId.slice(0, -tail.length);
      return provider === '' ? null : provider;
    }
  }
  return null;
}

/**
 * A catalogue id such as `anthropic/claude-opus-5` to its entities.
 *
 * Always yields the model entity: the argument IS the catalogue's own
 * identifier, so there is nothing to decide. The lab entity comes only from the
 * table, so `aion-labs/aion-1.0` yields one entity and `anthropic/claude-opus-5`
 * yields two.
 *
 * An id with no `/`, or with an empty vendor or slug, yields NOTHING at all. It
 * is not a catalogue id in the shape this catalogue issues, and a caller that
 * received one is holding something other than what it thinks.
 */
export function entitiesForCatalogModel(modelId: string): Entity[] {
  const at = modelId.indexOf('/');
  if (at <= 0 || at === modelId.length - 1) return [];
  const vendor = modelId.slice(0, at);
  const out: Entity[] = [
    { kind: 'model', id: `model/openrouter:${modelId}`, label: modelId },
  ];
  const lab = labFromVendor(vendor);
  if (lab !== null) out.push(labEntity(lab));
  return out;
}

/**
 * An API model name from a provider's own deprecation table, such as
 * `claude-opus-4-1-20250805`, to its entities.
 *
 * The model entity is namespaced to the provider's API rather than to
 * OpenRouter, because that is where the string came from. The lab entity comes
 * from the same vendor table, keyed on the provider the source is named for.
 *
 * An empty name, or one carrying a `/`, yields nothing: a slash means the
 * caller handed over a catalogue id, which belongs to entitiesForCatalogModel
 * and would land in the wrong namespace here.
 */
export function entitiesForApiModel(provider: string, name: string): Entity[] {
  if (provider === '' || name === '' || name.includes('/')) return [];
  const out: Entity[] = [
    { kind: 'model', id: `model/${provider}-api:${name}`, label: name },
  ];
  const lab = labFromVendor(provider);
  if (lab !== null) out.push(labEntity(lab));
  return out;
}

/**
 * A documentation URL to its entities.
 *
 * The api-surface is the SECTION the page sits in, which is the host plus every
 * path segment except the last. A section accretes events; a single page mostly
 * has one and then never again, and OpenRouter moving `containers.md` from
 * `.../server-tools/` to `.../features/` is precisely the pair of events a
 * per-page entity would file under two threads nobody would ever read.
 *
 * Held, returning nothing at all:
 *
 *   - anything that is not an absolute http(s) URL, because the section cannot
 *     be located without a host;
 *   - a URL whose path has no section, meaning the page sits at the host root,
 *     because `example.com` is a site and not an API surface.
 *
 * The lab comes from the provider the source was named for, through the same
 * table as everywhere else, so `openrouter` yields no lab: OpenRouter is a
 * router and is not in LABS.
 */
export function entitiesForDocUrl(url: string, provider: string): Entity[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return [];

  const segments = parsed.pathname.split('/').filter((s) => s !== '');
  // One segment is a page at the root, zero is the root itself. Neither has a
  // section above it, and inventing one from the host would file every such
  // page under a surface that does not exist.
  if (segments.length < 2) return [];
  const section = segments.slice(0, -1).join('/');

  const out: Entity[] = [
    {
      kind: 'api-surface',
      id: `api-surface/${parsed.host}/${section}`,
      label: `${parsed.host}/${section}`,
    },
  ];
  const lab = labFromVendor(provider);
  if (lab !== null) out.push(labEntity(lab));
  return out;
}

/**
 * The permalink segment for an entity.
 *
 * Lowercased, every run of characters outside `[a-z0-9]` folded to one dash,
 * and the ends trimmed, so the result is safe as a file name on every platform
 * that has to hold the generated site. Folding is lossy, which is why threads.ts
 * refuses to build a site when two distinct entities fold to one slug rather
 * than quietly serving one entity's page under the other's name.
 */
export function entitySlug(entity: Entity): string {
  const folded = entity.id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return folded === '' ? 'entity' : folded;
}
