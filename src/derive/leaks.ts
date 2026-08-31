/**
 * The leaks desk. Pure: no git, no fs, no clock, no network, no language model.
 *
 * THIS FILE CARRIES THE PROJECT'S ONLY REAL LEGAL EXPOSURE, so the copy rule is
 * not style here and the module is arranged around it. Two sentences:
 *
 *   "A model named X appears in Y's leaderboard payload."   describes an
 *                                                           artifact we link.
 *   "X is Y's next flagship."                               attributes intent
 *                                                           to a company.
 *
 * They are different claims and they may NEVER be merged into one sentence.
 * leakSentence below returns only the first kind: an artifact is the subject of
 * every verb, a company appears only as a possessive modifier in front of an
 * artifact ("OpenRouter's catalog"), inside a repository name, or inside a
 * value quoted out of the archive. test/site-leaks.test.ts fails the build if
 * any rendered sentence puts a company in front of a verb.
 *
 * NOTHING HERE REHOSTS ANYTHING. A leak item carries the name it read, the
 * artifact path it read it from, and the commit sha that stored those bytes.
 * Weights and source are described and linked, never copied.
 *
 * THE SOURCING TIER IS ABOUT THE ARTIFACT, NOT ABOUT CONFIDENCE. Every item
 * this module derives is `confirmed-artifact`, because it was read out of bytes
 * committed to a public archive and its permalink resolves. `credible` and
 * `unconfirmed` exist for entries a human puts in the ledger, where there is a
 * named source or no artifact at all, and no code path here can produce them:
 * a machine reading a stored file cannot be the thing that vouches for a
 * source's track record.
 */

import { arenaRows } from '../predicate.js';
import type { ContentChange } from './events.js';
import type { Stamp } from '../site/record.js';

/** Spec section 6 of the product design. About the artifact, not confidence. */
export type SourcingTier = 'confirmed-artifact' | 'credible' | 'unconfirmed';

export type LeakType =
  /** A `publicName` that was not in the previous capture. */
  | 'codename_entered'
  /** A `publicName` whose `displayName` stopped matching it. */
  | 'codename_unmasked'
  /** A model-support pull request that was not in the previous capture. */
  | 'upstream_pr_opened'
  /** That pull request's `merged_at` going from absent to a date. */
  | 'upstream_pr_merged'
  /** A catalog id under the `stealth/` namespace that was not there before. */
  | 'stealth_listing'
  /** A catalog `expiration_date` going from absent to a date. */
  | 'expiration_scheduled';

export type LeakItem = {
  /** `<sha>:<type>:<subject>`. Unique within a commit by construction. */
  id: string;
  type: LeakType;
  tier: SourcingTier;
  sha: string;
  sourceId: string;
  /** The stored path, so the renderer can build the permalink at this sha. */
  path: string;
  stamp: Stamp | null;
  /** The name, id or number the claim is about. */
  subject: string;
  /** Rows a reader can check against the linked artifact. Never a conclusion. */
  facts: [string, string][];
};

// ---------------------------------------------------------------------------
// signal 1: the arena codename map
// ---------------------------------------------------------------------------

export const ARENA_SOURCE_ID = 'arena-leaderboard';

/**
 * Words that are a release channel rather than an identity.
 *
 * Load bearing, and measured. Without it `hunyuan-hy3-preview` ->
 * `hy4-preview` is classified a label variant because the two names share the
 * token `preview`, and it is a reveal: `preview` says which channel a build is
 * on and says nothing about which model it is. The complete observed variant
 * set was hand classified from a live capture and this is the ONLY row the stop
 * list moves, in the direction of publishing a reveal rather than suppressing
 * one.
 *
 * Every member is a suffix the spec's own variant enumeration already names as
 * a suffix ADDITION (`X` to `X-high`, `X` to `X (preview)`), which is a shape
 * that leaves the base name intact and therefore never needs the shared token
 * to be the channel word itself.
 */
export const CHANNEL_TOKENS = new Set([
  'high',
  'low',
  'medium',
  'xhigh',
  'preview',
  'max',
  'thinking',
  'beta',
  'alpha',
  'mini',
  'pro',
  'latest',
  'free',
  'instruct',
  'chat',
  'exp',
  'experimental',
  'rc',
]);

const tokensOf = (s: string): Set<string> =>
  new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== ''));

/**
 * A token that carries identity: at least two characters, containing a letter,
 * and not a release channel.
 *
 * THE LENGTH AND LETTER TESTS ARE BOTH LOAD BEARING AND BOTH WERE MEASURED.
 * `anonymous-0410` -> `openhard-1.0-search-non-reasoning-0410` is a real
 * reveal and the only token the two names share is `0410`, which is a date
 * stamp; without the letter test it is suppressed as a variant. A single
 * character is a version digit rather than a name, and `auto-bear-v2` ->
 * `qwen-image-2.0-pro-2026-06-22` shares nothing but bare digits.
 */
export function isIdentityToken(token: string): boolean {
  return token.length >= 2 && /[a-z]/.test(token) && !CHANNEL_TOKENS.has(token);
}

/**
 * Whether a (publicName, displayName) pair is a label variant rather than a
 * codename reveal.
 *
 * THE FILTER ENUMERATES THE VARIANT SHAPE, NOT THE REVEAL SHAPE, and that is
 * the whole design. A positive filter guessing at "a nonsense word or an animal
 * name" was tried and misses `anonymous-0410`, `k2`, `cold_brew`, `onyx-v1-4`,
 * `lo-bah-png`, `nonnas-meatballs-open-weight` and `may-alpha`, all of which
 * are real reveals in a live capture. A variant is enumerable and a reveal is
 * not, so the filter describes the thing that can be described.
 *
 * A pair is a variant iff the two names share an identity token. That covers
 * every observed variant shape: a suffix addition (`-high`, `-low`, `-xhigh`,
 * `-no-system-prompt`), a trailing `-YYYYMMDD`, and a ` (max)` or ` (preview)`
 * parenthetical, all of which leave the base name in place on both sides.
 *
 * Measured against the complete live set of 57 distinct differing pairs:
 * 39 reveals and 18 variants, so a raw count of differing rows overstates the
 * reveal count by about 1.5x. The earlier revision of the spec put the
 * overstatement at three to six times, which would have suppressed roughly
 * thirty real reveals per cycle.
 */
export function isLabelVariant(publicName: string, displayName: string): boolean {
  const shared = tokensOf(displayName);
  for (const token of tokensOf(publicName)) {
    if (shared.has(token) && isIdentityToken(token)) return true;
  }
  return false;
}

/** A reveal is any differing pair that is not a variant. */
export function isCodenameReveal(publicName: string, displayName: string): boolean {
  return displayName !== '' && publicName !== displayName && !isLabelVariant(publicName, displayName);
}

/**
 * The picker's `publicName` to `displayName` map out of one arena capture.
 *
 * `publicName` only, never `modelKey`. The predicate reads both spellings
 * because it is deciding whether ANY record moved; the codename map is a claim
 * about the model picker's own pair, and a leaderboard row keyed on `modelKey`
 * is a different artifact that would file a rating row under a reveal.
 *
 * Later records win over earlier ones with the same name, so a name that
 * appears twice reports the pair the payload ends with rather than a pair that
 * depends on which regex matched first.
 */
export function arenaCodenameMap(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of arenaRows(text, 'publicName')) {
    if (row.name !== '') out.set(row.name, row.display);
  }
  return out;
}

function arenaLeaks(change: ContentChange, before: string, after: string): LeakItem[] {
  const prev = arenaCodenameMap(before);
  const next = arenaCodenameMap(after);
  const out: LeakItem[] = [];

  for (const [name, display] of next) {
    const was = prev.get(name);

    // A NEW publicName. The claim is that a name is present in the payload,
    // which is all the diff supports: a model can be added to the picker long
    // after it started serving traffic, and "entered testing" would be a claim
    // about arena's process rather than about its payload.
    if (was === undefined) {
      out.push({
        id: `${change.sha}:codename_entered:${name}`,
        type: 'codename_entered',
        tier: 'confirmed-artifact',
        sha: change.sha,
        sourceId: change.sourceId,
        path: change.path,
        stamp: change.stamp,
        subject: name,
        facts: [
          ['publicName', name],
          ['displayName', display === '' ? 'absent' : display],
          [
            'classification',
            isCodenameReveal(name, display)
              ? 'reveal: the two names share no identity token'
              : display === ''
                ? 'no displayName recorded beside it'
                : 'label variant: the two names share an identity token',
          ],
        ],
      });
      // A name present for the first time has no previous displayName to have
      // stopped matching, so the unmask below cannot fire for it.
      continue;
    }

    // AN UNMASK. Not "a displayName appeared": the payload sets displayName to
    // the codename itself while a model is anonymous, so the transition that
    // carries the reveal is the two names ceasing to agree, and requiring the
    // previous value to be absent would miss every one of them.
    if (was !== display && isCodenameReveal(name, display)) {
      out.push({
        id: `${change.sha}:codename_unmasked:${name}`,
        type: 'codename_unmasked',
        tier: 'confirmed-artifact',
        sha: change.sha,
        sourceId: change.sourceId,
        path: change.path,
        stamp: change.stamp,
        subject: name,
        facts: [
          ['publicName', name],
          ['displayName before', was === '' ? 'absent' : was],
          ['displayName after', display],
        ],
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// signal 2: upstream inference-runtime pull requests
// ---------------------------------------------------------------------------

export const PULL_SOURCE_IDS = ['transformers-pulls', 'vllm-pulls'] as const;

/** The repository a pull-request source is a search over. */
const PULL_REPOS: Record<string, string> = {
  'transformers-pulls': 'huggingface/transformers',
  'vllm-pulls': 'vllm-project/vllm',
};

export type PullRow = {
  number: number;
  title: string;
  state: string;
  mergedAt: string | null;
  htmlUrl: string | null;
  createdAt: string | null;
};

/**
 * The stored search payload to rows. Returns an empty array on anything that is
 * not a `{ items: [...] }` document.
 *
 * Empty rather than a throw, unlike parseCatalog. The distinction is which
 * failure is silent: the catalog is ONE source whose absence would stop every
 * catalog event, so a shrug there hides a broken archive. Here the desk lists
 * per-repository counts on its own page, so a repository that silently drops to
 * zero rows is visible on the page rather than only in a stack trace.
 */
export function parsePullSearch(text: string): PullRow[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const items = (json as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];

  const out: PullRow[] = [];
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue;
    const it = raw as Record<string, unknown>;
    const number = it['number'];
    const title = it['title'];
    if (typeof number !== 'number' || typeof title !== 'string') continue;
    const pr = (typeof it['pull_request'] === 'object' && it['pull_request'] !== null
      ? it['pull_request']
      : {}) as Record<string, unknown>;
    out.push({
      number,
      title,
      state: typeof it['state'] === 'string' ? it['state'] : '',
      mergedAt: typeof pr['merged_at'] === 'string' ? pr['merged_at'] : null,
      htmlUrl: typeof it['html_url'] === 'string' ? it['html_url'] : null,
      createdAt: typeof it['created_at'] === 'string' ? it['created_at'] : null,
    });
  }
  return out;
}

/**
 * The pieces of `Add <Capitalized> model support`, written separately because
 * the two accepted shapes need different evidence that a title is about a
 * model at all.
 *
 * FILTERING ON "Add" ALONE IS THE MISTAKE THIS EXISTS TO AVOID. Signal to noise
 * in the collected window is roughly two genuine architecture additions in
 * twelve model-naming pull requests, and filtering on the bare verb makes it
 * far worse: `Add tiny_model_id support to ProcessorTesterMixin`,
 * `Support key_mapping with PEFT models` and `Add SDPA support for PatchTST
 * model` are all plumbing and all match "Add".
 *
 * THE CAPITAL IS WHAT DOES THE WORK. An architecture name is a proper noun in
 * both repositories' conventions (`Ovis2.5`, `PP-OCRv6`, `Cosmos3 Edge`,
 * `Param2MoE`, `Kimi K3`) and plumbing is not. The name may run over several
 * capitalised words, and the negative lookahead stops it before `Model` and
 * `Models` so `Add PP-OCRv6 Models Support` names `PP-OCRv6` rather than
 * `PP-OCRv6 Models`.
 */
const NAME = String.raw`([A-Z][^\s]*(?:\s+(?!Models?\b)[A-Z0-9][^\s]*)*)`;

/** Leading `[Model]`, `[New Model][Multimodal]`, `[ROCm][Model]` and friends. */
const LEADING_TAGS = /^\s*(?:\[[^\]]*\]\s*)*/;

/** A conventional-commit prefix, which both repositories use occasionally. */
const COMMIT_PREFIX = /^(?:feat|fix|perf|refactor|chore)\s*:\s*/i;

/**
 * A maintainer-applied tag saying the pull request is about a model.
 *
 * This is the repositories' OWN classification and it is better evidence than
 * anything a title regex can recover, which is why a title carrying it is held
 * to a weaker shape below.
 */
const MODEL_TAG = /\[(?:new\s+)?model\b[^\]]*\]/i;

/**
 * `Add <Name> model support`, where the word model sits next to the name.
 *
 * The optional lowercase run before `model` is what admits
 * `Add support for Quatfit1 multimodal models`, and it is also what keeps
 * `Add GGUF support for MiniMax-M2.1 model` OUT: there the lowercase run stops
 * at the capitalised `MiniMax-M2.1`, so `model` never lands where the pattern
 * needs it and the title is correctly read as being about GGUF plumbing rather
 * than about an architecture.
 */
const WITH_MODEL_WORD = new RegExp(
  `^(?:Add|Support)\\s+(?:support\\s+for\\s+)?(?:native\\s+)?${NAME}(?:\\s+[a-z][^\\s]*)*\\s+[Mm]odels?\\b`,
);

/**
 * `Add <Name> support`, accepted ONLY when a maintainer tagged the title as a
 * model change.
 *
 * Without the tag requirement this shape matches `Add GGUF support`,
 * `Add SDPA support` and `Add Flash Attention support`, none of which names an
 * architecture. With it, `[Model] Add Kimi K3 support: Rust frontend [1/2]` is
 * recovered, and that is a real one the model-word shape cannot see.
 */
const TAGGED_SUPPORT = new RegExp(`^(?:Add|Support)\\s+(?:support\\s+for\\s+)?(?:native\\s+)?${NAME}\\s+[Ss]upport\\b`);

/**
 * The architecture name a title names, or null when the title does not have the
 * `Add <Capitalized> model support` shape at all.
 *
 * The name is returned rather than a boolean because the confirmation step the
 * desk documents is a query for that exact string, and a boolean would make the
 * page say "check the name" without saying which name.
 *
 * WHAT THIS DELIBERATELY MISSES, stated rather than implied, because a filter
 * read as complete when it is not is worse than a loose one. A lowercase
 * architecture name is invisible to it: `Add dots3-note Preview model support`
 * and `Support solar-open2 model` are both real and both missed, because the
 * capital is the only thing separating a name from a verb and giving it up
 * readmits every plumbing title at once. So is a name joined by a conjunction,
 * as in `Add Granite-swa and Granitemoe-swa model support`. The desk publishes
 * a floor on the signal, never a census of it.
 */
export function modelSupportName(title: string): string | null {
  const tagged = MODEL_TAG.test(LEADING_TAGS.exec(title)?.[0] ?? '');
  const body = title.replace(LEADING_TAGS, '').replace(COMMIT_PREFIX, '').trim();

  const withWord = WITH_MODEL_WORD.exec(body);
  if (withWord?.[1] !== undefined && withWord[1] !== '') return withWord[1];
  if (!tagged) return null;
  const bare = TAGGED_SUPPORT.exec(body);
  return bare?.[1] === undefined || bare[1] === '' ? null : bare[1];
}

/**
 * `repo` is a PARAMETER rather than a lookup here, and the lookup lives in the
 * dispatcher.
 *
 * It used to be looked up here behind an `if (repo === undefined) return []`
 * guard, and mutation testing found that guard SURVIVING replacement with
 * `false`: the dispatcher already gates on `change.sourceId in PULL_REPOS`, so
 * nothing could ever reach it with an unknown source. Dead code that looks like
 * a guard is worse than no guard, because it is the line a reader trusts.
 */
function pullLeaks(change: ContentChange, repo: string, before: string, after: string): LeakItem[] {
  const prev = new Map(parsePullSearch(before).map((r) => [r.number, r]));
  const out: LeakItem[] = [];

  for (const row of parsePullSearch(after)) {
    const name = modelSupportName(row.title);
    if (name === null) continue;
    const was = prev.get(row.number);

    const common = {
      tier: 'confirmed-artifact' as const,
      sha: change.sha,
      sourceId: change.sourceId,
      path: change.path,
      stamp: change.stamp,
      subject: `${repo}#${row.number}`,
    };
    const shared: [string, string][] = [
      ['repository', repo],
      ['pull request', String(row.number)],
      ['title', row.title],
      ['architecture named in the title', name],
      ['pull request URL', row.htmlUrl ?? 'not recorded'],
    ];

    if (was === undefined) {
      out.push({
        ...common,
        id: `${change.sha}:upstream_pr_opened:${repo}#${row.number}`,
        type: 'upstream_pr_opened',
        facts: [...shared, ['created_at', row.createdAt ?? 'not recorded'], ['state', row.state]],
      });
      // The row is new to the archive, so there is no previous merged_at for
      // the transition below to be a transition FROM.
      continue;
    }

    // `state` does not distinguish merged from abandoned and the payload does:
    // `items[].pull_request.merged_at` is present in the search response
    // itself, so no second /pulls/<n> fetch is needed and none is made.
    if (was.mergedAt === null && row.mergedAt !== null) {
      out.push({
        ...common,
        id: `${change.sha}:upstream_pr_merged:${repo}#${row.number}`,
        type: 'upstream_pr_merged',
        facts: [...shared, ['merged_at', row.mergedAt]],
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// signal 3: OpenRouter stealth/ and expiration_date
// ---------------------------------------------------------------------------

export const CATALOG_SOURCE_ID = 'openrouter-models';

/** The anonymous alpha namespace, as a prefix on a catalog id. */
export const STEALTH_PREFIX = 'stealth/';

/**
 * A vendor that uses `stealth/` to mean something other than an anonymous alpha.
 *
 * The `kilo` provider prefixes discounted listings with `stealth/`, so a bare
 * prefix test files a price promotion as an unreleased model. Enumerated rather
 * than guessed at, and empty of that vendor's rows the archive holds today, so
 * the guard is a written-down observation waiting for its case rather than a
 * measured suppression.
 */
export const STEALTH_FALSE_POSITIVE_VENDORS = ['kilo'] as const;

/**
 * A far-future `expiration_date` is a sentinel, not a retirement.
 *
 * Measured in the stored catalog on 2026-08-31: six models carry a non-null
 * `expiration_date` and four of them are `2098-12-31`, all under the `z-ai`
 * vendor. The field is documented as forward looking and the point of the
 * signal is knowing a model is about to vanish before it does, so a date 72
 * years out is the vendor spelling "no expiry" in a date column. Publishing it
 * as a scheduled removal would be a false alarm with an honest artifact link
 * attached, which is the worst kind.
 *
 * A year rather than a horizon in days, because the comparison must not read a
 * clock: this module is pure and a horizon would make the same archive derive
 * differently tomorrow.
 */
export const EXPIRATION_SENTINEL_YEAR = 2090;

export function isExpirationSentinel(date: string): boolean {
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) && year >= EXPIRATION_SENTINEL_YEAR;
}

type CatalogLeakEntry = { id: string; expirationDate: string | null; name: string | null };

/**
 * The two catalog fields the leaks desk reads, keyed by id.
 *
 * Deliberately its own reader rather than a call into parseCatalog. That one
 * THROWS on a body without `data`, which is right for the changelog because a
 * catalog that stopped parsing has to be loud, and wrong here: the desk would
 * take the whole site build down over a signal that has a per-source count on
 * its own page.
 */
export function parseCatalogLeaks(text: string): CatalogLeakEntry[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];

  const out: CatalogLeakEntry[] = [];
  for (const raw of data) {
    if (typeof raw !== 'object' || raw === null) continue;
    const m = raw as Record<string, unknown>;
    const id = m['id'];
    if (typeof id !== 'string' || id === '') continue;
    out.push({
      id,
      expirationDate: typeof m['expiration_date'] === 'string' ? m['expiration_date'] : null,
      name: typeof m['name'] === 'string' ? m['name'] : null,
    });
  }
  return out;
}

/** True when this id is under `stealth/` and is not the kilo naming collision. */
export function isStealthListing(id: string, name: string | null): boolean {
  if (!id.startsWith(STEALTH_PREFIX)) return false;
  const haystack = `${id} ${name ?? ''}`.toLowerCase();
  return !STEALTH_FALSE_POSITIVE_VENDORS.some((v) => haystack.includes(v));
}

function catalogLeaks(change: ContentChange, before: string, after: string): LeakItem[] {
  const prev = new Map(parseCatalogLeaks(before).map((e) => [e.id, e]));
  const out: LeakItem[] = [];

  for (const entry of parseCatalogLeaks(after)) {
    const was = prev.get(entry.id);
    const common = {
      tier: 'confirmed-artifact' as const,
      sha: change.sha,
      sourceId: change.sourceId,
      path: change.path,
      stamp: change.stamp,
      subject: entry.id,
    };

    if (was === undefined && isStealthListing(entry.id, entry.name)) {
      out.push({
        ...common,
        id: `${change.sha}:stealth_listing:${entry.id}`,
        type: 'stealth_listing',
        facts: [
          ['catalog id', entry.id],
          ['catalog name', entry.name ?? 'absent'],
          ['expiration_date', entry.expirationDate ?? 'absent'],
        ],
      });
    }

    // The transition INTO a date, which is the forward-looking half. A date
    // that was already set and merely moved is a different claim.
    if (
      was !== undefined &&
      was.expirationDate === null &&
      entry.expirationDate !== null &&
      !isExpirationSentinel(entry.expirationDate)
    ) {
      out.push({
        ...common,
        id: `${change.sha}:expiration_scheduled:${entry.id}`,
        type: 'expiration_scheduled',
        facts: [
          ['catalog id', entry.id],
          ['expiration_date', entry.expirationDate],
          [
            'sentinel check',
            `a year at or past ${EXPIRATION_SENTINEL_YEAR} is read as the vendor spelling "no expiry" and is not listed here`,
          ],
        ],
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// the dispatcher
// ---------------------------------------------------------------------------

/**
 * Every leak item one artifact change supports.
 *
 * A BASELINE CAPTURE YIELDS NOTHING, for the same reason src/derive/events.ts
 * refuses one: with no before, the only thing the diff supports is "these bytes
 * are now stored", and reporting 1,029 codenames as having entered testing on
 * the day the archive first fetched the page would be 1,029 false claims with
 * honest artifact links attached.
 */
export function leaksFromChange(change: ContentChange): LeakItem[] {
  if (change.kind === 'added') return [];
  const before = change.before;
  if (before === null) return [];

  if (change.sourceId === ARENA_SOURCE_ID) return arenaLeaks(change, before, change.after);
  if (change.sourceId === CATALOG_SOURCE_ID) return catalogLeaks(change, before, change.after);
  const repo = PULL_REPOS[change.sourceId];
  if (repo !== undefined) return pullLeaks(change, repo, before, change.after);
  return [];
}

/** Every leak item the archive supports, newest first by the stamp shown. */
export function deriveLeaks(changes: ContentChange[]): LeakItem[] {
  const key = (item: LeakItem): number => {
    if (item.stamp === null) return -Infinity;
    const ms = Date.parse(item.stamp.iso);
    return Number.isNaN(ms) ? -Infinity : ms;
  };
  return changes.flatMap(leaksFromChange).sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    // Equality first, so two unstamped items do not reach -Infinity minus
    // -Infinity, which is NaN and leaves the order engine-defined.
    if (ka !== kb) return kb - ka;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// the claim forms
// ---------------------------------------------------------------------------

const quote = (s: string): string => `"${s}"`;

/**
 * The sentence a leak item renders as.
 *
 * EVERY SUBJECT IS AN ARTIFACT. Read them against the forbidden forms:
 *
 *   allowed    "A model named cold_brew appears in arena.ai's leaderboard payload."
 *   forbidden  "cold_brew is Moonshot's next flagship."
 *   allowed    "A pull request in huggingface/transformers is titled ..."
 *   forbidden  "Hugging Face is preparing support for ..."
 *   allowed    "OpenRouter's catalog lists an id under the stealth/ namespace."
 *   forbidden  "OpenRouter is testing an unreleased model."
 *
 * A company name never precedes a verb. It appears as a possessive modifier in
 * front of the artifact, inside a repository path, or inside a value quoted out
 * of the archive, and nowhere else. No sentence here says what a model is, what
 * it will be called at launch, who made it, or when it ships, because the diff
 * supports none of those and the artifact link would be evidence for a claim it
 * does not make.
 */
export function leakSentence(item: LeakItem): string {
  switch (item.type) {
    case 'codename_entered':
      return `A model named ${quote(item.subject)} appears in arena.ai's leaderboard payload.`;
    case 'codename_unmasked':
      return `The displayName recorded beside the publicName ${quote(item.subject)} in arena.ai's leaderboard payload changed, and the two names no longer share an identity token.`;
    case 'upstream_pr_opened':
      return `A pull request numbered ${item.subject} is titled ${quote(factOf(item, 'title'))} in the collected search payload.`;
    case 'upstream_pr_merged':
      return `The pull request numbered ${item.subject} records a merged_at of ${factOf(item, 'merged_at')} in the collected search payload.`;
    case 'stealth_listing':
      return `OpenRouter's catalog lists an id under the ${STEALTH_PREFIX} namespace: ${item.subject}.`;
    case 'expiration_scheduled':
      return `OpenRouter's catalog recorded an expiration_date of ${factOf(item, 'expiration_date')} for ${item.subject}.`;
  }
}

/** One fact by label, or a marker naming the label that was missing. */
function factOf(item: LeakItem, label: string): string {
  return item.facts.find(([k]) => k === label)?.[1] ?? `<${label} not recorded>`;
}

/**
 * The confirmation step for an upstream pull request, as an instruction and
 * never as a conclusion.
 *
 * `huggingface.co/api/models?search=<name>` returning `[]` is evidence about a
 * WEIGHTS REPOSITORY and the pull request is evidence about a RUNTIME. Merging
 * them into one sentence produces "no weights exist for X yet", which is a
 * claim about what a lab has and has not published and which one private
 * repository falsifies. So the desk prints the query and lets a reader run it.
 */
export function confirmationQuery(name: string): string {
  return `https://huggingface.co/api/models?search=${encodeURIComponent(name)}`;
}
