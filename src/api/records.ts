/**
 * The record shapes the static JSON API serves. Pure: no fs, no git, no clock.
 *
 * WHY A SEPARATE LAYER AND NOT `JSON.stringify(feedItem)`. A FeedItem is an
 * internal shape that changes whenever a deriver changes, and an API is a
 * promise that it will not. More importantly, the internal shapes carry things
 * that must never be published raw: `precisionSeconds` is `Infinity`, which
 * JSON.stringify silently turns into `null` with no note attached, and a
 * consumer reading `null` there would take it for "no error" rather than
 * "unbounded". Every field below is spelled out, snake_case, once.
 *
 * THE THREE RULES THIS FILE ENFORCES, all of them from the specs and none of
 * them cosmetic:
 *
 *   1. Every record carries its artifact permalink at the FULL sha of the
 *      commit that changed it, never HEAD. Section 11 of the archive design.
 *
 *   2. Every timestamp is LABELLED with the field it came from, `origin_date`
 *      or `observed_at`. Section 9. A bare ISO string in an API is a claim that
 *      the two are interchangeable, and they are not.
 *
 *   3. No date is emitted at a resolution finer than `precision_seconds`
 *      allows. Section 10.1. That is why `first_seen_in_catalog_at` is a
 *      nullable day and not a timestamp: under the archive's measured values no
 *      source earns day resolution today, so the field publishes null and says
 *      why, rather than publishing a number a consumer would sort on.
 *
 * The sentences are COPIED from the derivations, never recomposed here, for the
 * same reason src/derive/feed.ts copies them: the copy rule lives in the two
 * modules that write claim forms, and a third place that writes sentences is a
 * third place that can get one wrong.
 */

import {
  canRenderAt,
  DAY_SECONDS,
  parseCatalog,
  parseDeprecationTable,
  parseFloorDate,
  parseReplacementTable,
  precisionBySource,
  CATALOG_SOURCE_ID,
  DEPRECATIONS_SOURCE_ID,
  type CatalogEntry,
  type ContentChange,
  type DerivedEvent,
} from '../derive/events.js';
import { entitySlug, providerFromSourceId, type Entity } from '../derive/entities.js';
import { labsOf, type FeedItem, type FeedType } from '../derive/feed.js';
import type { LeakRefusal } from '../derive/leaks.js';
import type { LedgerClaim, Scorecard } from '../site/ledger.js';
import {
  artifactPermalink,
  commitPermalink,
  utcDay,
  REPO_URL,
  type Stamp,
} from '../site/record.js';

/** The version segment. Bumping it is how a breaking change ships. */
export const API_VERSION = 'v1';

/** Every generated file sits under this prefix, relative to the site root. */
export const API_PREFIX = `api/${API_VERSION}`;

/**
 * How many items one page of the event stream holds.
 *
 * A number rather than "all of them" because the stream grows without bound and
 * a single file is the shape that eventually stops being fetchable on a phone.
 * 200 is chosen so page 1 is well under a megabyte at the archive's current
 * record size, which is what makes the front door of the API cheap.
 */
export const PAGE_SIZE = 200;

/** A timestamp and the sidecar field it was read from. Never one without the other. */
export type TimestampView = { value: string; field: 'origin_date' | 'observed_at' } | null;

export type PrecisionView = {
  /** Worst-case first-seen error in seconds, or null when unbounded. */
  precision_seconds: number | null;
  precision_note: string;
};

export type EntityRecord = {
  kind: Entity['kind'];
  id: string;
  label: string;
  slug: string;
  /** The thread page, absolute, so a consumer can link a human at it. */
  thread: string;
};

/** What every record in this API carries, whatever else it carries. */
export type Provenance = PrecisionView & {
  sha: string;
  source_id: string;
  path: string;
  /** `<repo>/blob/<full sha>/<path>`. The commit that changed it, not HEAD. */
  artifact: string;
  commit: string;
  timestamp: TimestampView;
};

export type ItemRecord = Provenance & {
  id: string;
  kind: 'event' | 'leak';
  type: FeedType;
  /** The sentence the deriving module wrote. Copied, never recomposed. */
  sentence: string;
  /** The name, id or number the claim is about. */
  subject: string;
  /** Set on a leak item, null on an event: an event carries no sourcing tier. */
  tier: string | null;
  entities: EntityRecord[];
  labs: string[];
  /** The typed fields behind the sentence, so a client need not parse prose. */
  fields: Record<string, string | number | null>;
};

export type ModelRecord = {
  id: string;
  slug: string;
  /** The per-model endpoint, absolute. Null when no item has attached to it. */
  api: string | null;
  canonical_slug: string | null;
  context_length: number | null;
  /** Never omitted. See the worked example in section 10.1 of the archive design. */
  top_provider_context_length: number | null;
  pricing: Record<string, string>;
  /** The catalog's own `created`, in seconds. Not a launch date. */
  created: number | null;
  expiration_date: string | null;
  /** A day, or null when this source's measured error is wider than a day. */
  first_seen_in_catalog_at: string | null;
  precision_seconds: number | null;
  precision_note: string;
  /** How many derived items in this archive attach to this model. */
  events: number;
};

export type RetirementRecord = {
  provider: string;
  model: string;
  /** The cell parsed to YYYY-MM-DD, or null when it holds no date. */
  floor_date: string | null;
  /** The cell verbatim, which is the evidence the date came from. */
  floor_text: string;
  /** What that provider's own history table recommends, or null. */
  replacement: string | null;
  replacement_source: string | null;
};

/** Absolute, because a relative link in a JSON body resolves against nothing. */
export function apiUrl(siteUrl: string, rel: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/${API_PREFIX}/${rel}`;
}

export function siteUrlFor(siteUrl: string, rel: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/${rel}`;
}

/**
 * The timestamp, labelled.
 *
 * `origin_date` is the provider's own generation time and `observed_at` is the
 * runner's clock, and section 9 is explicit that they answer different
 * questions. A consumer that gets the label can decide; one that gets a bare
 * string cannot, and will assume the flattering reading.
 */
export function timestampView(stamp: Stamp | null): TimestampView {
  if (stamp === null) return null;
  return { value: stamp.iso, field: stamp.kind === 'origin' ? 'origin_date' : 'observed_at' };
}

/**
 * The precision, with `Infinity` spelled rather than serialised.
 *
 * JSON.stringify(Infinity) is `null`, and a consumer reading a null there would
 * take it for "no error recorded". The note is emitted in both arms so the
 * field is never a number with no explanation of what measured it.
 */
export function precisionView(seconds: number): PrecisionView {
  if (!Number.isFinite(seconds)) {
    return {
      precision_seconds: null,
      precision_note:
        'unbounded: the archive holds fewer than two captures of this source, so no gap between captures bounds the error',
    };
  }
  return {
    precision_seconds: seconds,
    precision_note:
      'worst-case first-seen error in seconds, measured as the largest gap between consecutive accepted captures of this source, floored at its configured poll interval',
  };
}

/**
 * A day, only where the measured error is at or below a day.
 *
 * Section 10.1: a renderer may show a date only when precision_seconds is at or
 * below the resolution it renders at. This is the API's copy of the rule the
 * HTML renderer already applies, and it is a copy rather than a shared call
 * because the two surfaces publish independently and a rule enforced in one
 * place that both merely happen to route through is a rule one refactor away
 * from being enforced in neither.
 */
export function dayIfPermitted(stamp: Stamp | null, precisionSeconds: number): string | null {
  if (stamp === null) return null;
  if (!canRenderAt(precisionSeconds, DAY_SECONDS)) return null;
  return utcDay(stamp.iso);
}

export function entityRecord(entity: Entity, siteUrl: string): EntityRecord {
  const slug = entitySlug(entity);
  return {
    kind: entity.kind,
    id: entity.id,
    label: entity.label,
    slug,
    thread: siteUrlFor(siteUrl, `threads/${slug}.html`),
  };
}

/** The subject of an item: the string its sentence is about. */
export function subjectOf(item: FeedItem): string {
  if (item.leak !== null) return item.leak.subject;
  const event = item.event;
  if (event === null) return '';
  switch (event.type) {
    case 'model_added':
    case 'model_removed':
    case 'price_changed':
    case 'context_changed':
    case 'expiration_set':
      return event.modelId;
    case 'alias_retargeted':
      return event.alias;
    case 'doc_added':
    case 'doc_moved':
    case 'doc_removed':
    case 'post_listed':
    case 'post_published':
    case 'incident_opened':
      return event.url;
    case 'retirement_floor':
      return event.model;
  }
}

/**
 * The typed fields behind one event's sentence.
 *
 * Every arm of the union is spelled, so adding an event type without deciding
 * what it publishes is a compile error here rather than an endpoint that
 * silently serves a sentence with no data under it.
 */
export function eventFields(
  event: DerivedEvent,
  precisionSeconds: number,
): Record<string, string | number | null> {
  switch (event.type) {
    case 'model_added':
      return {
        model_id: event.modelId,
        created: event.created,
        first_seen_in_catalog_at: dayIfPermitted(event.stamp, precisionSeconds),
      };
    case 'model_removed':
      return { model_id: event.modelId, last_seen_at: event.lastSeen?.iso ?? null };
    case 'price_changed':
      return { model_id: event.modelId, field: event.field, from: event.from, to: event.to };
    case 'context_changed':
      return {
        model_id: event.modelId,
        from: event.from,
        to: event.to,
        top_provider_from: event.topProviderFrom,
        top_provider_to: event.topProviderTo,
      };
    case 'expiration_set':
      return { model_id: event.modelId, expiration_date: event.date };
    case 'alias_retargeted':
      return { alias: event.alias, from: event.from, to: event.to };
    case 'doc_added':
    case 'doc_removed':
      return { provider: event.provider, title: event.title, url: event.url };
    // from_url is the whole point of the type: a consumer that only reads `url`
    // sees where the entry is now, and one that reads both sees the move.
    case 'doc_moved':
      return { provider: event.provider, title: event.title, url: event.url, from_url: event.fromUrl };
    case 'post_listed':
      return { provider: event.provider, url: event.url };
    case 'post_published':
      return { provider: event.provider, title: event.title, url: event.url, published: event.published };
    case 'incident_opened':
      return { provider: event.provider, title: event.title, url: event.url, published: event.published };
    case 'retirement_floor':
      return {
        provider: event.provider,
        model: event.model,
        floor_date: event.floorDate,
        floor_text: event.floorText,
      };
  }
}

/** One feed item as an API record. */
export function itemRecord(
  item: FeedItem,
  precisionSeconds: number,
  siteUrl: string,
  repoUrl: string = REPO_URL,
): ItemRecord {
  const fields: Record<string, string | number | null> =
    item.event !== null
      ? eventFields(item.event, precisionSeconds)
      : Object.fromEntries(item.facts);
  return {
    id: item.id,
    kind: item.kind,
    type: item.type,
    sentence: item.sentence,
    subject: subjectOf(item),
    tier: item.tier,
    entities: item.entities.map((e) => entityRecord(e, siteUrl)),
    labs: labsOf(item),
    fields,
    sha: item.sha,
    source_id: item.sourceId,
    path: item.path,
    artifact: artifactPermalink(item.sha, item.path, repoUrl),
    commit: commitPermalink(item.sha, repoUrl),
    timestamp: timestampView(item.stamp),
    ...precisionView(precisionSeconds),
  };
}

export function refusalRecord(
  refusal: LeakRefusal,
  repoUrl: string = REPO_URL,
): Record<string, unknown> {
  return {
    source_id: refusal.sourceId,
    sha: refusal.sha,
    path: refusal.path,
    artifact: artifactPermalink(refusal.sha, refusal.path, repoUrl),
    commit: commitPermalink(refusal.sha, repoUrl),
    timestamp: timestampView(refusal.stamp),
    reason: refusal.reason,
  };
}

export function claimRecord(claim: LedgerClaim): Record<string, unknown> {
  return {
    id: claim.id,
    claim: claim.claim,
    tier: claim.tier,
    recorded: claim.recorded,
    artifact: claim.artifact,
    outcome: claim.outcome,
    resolved: claim.resolved,
    resolution_note: claim.resolutionNote,
  };
}

export function scorecardRecord(score: Scorecard): Record<string, unknown> {
  return {
    total: score.total,
    confirmed: score.confirmed,
    refuted: score.refuted,
    open: score.open,
    accuracy_pct: score.accuracyPct,
  };
}

/**
 * The newest change of one source, or null when the archive holds none.
 *
 * By stamp rather than by input order, because "newest" has to mean the same
 * thing here as it means on every page, and input order is a property of how
 * the caller walked git. Section 9's reject-an-older-origin_date rule makes the
 * two agree in practice; picking the stamp makes them agree by construction.
 * Ties, and a source whose captures carry no sidecar at all, fall back to the
 * first in input order, which readContentChanges yields newest first.
 */
export function newestChangeOf(changes: ContentChange[], sourceId: string): ContentChange | null {
  let best: ContentChange | null = null;
  let bestKey = -Infinity;
  for (const change of changes) {
    if (change.sourceId !== sourceId) continue;
    const ms = change.stamp === null ? -Infinity : Date.parse(change.stamp.iso);
    const key = Number.isNaN(ms) ? -Infinity : ms;
    if (best === null || key > bestKey) {
      best = change;
      bestKey = key;
    }
  }
  return best;
}

/** The provenance block for a whole current-state document. */
export function provenanceOf(
  change: ContentChange,
  precisionSeconds: number,
  repoUrl: string = REPO_URL,
): Provenance {
  return {
    sha: change.sha,
    source_id: change.sourceId,
    path: change.path,
    artifact: artifactPermalink(change.sha, change.path, repoUrl),
    commit: commitPermalink(change.sha, repoUrl),
    timestamp: timestampView(change.stamp),
    ...precisionView(precisionSeconds),
  };
}

/**
 * The oldest `model_added` item for each catalog id, which is when the archive
 * first saw it.
 *
 * OLDEST, not newest, and the difference is a model that left the catalog and
 * came back: the archive first saw it on the first of those, and reporting the
 * second would publish a first-seen date later than an event the same API
 * serves. The feed is newest first, so the last match wins.
 */
export function firstAddedByModel(feed: FeedItem[]): Map<string, FeedItem> {
  const out = new Map<string, FeedItem>();
  for (const item of feed) {
    // The EVENT's discriminant, not the feed item's, and only that one. They
    // agree by construction, so testing both would leave a condition no input
    // can falsify sitting in front of the one that does the work.
    const event = item.event;
    if (event === null || event.type !== 'model_added') continue;
    out.set(event.modelId, item);
  }
  return out;
}

/** How many items in the feed attach to each entity id. */
export function itemCountByEntity(feed: FeedItem[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of feed) {
    for (const entity of item.entities) out.set(entity.id, (out.get(entity.id) ?? 0) + 1);
  }
  return out;
}

/** One current catalog row as an API record. */
export function modelRecord(
  entry: CatalogEntry,
  opts: {
    firstAdded: FeedItem | null;
    precisionSeconds: number;
    events: number;
    siteUrl: string;
    hasThread: boolean;
  },
): ModelRecord {
  const slug = entitySlug({ kind: 'model', id: `model/openrouter:${entry.id}`, label: entry.id });
  return {
    id: entry.id,
    slug,
    api: opts.hasThread ? apiUrl(opts.siteUrl, `models/${slug}.json`) : null,
    canonical_slug: entry.canonicalSlug,
    context_length: entry.contextLength,
    top_provider_context_length: entry.topProviderContextLength,
    pricing: entry.pricing,
    created: entry.created,
    expiration_date: entry.expirationDate,
    first_seen_in_catalog_at:
      opts.firstAdded === null ? null : dayIfPermitted(opts.firstAdded.stamp, opts.precisionSeconds),
    ...precisionView(opts.precisionSeconds),
    events: opts.events,
  };
}

/** The current catalog, or null when the archive holds no capture of it. */
export function currentModels(
  changes: ContentChange[],
  feed: FeedItem[],
  siteUrl: string,
  threadSlugs: Set<string>,
  repoUrl: string = REPO_URL,
): { source: Provenance; models: ModelRecord[] } | null {
  const change = newestChangeOf(changes, CATALOG_SOURCE_ID);
  if (change === null) return null;
  const precision = precisionBySource(changes).get(CATALOG_SOURCE_ID) ?? Infinity;
  const firstAdded = firstAddedByModel(feed);
  const counts = itemCountByEntity(feed);
  const models: ModelRecord[] = [];
  for (const entry of parseCatalog(change.after).values()) {
    const entityId = `model/openrouter:${entry.id}`;
    const record = modelRecord(entry, {
      firstAdded: firstAdded.get(entry.id) ?? null,
      precisionSeconds: precision,
      events: counts.get(entityId) ?? 0,
      siteUrl,
      hasThread: threadSlugs.has(
        entitySlug({ kind: 'model', id: entityId, label: entry.id }),
      ),
    });
    models.push(record);
  }
  models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { source: provenanceOf(change, precision, repoUrl), models };
}

/**
 * The current retirement floors, joined to the replacements the same document
 * records, or null when the archive holds no capture of it.
 *
 * CURRENT STATE, derived from the newest stored bytes, and not from the event
 * stream. The events are transitions: a model whose floor was recorded once and
 * never moved has exactly one event, in a commit that may be months old, and a
 * client asking "what is retiring in the next 90 days" would have to replay the
 * whole stream to answer it. That replay is the thing this endpoint exists to
 * not make every caller write.
 *
 * The join is WITHIN one provider's own document and on the provider's own
 * exact model name. No namespace is crossed: an OpenRouter catalog id is a
 * different string issued by a different party, and deciding it is the same
 * model is the judgement src/derive/entities.ts refuses to make.
 */
export function currentRetirements(
  changes: ContentChange[],
  repoUrl: string = REPO_URL,
): { source: Provenance; retirements: RetirementRecord[] } | null {
  const change = newestChangeOf(changes, DEPRECATIONS_SOURCE_ID);
  if (change === null) return null;
  const provider = providerFromSourceId(change.sourceId);
  if (provider === null) return null;
  const precision = precisionBySource(changes).get(DEPRECATIONS_SOURCE_ID) ?? Infinity;
  const replacements = parseReplacementTable(change.after);
  const retirements: RetirementRecord[] = [];
  for (const [model, floorText] of parseDeprecationTable(change.after)) {
    const replacement = replacements.get(model) ?? null;
    retirements.push({
      provider,
      model,
      floor_date: parseFloorDate(floorText),
      floor_text: floorText,
      replacement,
      replacement_source:
        replacement === null
          ? null
          : `the ${change.sourceId} deprecation-history table's "Recommended replacement" column`,
    });
  }
  retirements.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  return { source: provenanceOf(change, precision, repoUrl), retirements };
}
