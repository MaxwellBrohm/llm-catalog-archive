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
};

export type EventType =
  | 'model_added'
  | 'model_removed'
  | 'price_changed'
  | 'context_changed'
  | 'expiration_set'
  | 'alias_retargeted'
  | 'doc_added'
  | 'doc_removed'
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
    | { type: 'doc_removed'; provider: string; title: string; url: string }
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
 * How late a scheduled run may start before its capture is later than its cron.
 *
 * UNMEASURED for this repository's own runner, and deliberately generous. The
 * only measurement in hand is the third-party archive's: kj-9's cron is `12 0
 * * * *` and 0 of 615 commits landed before 00:20 UTC, with a median delay of
 * about 2h18m. One hour is a bound this collector has not been observed to
 * exceed, and it must be replaced with a measurement once there is one. It is
 * an integer rather than an adjective in prose precisely so that replacing it
 * changes what renders.
 */
export const CRON_ALLOWANCE_SECONDS = 3600;

const TIER_INTERVAL_SECONDS: Record<Tier, number> = { fast: 900, daily: 86400 };

/**
 * Worst-case error on "first seen in the catalogue at", for a tier.
 *
 * fast: 900 + 3600 = 4500, which is under a day, so a fast-tier first-seen may
 * render at day resolution. daily: 86400 + 3600 = 90000, which is over a day,
 * so a daily-tier first-seen may NOT. That is the whole
 * reason openrouter-models is a fast-tier source, and the reason the fast
 * workflow had to exist before this module was worth writing.
 */
export function precisionSecondsFor(tier: Tier): number {
  return TIER_INTERVAL_SECONDS[tier] + CRON_ALLOWANCE_SECONDS;
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

type CatalogEntry = {
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

function catalogEvents(change: ContentChange, before: string, after: string): DerivedEvent[] {
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
        precisionSeconds: precisionSecondsFor(change.tier),
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

  for (const [url, title] of next) {
    if (prev.has(url)) continue;
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
  for (const [url, title] of prev) {
    if (next.has(url)) continue;
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
 */
export function eventsFromChange(change: ContentChange): DerivedEvent[] {
  if (change.kind === 'added') return [];
  const before = change.before;
  // Belt and braces against a caller that says 'modified' with no before: the
  // alternative is every entry in the after being reported as newly added.
  if (before === null) return [];

  if (change.sourceId === CATALOG_SOURCE_ID) return catalogEvents(change, before, change.after);
  if (change.sourceId === DEPRECATIONS_SOURCE_ID) return retirementEvents(change, before, change.after);
  if (isDocIndexSource(change.sourceId)) return docEvents(change, before, change.after);
  return [];
}

// ---------------------------------------------------------------------------
// the claim forms
// ---------------------------------------------------------------------------

/** A value that is absent rather than empty, printed so a reader can tell. */
function orAbsent(v: string | number | null): string {
  return v === null ? 'absent' : String(v);
}

/**
 * The sentence an event renders as. Spec section 10.1's mechanical form.
 *
 * THE SUBJECT IS ALWAYS AN ARTIFACT. A company name appears only as a
 * possessive modifier in front of the artifact ("OpenRouter's catalog"), inside
 * a source id, or inside a value quoted from the archive. It is never followed
 * by a verb, because that is the sentence that claims a company did something,
 * and a routing change or a docs-platform migration falsifies every one of
 * them.
 *
 * Numbers are printed as the archive stores them, without thousands
 * separators, so a reader comparing the sentence against the linked artifact is
 * comparing the same characters.
 */
export function claimSentence(event: DerivedEvent): string {
  switch (event.type) {
    case 'model_added':
      return `${event.modelId} entered OpenRouter's catalog.`;
    case 'model_removed':
      return `${event.modelId} left OpenRouter's catalog.`;
    case 'price_changed':
      return `OpenRouter's listed ${event.field} price for ${event.modelId} changed from ${orAbsent(event.from)} to ${orAbsent(event.to)}.`;
    case 'context_changed':
      return (
        `OpenRouter's catalog context_length for ${event.modelId} changed from ${orAbsent(event.from)} to ${orAbsent(event.to)}. ` +
        `The top_provider.context_length recorded beside it was ${orAbsent(event.topProviderFrom)} and is ${orAbsent(event.topProviderTo)}.`
      );
    case 'expiration_set':
      return `OpenRouter's catalog recorded an expiration_date of ${event.date} for ${event.modelId}.`;
    case 'alias_retargeted':
      return `OpenRouter's catalog canonical_slug for ${event.alias} changed from ${event.from} to ${event.to}.`;
    case 'doc_added':
      return `The ${event.sourceId} index added an entry titled "${event.title}" at ${event.url}.`;
    case 'doc_removed':
      return `The ${event.sourceId} index removed an entry titled "${event.title}" at ${event.url}.`;
    case 'retirement_floor':
      return `The ${event.sourceId} table records the tentative retirement date for ${event.model} as "${event.floorText}".`;
  }
}
