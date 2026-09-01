/**
 * A change to a stored artifact, to typed events. Pure: no git, no fs, no
 * clock, no network, no language model.
 *
 * TWO RULES DECIDE EVERY LINE IN THIS FILE.
 *
 * 1. Only what the diff supports. Each event is computed from a BEFORE and an
 *    AFTER of the same path, so every field on it is a value read out of one of
 *    the two captures. Nothing is inferred, summarised or explained.
 *
 * 2. A BASELINE CAPTURE EMITS NOTHING. When a path is added to the archive for
 *    the first time there is no before, so the only thing the diff supports is
 *    "these bytes are now stored", not "these 416 models were added to the
 *    catalogue today" and not "these 800 documentation pages were published
 *    today". Spec section 10.1's precision rule says the same thing in the
 *    schema: first-seen error on a baseline is unbounded, and a renderer may
 *    show a date only when precision_seconds is at or below the resolution it
 *    renders at, so a baseline event could never legally render its own date.
 *
 * THE CLAIM FORM, spec section 10.1. Every sentence claimSentence returns names
 * an artifact as its subject, never a company and never a reason. OpenRouter's
 * `context_length` is the maximum across the providers currently routing a
 * model, so it moves when a provider joins or leaves the pool with nothing
 * happening at the lab: 39 of 416 models in the capture stored today carry a
 * `top_provider.context_length` that disagrees with it. That is why every
 * context_changed event carries BOTH numbers on BOTH sides. A reader can see
 * the routing explanation without us asserting one.
 */

import {
  entitiesForApiModel,
  entitiesForCatalogModel,
  entitiesForDocUrl,
  providerFromSourceId,
  type Entity,
} from './entities.js';
import { numberOrAbsent, quotedOrAbsent, quoteValue } from './quoting.js';
import {
  ANNOUNCEMENT_PATHS,
  announcementUrls,
  incidentEntries,
  isAnnouncementSource,
  isIncidentSource,
} from './announcements.js';
import type { Stamp } from '../site/record.js';

/** The collection tiers, as `meta/sources.json` spells them. */
export type Tier = 'fast' | 'daily';

/**
 * One artifact's before and after at one commit. The whole input to this
 * module, and the reason none of it needs git: `before` and `after` are the
 * stored bytes, and everything else is read off the sidecar committed with
 * them.
 */
export type ContentChange = {
  sourceId: string;
  path: string;
  /** The full 40 character sha of the commit that changed this artifact. */
  sha: string;
  tier: Tier;
  /** 'added' is the baseline capture, which by rule 2 above emits nothing. */
  kind: 'added' | 'modified';
  /** The bytes stored before this commit. Null exactly on a baseline. */
  before: string | null;
  /** The bytes this commit stored. */
  after: string;
  /** The sidecar stamp committed beside `after`. */
  stamp: Stamp | null;
  /** The sidecar stamp committed beside `before`. Null on a baseline. */
  previousStamp: Stamp | null;
  /**
   * The sidecar's `observed_at` beside `after`: the runner's wall clock at
   * request completion.
   *
   * Separate from `stamp` because the two answer different questions. `stamp`
   * prefers `origin_date`, which is when the PROVIDER generated the bytes, and
   * that is the right thing to print. Cadence is about when WE looked, and
   * `stale-while-revalidate` lets an edge serve bytes up to ~65 minutes past
   * freshness, so an origin-to-origin interval is not an observation interval.
   */
  observedAt: string | null;
};

export type EventType =
  | 'model_added'
  | 'model_removed'
  | 'price_changed'
  | 'context_changed'
  | 'expiration_set'
  | 'alias_retargeted'
  | 'doc_added'
  | 'doc_moved'
  | 'doc_removed'
  | 'post_listed'
  | 'incident_opened'
  | 'retirement_floor';

type Common = {
  /** `<sha>:<type>:<subject>`. Unique within a commit by construction. */
  id: string;
  sha: string;
  sourceId: string;
  /** The stored path, so the renderer can build the permalink at this sha. */
  path: string;
  stamp: Stamp | null;
  entities: Entity[];
  /**
   * True when entity extraction produced nothing. A held event is real and is
   * listed; it just attaches to no thread, because attaching it would mean
   * guessing which thread it belongs to.
   */
  held: boolean;
};

export type DerivedEvent = Common &
  (
    | {
        type: 'model_added';
        modelId: string;
        /** The catalogue's own `created`, in seconds. Not a launch date. */
        created: number | null;
        /** Worst-case first-seen error in seconds. Spec section 10.1. */
        precisionSeconds: number;
      }
    | { type: 'model_removed'; modelId: string; lastSeen: Stamp | null }
    | {
        type: 'price_changed';
        modelId: string;
        field: string;
        from: string | null;
        to: string | null;
      }
    | {
        type: 'context_changed';
        modelId: string;
        from: number | null;
        to: number | null;
        /** `top_provider.context_length` on the same two sides. Never optional. */
        topProviderFrom: number | null;
        topProviderTo: number | null;
      }
    | { type: 'expiration_set'; modelId: string; date: string }
    | { type: 'alias_retargeted'; alias: string; from: string; to: string }
    | { type: 'doc_added'; provider: string; title: string; url: string }
    | { type: 'doc_moved'; provider: string; title: string; url: string; fromUrl: string }
    | { type: 'doc_removed'; provider: string; title: string; url: string }
    | { type: 'post_listed'; provider: string; url: string }
    | { type: 'incident_opened'; provider: string; title: string; url: string; published: string | null }
    | {
        type: 'retirement_floor';
        provider: string;
        model: string;
        /** The cell parsed to YYYY-MM-DD, or null when it holds no date. */
        floorDate: string | null;
        /** The cell verbatim, which is the evidence the date came from. */
        floorText: string;
      }
  );

/** Seconds in a UTC day, for the precision comparison below. */
export const DAY_SECONDS = 86400;

/**
 * THE CONFIGURED POLL INTERVAL. A FLOOR ON THE ERROR, NOT AN ANSWER.
 *
 * There used to be a `CRON_ALLOWANCE_SECONDS = 3600` here, guessing how late a
 * scheduled run may start, and it was wrong by a factor of nearly eight.
 * Measured from the live repository's own workflow history, `collect-fast.yml`
 * asks for a run every 15 minutes and its actual gaps between scheduled runs
 * were
 * **116 minutes minimum, 363 median, 468 maximum** across the first five. GitHub
 * deprioritises `schedule` events heavily, and a quarter-hourly cron is among
 * the most throttled of all. So the old formula published 4,500 seconds against a measured
 * worst case of 28,080, in the direction that overstates confidence, which is
 * exactly the claim this project refuses to make about anybody else's data.
 *
 * A bigger constant would only be a re-guess. The archive already knows how
 * often each source was actually captured, so precisionSecondsFrom derives the
 * number from that evidence and this stays as the floor beneath it: no source
 * is credited with resolution finer than its own configured interval, however
 * lucky a run of captures looks.
 */
const TIER_INTERVAL_SECONDS: Record<Tier, number> = { fast: 900, daily: 86400 };

export function precisionFloorFor(tier: Tier): number {
  return TIER_INTERVAL_SECONDS[tier];
}

/**
 * The largest interval between consecutive observations, in seconds, or null
 * when there are fewer than two usable ones.
 *
 * Null rather than zero, and the caller turns it into an unbounded error. One
 * observation bounds nothing: a model could have entered the catalogue at any
 * point before it.
 *
 * Unparseable instants are dropped rather than treated as zero. Dropping one
 * MERGES the two gaps either side of it into a larger one, so the error can
 * only widen, which is the direction a missing measurement is allowed to move
 * a claim.
 */
export function maxGapSeconds(instants: string[]): number | null {
  const ms = instants.map((i) => Date.parse(i)).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  if (ms.length < 2) return null;
  let widest = 0;
  for (let i = 1; i < ms.length; i++) {
    const gap = (ms[i] ?? 0) - (ms[i - 1] ?? 0);
    if (gap > widest) widest = gap;
  }
  return Math.round(widest / 1000);
}

/**
 * Worst-case error on "first seen in the catalogue at", MEASURED.
 *
 * The largest observed gap between consecutive accepted captures of a source,
 * floored at that source's configured tier interval. Self-correcting: if the
 * platform throttles harder next month the claim widens on its own, with no
 * constant to edit and nobody to remember to edit it.
 *
 * Infinity when the archive holds fewer than two captures of the source. That
 * is not a formality. `canRenderAt` then refuses every resolution, so a source
 * seen once never renders a first-seen date, which is the honest reading of one
 * observation.
 *
 * WHAT THIS OVER-STATES, AND WHY THAT IS THE RIGHT DIRECTION. An accepted
 * capture is a commit; a poll that fetched and found no change commits nothing.
 * From `raw/` alone a run that happened and saw no change is indistinguishable
 * from a run that never happened, so a stable source that was polled every 15
 * minutes for three days reports three days rather than 15 minutes. That is the
 * conservative reading of the ambiguity and it is taken deliberately: the
 * flattering reading would credit an observation nobody can produce evidence of.
 */
export function precisionSecondsFrom(tier: Tier, instants: string[]): number {
  const widest = maxGapSeconds(instants);
  if (widest === null) return Infinity;
  return Math.max(widest, precisionFloorFor(tier));
}

/**
 * Spec section 10.1: a renderer may show a date only when precision_seconds is
 * at or below the resolution it renders at.
 */
export function canRenderAt(precisionSeconds: number, resolutionSeconds: number): boolean {
  return precisionSeconds <= resolutionSeconds;
}

// ---------------------------------------------------------------------------
// openrouter-models
// ---------------------------------------------------------------------------

export type CatalogEntry = {
  id: string;
  created: number | null;
  canonicalSlug: string | null;
  contextLength: number | null;
  topProviderContextLength: number | null;
  /** Only the string-valued members of `pricing`. See parseCatalog. */
  pricing: Record<string, string>;
  expirationDate: string | null;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * The stored catalogue bytes to entries keyed by catalogue id.
 *
 * THROWS on bytes that are not a `{ data: [...] }` document. Silence would be
 * the worse failure: the collector's own invariants for this source already
 * require `data` and at least 300 records, so bytes that fail here are bytes
 * that were committed in violation of an invariant, and a deriver that shrugged
 * would stop emitting catalogue events with nothing anywhere going red.
 *
 * `pricing` keeps only string members. OpenRouter ships a `pricing.overrides`
 * ARRAY on 60 models today, holding day-of-week and hour-banded rates. It is
 * not a listed price and comparing it as one would emit a price_changed event
 * whose from and to are `[object Object]`.
 */
export function parseCatalog(text: string): Map<string, CatalogEntry> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('openrouter-models: stored bytes are not valid JSON');
  }
  const root = asRecord(json);
  const data = root === null ? undefined : root['data'];
  if (!Array.isArray(data)) throw new Error('openrouter-models: stored bytes have no `data` array');

  const out = new Map<string, CatalogEntry>();
  for (const item of data) {
    const m = asRecord(item);
    if (m === null) continue;
    const id = strOrNull(m['id']);
    if (id === null || id === '') continue;

    const pricing: Record<string, string> = {};
    const p = asRecord(m['pricing']);
    if (p !== null) {
      for (const [k, v] of Object.entries(p)) {
        if (typeof v === 'string') pricing[k] = v;
      }
    }
    const topProvider = asRecord(m['top_provider']);

    out.set(id, {
      id,
      created: numOrNull(m['created']),
      canonicalSlug: strOrNull(m['canonical_slug']),
      contextLength: numOrNull(m['context_length']),
      topProviderContextLength: topProvider === null ? null : numOrNull(topProvider['context_length']),
      pricing,
      expirationDate: strOrNull(m['expiration_date']),
    });
  }
  return out;
}

function catalogEvents(
  change: ContentChange,
  before: string,
  after: string,
  precisionSeconds: number,
): DerivedEvent[] {
  const prev = parseCatalog(before);
  const next = parseCatalog(after);
  const out: DerivedEvent[] = [];
  const base = (entities: Entity[]): Omit<Common, 'id'> => ({
    sha: change.sha,
    sourceId: change.sourceId,
    path: change.path,
    stamp: change.stamp,
    entities,
    held: entities.length === 0,
  });

  for (const [id, now] of next) {
    const entities = entitiesForCatalogModel(id);
    const was = prev.get(id);

    if (was === undefined) {
      const b = base(entities);
      out.push({
        ...b,
        id: `${change.sha}:model_added:${id}`,
        type: 'model_added',
        modelId: id,
        created: now.created,
        precisionSeconds,
      });
      // A model present for the first time has no previous values to compare
      // against, so nothing below it can fire for this id. Every remaining
      // event in this loop is a transition.
      continue;
    }

    if (was.contextLength !== now.contextLength) {
      const b = base(entities);
      out.push({
        ...b,
        id: `${change.sha}:context_changed:${id}`,
        type: 'context_changed',
        modelId: id,
        from: was.contextLength,
        to: now.contextLength,
        topProviderFrom: was.topProviderContextLength,
        topProviderTo: now.topProviderContextLength,
      });
    }

    // Union of both sides' fields, so a price field that disappeared is a
    // change too. Sorted, so two runs over the same bytes emit the same order.
    const fields = [...new Set([...Object.keys(was.pricing), ...Object.keys(now.pricing)])].sort();
    for (const field of fields) {
      const from = was.pricing[field] ?? null;
      const to = now.pricing[field] ?? null;
      if (from === to) continue;
      const b = base(entities);
      out.push({
        ...b,
        id: `${change.sha}:price_changed:${id}:${field}`,
        type: 'price_changed',
        modelId: id,
        field,
        from,
        to,
      });
    }

    // Spec's under-used forward-looking field: non-null only on transient
    // entries, so the event is the transition INTO non-null. A date that was
    // already set and merely changed is a different claim and is not this one.
    if (was.expirationDate === null && now.expirationDate !== null) {
      const b = base(entities);
      out.push({
        ...b,
        id: `${change.sha}:expiration_set:${id}`,
        type: 'expiration_set',
        modelId: id,
        date: now.expirationDate,
      });
    }

    // The alias signal that needs no new id: `id` is the stable public string
    // and `canonical_slug` is the dated build behind it, so a slug change under
    // an unchanged id is the pointer moving. Both sides must be present, or
    // this is a field appearing rather than a target changing.
    if (
      was.canonicalSlug !== null &&
      now.canonicalSlug !== null &&
      was.canonicalSlug !== now.canonicalSlug
    ) {
      const b = base(entities);
      out.push({
        ...b,
        id: `${change.sha}:alias_retargeted:${id}`,
        type: 'alias_retargeted',
        alias: id,
        from: was.canonicalSlug,
        to: now.canonicalSlug,
      });
    }
  }

  for (const [id] of prev) {
    if (next.has(id)) continue;
    const entities = entitiesForCatalogModel(id);
    const b = base(entities);
    out.push({
      ...b,
      id: `${change.sha}:model_removed:${id}`,
      type: 'model_removed',
      modelId: id,
      // When it was last seen present, which is the capture BEFORE this one.
      // Not this commit's stamp: this commit is when it was seen absent.
      lastSeen: change.previousStamp,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// llms.txt
// ---------------------------------------------------------------------------

/**
 * An llms.txt index line is `- [Title](url)` with an optional `: description`.
 *
 * The title stops at the first `]` and the url at the first `)`, which is what
 * keeps a description's own inline markdown links, of which OpenRouter's index
 * has several, out of the match.
 */
const INDEX_LINE = /^\s*-\s+\[([^\]]*)\]\(([^)\s]+)\)/;

/** url to title, in file order. url is the identity; the title is a label. */
export function parseDocIndex(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = INDEX_LINE.exec(line);
    if (m === null) continue;
    const title = m[1];
    const url = m[2];
    if (title === undefined || url === undefined) continue;
    if (!out.has(url)) out.set(url, title.trim());
  }
  return out;
}

function docEvents(change: ContentChange, before: string, after: string): DerivedEvent[] {
  const provider = providerFromSourceId(change.sourceId);
  // A source whose id does not carry a provider segment is not an index this
  // module knows how to attribute, so it yields nothing rather than an event
  // attributed to a provider we made up.
  if (provider === null) return [];

  const prev = parseDocIndex(before);
  const next = parseDocIndex(after);
  const out: DerivedEvent[] = [];

  /*
   * A MOVE IS ONE EVENT, NOT A REMOVAL PLUS AN ADDITION.
   *
   * A documentation index that renames a directory produces, per page, a url
   * that vanishes and a url that appears carrying the SAME TITLE. Reported as
   * two events that is twice wrong: it says a page was removed when the page is
   * still published, and it says a page was added when it is not new.
   *
   * It also drowns the real signal. In one live diff, four of the nine
   * removals were Perplexity moving /gateway/ to /router/ and OpenRouter
   * lifting containers.md up a level, and the other five were OpenAI's
   * Assistants API pages actually leaving the index. All nine rendered at
   * identical weight, so a deprecation worth knowing about sat beside four
   * non-events.
   *
   * MATCHED ON TITLE, WITHIN ONE DIFF, AND ONLY WHEN THE TITLE IS UNAMBIGUOUS.
   * A title appearing once among the departures and once among the arrivals is
   * the only case paired here. If a title occurs twice on either side there is
   * no way to say which went where, so both stay as separate add and remove
   * events: an unpaired pair of true statements beats one confident wrong one.
   * The claim names the INDEX ENTRY rather than the page, because what the
   * bytes support is that an entry under this title now points somewhere else.
   */
  const gone = [...prev].filter(([url]) => !next.has(url));
  const arrived = [...next].filter(([url]) => !prev.has(url));

  const countByTitle = (rows: [string, string][]): Map<string, number> => {
    const n = new Map<string, number>();
    for (const [, title] of rows) n.set(title, (n.get(title) ?? 0) + 1);
    return n;
  };
  const goneTitles = countByTitle(gone);
  const arrivedTitles = countByTitle(arrived);
  const movable = (title: string): boolean => goneTitles.get(title) === 1 && arrivedTitles.get(title) === 1;

  const movedFrom = new Map<string, string>();
  for (const [url, title] of gone) if (movable(title)) movedFrom.set(title, url);

  for (const [url, title] of arrived) {
    if (movable(title)) {
      const from = movedFrom.get(title) as string;
      const entities = entitiesForDocUrl(url, provider);
      out.push({
        id: `${change.sha}:doc_moved:${url}`,
        type: 'doc_moved' as const,
        sha: change.sha,
        sourceId: change.sourceId,
        path: change.path,
        stamp: change.stamp,
        entities,
        held: entities.length === 0,
        provider,
        title,
        url,
        fromUrl: from,
      });
      continue;
    }
    const entities = entitiesForDocUrl(url, provider);
    out.push({
      id: `${change.sha}:doc_added:${url}`,
      type: 'doc_added',
      sha: change.sha,
      sourceId: change.sourceId,
      path: change.path,
      stamp: change.stamp,
      entities,
      held: entities.length === 0,
      provider,
      title,
      url,
    });
  }
  for (const [url, title] of gone) {
    if (movable(title)) continue;
    const entities = entitiesForDocUrl(url, provider);
    out.push({
      id: `${change.sha}:doc_removed:${url}`,
      type: 'doc_removed' as const,
      sha: change.sha,
      sourceId: change.sourceId,
      path: change.path,
      stamp: change.stamp,
      entities,
      held: entities.length === 0,
      provider,
      title,
      url,
    });
  }
  return out;
}

/**
 * New announcement URLs in a sitemap.
 *
 * THE LOC SET ONLY, NEVER lastmod. anthropic-sitemap's per-URL lastmod
 * oscillates between edge caches, measured at 24 of 516 values differing across
 * two fetches four seconds apart, so keying on it here would publish a story
 * every time a CDN node disagreed with itself. The predicate that decides
 * whether to COMMIT still reads lastmod, because an edit to an existing page is
 * worth storing; it is just not worth a headline.
 */
function announcementEvents(change: ContentChange, before: string, after: string): DerivedEvent[] {
  const provider = providerFromSourceId(change.sourceId);
  if (provider === null) return [];
  const prefixes = ANNOUNCEMENT_PATHS[change.sourceId];
  if (prefixes === undefined) return [];

  const prev = announcementUrls(before, prefixes);
  const next = announcementUrls(after, prefixes);
  const out: DerivedEvent[] = [];
  for (const url of next) {
    if (prev.has(url)) continue;
    const entities = entitiesForDocUrl(url, provider);
    out.push({
      id: `${change.sha}:post_listed:${url}`,
      type: 'post_listed',
      sha: change.sha,
      sourceId: change.sourceId,
      path: change.path,
      stamp: change.stamp,
      entities,
      held: entities.length === 0,
      provider,
      url,
    });
  }
  return out;
}

/**
 * New incidents in a status feed.
 *
 * KEYED ON THE ENTRY ID, not on the title or the content. A provider EDITS an
 * incident as it develops, appending "Monitoring" and then "Resolved" to the
 * same entry, so keying on anything else would report one outage three times.
 * The archive still stores every edit; this reports the incident once, when it
 * first appears.
 */
function incidentEvents(change: ContentChange, before: string, after: string): DerivedEvent[] {
  const provider = providerFromSourceId(change.sourceId);
  if (provider === null) return [];

  const prev = new Set(incidentEntries(before).map((e) => e.id));
  const out: DerivedEvent[] = [];
  for (const entry of incidentEntries(after)) {
    if (prev.has(entry.id) || entry.title === '') continue;
    out.push({
      id: `${change.sha}:incident_opened:${entry.id}`,
      type: 'incident_opened',
      sha: change.sha,
      sourceId: change.sourceId,
      path: change.path,
      stamp: change.stamp,
      entities: [],
      held: true,
      provider,
      title: entry.title,
      url: entry.url,
      published: entry.published,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// deprecations .md
// ---------------------------------------------------------------------------

const MONTHS: Record<string, string> = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12',
};

/**
 * `Not sooner than June 9, 2027` and `August 5, 2026` both to `2027-06-09` and
 * `2026-08-05`. A cell holding no month-day-year date, `N/A` included, yields
 * null and the event still carries the cell verbatim.
 */
export function parseFloorDate(cell: string): string | null {
  const m = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(cell);
  if (m === null) return null;
  const month = MONTHS[(m[1] ?? '').toLowerCase()];
  const day = m[2];
  const year = m[3];
  if (month === undefined || day === undefined || year === undefined) return null;
  return `${year}-${month}-${day.padStart(2, '0')}`;
}

function cells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return [];
  return trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim().replace(/^`|`$/g, ''));
}

/**
 * The lifecycle table, keyed by API model name, mapping to the retirement cell.
 *
 * Anchored on the header row rather than on "any four-column table": the same
 * document carries a deprecation-history section whose tables are
 * `Retirement date | Deprecated model | Recommended replacement`, and a
 * shape-only parser would read the retirement date out of column 0 there and
 * file it under a model name that is actually a date.
 */
export function parseDeprecationTable(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split('\n');
  let inTable = false;
  for (const line of lines) {
    const row = cells(line);
    if (!inTable) {
      if (row.length >= 4 && row[0] === 'API model name') inTable = true;
      continue;
    }
    if (row.length < 4) {
      inTable = false;
      continue;
    }
    const name = row[0] ?? '';
    const retirement = row[3] ?? '';
    // The `| --- | --- |` separator git renders under every header row.
    if (/^-+$/.test(name)) continue;
    if (name === '') continue;
    if (!out.has(name)) out.set(name, retirement);
  }
  return out;
}

/**
 * The deprecation-history tables, keyed by the DEPRECATED API model name and
 * mapping to the replacement that provider's own table recommends.
 *
 * A different table from parseDeprecationTable's, in the same document, and the
 * two are not merged. The lifecycle table above is current state: every model
 * the provider still serves, with the date it will stop. These are the
 * historical entries, three columns wide, and the third column is the only
 * place in the archive where a provider names a successor to one of its own
 * models. Reading a replacement out of it is transcription; deciding that a
 * replacement is equivalent to what it replaces would be the inference this
 * project refuses, so nothing here or downstream says a replacement is a
 * substitute. It says the table recommends it.
 *
 * Anchored on all THREE header cells rather than on column count, for the
 * reason parseDeprecationTable is anchored on its own: the lifecycle table in
 * the same file is four columns of the same shape, and a width-only parser
 * would read `Deprecated` out of its column 1 and file every live model under a
 * replacement named "N/A".
 *
 * FIRST WINS, and the document is ordered newest first, so a model that appears
 * in two history entries keeps the most recent recommendation.
 */
export function parseReplacementTable(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let inTable = false;
  for (const line of text.split('\n')) {
    const row = cells(line);
    if (!inTable) {
      // All THREE header cells, and no width check beside them. A row with
      // fewer than three cells already fails these comparisons against
      // undefined, so a length test here would be a condition no input can
      // falsify, which is a line no test can ever prove is doing anything.
      inTable =
        row[0] === 'Retirement date' &&
        row[1] === 'Deprecated model' &&
        row[2] === 'Recommended replacement';
      continue;
    }
    if (row.length !== 3) {
      inTable = false;
      continue;
    }
    const model = row[1] ?? '';
    const replacement = row[2] ?? '';
    // The `| --- | --- |` separator git renders under every header row.
    if (/^-+$/.test(model)) continue;
    if (model === '' || replacement === '') continue;
    if (!out.has(model)) out.set(model, replacement);
  }
  return out;
}

function retirementEvents(change: ContentChange, before: string, after: string): DerivedEvent[] {
  const provider = providerFromSourceId(change.sourceId);
  if (provider === null) return [];

  const prev = parseDeprecationTable(before);
  const next = parseDeprecationTable(after);
  const out: DerivedEvent[] = [];
  for (const [model, text] of next) {
    if (prev.get(model) === text) continue;
    const entities = entitiesForApiModel(provider, model);
    out.push({
      id: `${change.sha}:retirement_floor:${model}`,
      type: 'retirement_floor',
      sha: change.sha,
      sourceId: change.sourceId,
      path: change.path,
      stamp: change.stamp,
      entities,
      held: entities.length === 0,
      provider,
      model,
      floorDate: parseFloorDate(text),
      floorText: text,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// the dispatcher
// ---------------------------------------------------------------------------

/** The one source whose bytes are the catalogue. */
export const CATALOG_SOURCE_ID = 'openrouter-models';
/** The one source whose bytes are a provider lifecycle table. */
export const DEPRECATIONS_SOURCE_ID = 'anthropic-deprecations';

function isDocIndexSource(sourceId: string): boolean {
  return sourceId.endsWith('-llms-txt') || sourceId.endsWith('-llms-full-txt');
}

/**
 * Every event one artifact change supports. The whole public surface.
 *
 * A baseline capture returns an empty array, by rule 2 at the top of this file.
 * A source this module holds no reader for returns an empty array too: the atom
 * feeds are real changes and the change pages still show them, but nothing here
 * knows how to turn a status feed entry into a typed claim, and inventing one
 * is what this module exists not to do.
 *
 * `precisionSeconds` DEFAULTS TO UNBOUNDED on purpose. One change carries no
 * cadence evidence, and the default a caller gets by forgetting has to be the
 * one that cannot overstate confidence: unbounded renders no date at all.
 * deriveEvents below is the entry point that measures the real number.
 */
export function eventsFromChange(
  change: ContentChange,
  precisionSeconds: number = Infinity,
): DerivedEvent[] {
  /*
   * THE ONE EXCEPTION TO RULE 2, AND WHY IT IS NOT A HOLE IN IT.
   *
   * Rule 2 exists because a baseline supports no CHANGE claim: "these 416
   * models entered the catalogue today" is a statement about when they entered,
   * and a first capture knows nothing about that. Every event type this file
   * emits from a diff inherits its date from OUR observation, so every one of
   * them is barred from a baseline.
   *
   * A retirement floor is not that kind of claim. Its sentence is "the
   * <source> table RECORDS the tentative retirement date for X as Y", and both
   * X and Y are values read out of the vendor's own published table. The date
   * in it is the vendor's date, not our observation time, so the claim is
   * exactly as well supported by the first capture as by the hundredth. Nothing
   * about when the row appeared in the table is asserted, because the archive
   * does not know that and the sentence does not say it.
   *
   * What this bought: 16 dated floors with recommended replacements, which is
   * the most useful thing the archive holds, existed ONLY inside the CLI and
   * the API. `grep -rl "retirement floor" build/site` matched one file, the API
   * documentation. The publication's own micro-category for them read 0 items,
   * because the single deprecations capture is a baseline and a baseline
   * emitted nothing at all.
   */
  if (change.kind === 'added') {
    if (change.sourceId === DEPRECATIONS_SOURCE_ID) return retirementEvents(change, '', change.after);
    return [];
  }
  const before = change.before;
  // Belt and braces against a caller that says 'modified' with no before: the
  // alternative is every entry in the after being reported as newly added.
  if (before === null) return [];

  if (change.sourceId === CATALOG_SOURCE_ID) return catalogEvents(change, before, change.after, precisionSeconds);
  if (change.sourceId === DEPRECATIONS_SOURCE_ID) return retirementEvents(change, before, change.after);
  if (isDocIndexSource(change.sourceId)) return docEvents(change, before, change.after);
  if (isAnnouncementSource(change.sourceId)) return announcementEvents(change, before, change.after);
  if (isIncidentSource(change.sourceId)) return incidentEvents(change, before, change.after);
  return [];
}

/**
 * When each source was actually observed, in the order the archive holds them.
 *
 * Every accepted capture of a source is one commit that changed its path, and
 * readContentChanges yields exactly one ContentChange per such commit, so the
 * changes' own observation instants ARE the source's capture history. Baselines
 * included: a baseline emits no events but it is still an observation, and
 * leaving it out would widen every gap that starts at it.
 *
 * `observedAt` first, falling back to the rendered stamp. See ContentChange.
 */
export function observationsBySource(changes: ContentChange[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const change of changes) {
    const instant = change.observedAt ?? change.stamp?.iso ?? null;
    if (instant === null) continue;
    const seen = out.get(change.sourceId);
    if (seen === undefined) out.set(change.sourceId, [instant]);
    else seen.push(instant);
  }
  return out;
}

/** The measured worst-case first-seen error per source. */
export function precisionBySource(changes: ContentChange[]): Map<string, number> {
  const tiers = new Map<string, Tier>(changes.map((c) => [c.sourceId, c.tier]));
  const out = new Map<string, number>();
  for (const [sourceId, instants] of observationsBySource(changes)) {
    out.set(sourceId, precisionSecondsFrom(tiers.get(sourceId) ?? 'daily', instants));
  }
  return out;
}

/**
 * Every event the archive supports, with each one carrying its source's
 * MEASURED precision. The entry point the generator calls.
 *
 * Precision is computed across the whole set before any event is built, because
 * it is a property of the source's capture history and not of the one commit an
 * event came from. A source absent from the map has no usable observation at
 * all, and gets unbounded.
 */
export function deriveEvents(changes: ContentChange[]): DerivedEvent[] {
  const precision = precisionBySource(changes);
  return changes.flatMap((c) => eventsFromChange(c, precision.get(c.sourceId) ?? Infinity));
}

// ---------------------------------------------------------------------------
// the claim forms
// ---------------------------------------------------------------------------

/**
 * The claim forms interpolate NOTHING third-party without quoting it. See
 * src/derive/quoting.ts for why that is the copy rule rather than typography:
 * a catalogue id, a documentation title and a deprecation-table cell are all
 * bytes someone else chose, and an unquoted one is prose this project publishes
 * under its own byline.
 */
export function claimSentence(event: DerivedEvent): string {
  switch (event.type) {
    case 'model_added':
      return `The catalog id ${quoteValue(event.modelId)} entered OpenRouter's catalog.`;
    case 'model_removed':
      return `The catalog id ${quoteValue(event.modelId)} left OpenRouter's catalog.`;
    case 'price_changed':
      return `OpenRouter's listed ${quoteValue(event.field)} price for ${quoteValue(event.modelId)} changed from ${quotedOrAbsent(event.from)} to ${quotedOrAbsent(event.to)}.`;
    case 'context_changed':
      return (
        `OpenRouter's catalog context_length for ${quoteValue(event.modelId)} changed from ${numberOrAbsent(event.from)} to ${numberOrAbsent(event.to)}. ` +
        `The top_provider.context_length recorded beside it was ${numberOrAbsent(event.topProviderFrom)} and is ${numberOrAbsent(event.topProviderTo)}.`
      );
    case 'expiration_set':
      return `OpenRouter's catalog recorded an expiration_date of ${quoteValue(event.date)} for ${quoteValue(event.modelId)}.`;
    case 'alias_retargeted':
      return `OpenRouter's catalog canonical_slug for ${quoteValue(event.alias)} changed from ${quoteValue(event.from)} to ${quoteValue(event.to)}.`;
    case 'doc_moved':
      return `The documentation index entry titled ${quoteValue(event.title)} moved from ${quoteValue(event.fromUrl)} to ${quoteValue(event.url)}.`;
    /*
     * A SITEMAP CARRIES NO TITLE, so this quotes the URL and nothing else.
     * Reading a headline out of a slug would be an inference, and the URL is
     * the fact. For these paths it is a legible one.
     */
    case 'post_listed':
      return `The ${event.sourceId} index listed a URL it had not listed before: ${quoteValue(event.url)}.`;
    case 'incident_opened':
      return `The ${event.sourceId} feed listed an incident titled ${quoteValue(event.title)} at ${quoteValue(event.url)}.`;
    case 'doc_added':
      return `The ${event.sourceId} index added an entry titled ${quoteValue(event.title)} at ${quoteValue(event.url)}.`;
    case 'doc_removed':
      return `The ${event.sourceId} index removed an entry titled ${quoteValue(event.title)} at ${quoteValue(event.url)}.`;
    case 'retirement_floor':
      return `The ${event.sourceId} table records the tentative retirement date for ${quoteValue(event.model)} as ${quoteValue(event.floorText)}.`;
  }
}
