/**
 * The static JSON API. Pure: buildApi returns the bytes, it writes nothing.
 *
 * WHAT THIS IS FOR, stated once so the shape below is legible. The incumbents
 * are not expensive, they are shut: pricepertoken has price history and no API
 * at all, llmstatus.ai 401-walls its API, and models.dev is current state only
 * with history existing solely as `git log -p` over thousands of sync PRs. The
 * pitch here is not cheaper. It is keyless, documented, and actually there. So
 * this generates flat files onto the same GitHub Pages deployment the site
 * uses: no server to fall over, no key to issue, no rate limit to hit, no
 * signup, and a consumer can mirror the whole thing with `wget -r`.
 *
 * EVERY RECORD CARRIES ITS EVIDENCE. That is the property that makes this worth
 * consuming rather than a second copy of somebody else's numbers: an artifact
 * permalink at the full sha of the commit that changed it, the timestamp
 * labelled with the sidecar field it came from, and the measured precision of
 * that source. A number here can be checked against the bytes it was read from
 * without asking us anything.
 *
 * THE DIRECTORY IS THE AUTHORITY. index.json lists exactly which files exist,
 * which is what lets a client tell "this lab has nothing in the archive" from
 * "the deploy is broken". Two four-oh-fours are otherwise identical, and this
 * project is organised around not making a failure and a quiet week look the
 * same.
 */

import type { SiteFile } from '../site/build.js';
import { ALL_TYPES, itemsOfLab, itemsOfType, labsInFeed, type FeedItem, type FeedType } from '../derive/feed.js';
import { precisionBySource, observationsBySource, type ContentChange } from '../derive/events.js';
import { threadsOfKind, type ThreadSet } from '../derive/threads.js';
import type { LeakRefusal } from '../derive/leaks.js';
import { scoreLedger, type LedgerClaim } from '../site/ledger.js';
import { REPO_URL, SITE_URL, artifactPermalink, commitPermalink } from '../site/record.js';
import {
  API_PREFIX,
  API_VERSION,
  PAGE_SIZE,
  apiUrl,
  claimRecord,
  currentModels,
  currentRetirements,
  itemRecord,
  precisionView,
  refusalRecord,
  scorecardRecord,
  timestampView,
  type ItemRecord,
} from './records.js';

export type ApiInput = {
  feed: FeedItem[];
  threads: ThreadSet;
  refusals: LeakRefusal[];
  ledger: LedgerClaim[];
  changes: ContentChange[];
  siteUrl?: string;
  repoUrl?: string;
};

/**
 * The file name segment for a micro-category.
 *
 * The same fold the HTML pages use, so `/type/model-added.html` and
 * `/api/v1/events/model-added.json` are the same word. A consumer who sees one
 * can guess the other, which is most of what a documented API is.
 */
export function typeSlug(type: FeedType): string {
  return type.replace(/_/g, '-');
}

/**
 * THROWS when a micro-category's file name would collide with a pagination
 * file.
 *
 * `events/page-2.json` and `events/<type>.json` share one directory, so a
 * future event type spelled `page_2` would silently overwrite a page of the
 * stream with a category listing, on an address index.json publishes as stable.
 * Same refusal as the thread-slug collision in src/derive/threads.ts and for
 * the same reason: a build that stops is recoverable, a file serving the wrong
 * content under a documented address is not.
 */
export function assertPageNamesSafe(types: FeedType[]): void {
  for (const type of types) {
    if (typeSlug(type).startsWith('page-')) {
      throw new Error(`event type ${type} collides with the pagination file names in events/`);
    }
  }
}

/** `page-2.json` and up. Page 1 is events.json itself, which is the front door. */
export function pageFileName(page: number): string {
  return `page-${page}.json`;
}

/**
 * Two-space JSON with a trailing newline.
 *
 * Indented rather than minified on purpose: the whole product is that a person
 * can look at this and check it, and `curl … | head` has to be readable without
 * a JSON tool installed. Gzip on the wire removes almost all of the cost.
 */
function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function file(rel: string, value: unknown): SiteFile {
  return { path: `${API_PREFIX}/${rel}`, contents: json(value) };
}

/** The item records for one list, each carrying its own source's precision. */
function records(
  items: FeedItem[],
  precision: Map<string, number>,
  siteUrl: string,
  repoUrl: string,
): ItemRecord[] {
  return items.map((i) => itemRecord(i, precision.get(i.sourceId) ?? Infinity, siteUrl, repoUrl));
}

/**
 * Every file the API serves.
 *
 * THROWS through assertPageNamesSafe when a micro-category would take the name
 * of a pagination file.
 */
export function buildApi(input: ApiInput): SiteFile[] {
  const siteUrl = (input.siteUrl ?? SITE_URL).replace(/\/+$/, '');
  const repoUrl = input.repoUrl ?? REPO_URL;
  const { feed, threads, refusals, ledger, changes } = input;
  const precision = precisionBySource(changes);
  const files: SiteFile[] = [];

  assertPageNamesSafe(ALL_TYPES);

  // ---- the stream, paginated -------------------------------------------
  const all = records(feed, precision, siteUrl, repoUrl);
  const pageCount = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const pageUrls: string[] = [];
  for (let page = 1; page <= pageCount; page++) {
    pageUrls.push(page === 1 ? apiUrl(siteUrl, 'events.json') : apiUrl(siteUrl, `events/${pageFileName(page)}`));
  }
  for (let page = 1; page <= pageCount; page++) {
    const slice = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const body = {
      api_version: API_VERSION,
      page,
      page_size: PAGE_SIZE,
      pages: pageCount,
      total: all.length,
      // Both, always. A client that only ever follows `next` never has to know
      // how the pages are named, and one that wants page 7 does not have to
      // walk six pages to find its address.
      next: page < pageCount ? (pageUrls[page] ?? null) : null,
      page_urls: pageUrls,
      items: slice,
    };
    files.push(
      page === 1 ? file('events.json', body) : file(`events/${pageFileName(page)}`, body),
    );
  }

  // ---- one file per micro-category, empty ones included -----------------
  //
  // Emitted whether or not the archive holds any item of that type, for the
  // reason the HTML pages are: a category that vanished when it was empty would
  // make a quiet week and a broken extractor return the same 404.
  for (const type of ALL_TYPES) {
    const items = records(itemsOfType(feed, type), precision, siteUrl, repoUrl);
    files.push(
      file(`events/${typeSlug(type)}.json`, {
        api_version: API_VERSION,
        type,
        total: items.length,
        items,
      }),
    );
  }

  // ---- one file per lab that the archive actually carries ---------------
  //
  // Only labs present in the feed, unlike the types above, and the asymmetry is
  // deliberate: a type is a fact about this repository's derivations and its
  // absence is a statement we own, while an empty lab file is a claim to be
  // watching a lab we hold nothing on. index.json lists the labs that exist, so
  // a client can still tell an absent lab from a broken deploy without us
  // publishing a promise we are not keeping.
  const labs = labsInFeed(feed);
  for (const lab of labs) {
    const items = records(itemsOfLab(feed, lab), precision, siteUrl, repoUrl);
    files.push(
      file(`labs/${lab}.json`, { api_version: API_VERSION, lab, total: items.length, items }),
    );
  }

  // ---- one file per model thread ----------------------------------------
  const modelThreads = threadsOfKind(threads.threads, 'model');
  const threadSlugs = new Set(modelThreads.map((t) => t.slug));
  for (const thread of modelThreads) {
    files.push(
      file(`models/${thread.slug}.json`, {
        api_version: API_VERSION,
        entity: { kind: thread.entity.kind, id: thread.entity.id, label: thread.entity.label, slug: thread.slug },
        thread: `${siteUrl}/threads/${thread.slug}.html`,
        /*
         * NOT `first_seen`, WHICH IS THE ONE NAME THE SPEC FORBIDS.
         *
         * Section 10 of the collector design says it outright: "Not
         * `launched_at`, not `released_at`, not bare `first_seen`. A field named
         * `launched_at` will eventually be rendered as a launch date by
         * something downstream." This endpoint shipped `first_seen` on all 116
         * model documents anyway.
         *
         * The name mattered here more than usual, because the value is NOT the
         * catalogue's first-seen date. `first_seen_in_catalog_at` in models.json
         * is null on every model, because the measured worst-case error for that
         * source is 348,766 seconds against an 86,400 second gate. This field is
         * a different quantity: the origin_date of the EARLIEST EVENT on this
         * thread, which for most models is a price change and not an arrival.
         * Publishing that at second resolution under a name that reads as
         * "when this model first existed" is precisely the inference the whole
         * archive refuses to make, sitting in its own API.
         *
         * It is deliberately NOT routed through dayIfPermitted. The precision
         * gate governs when the archive first saw a MODEL; this is when the
         * archive recorded its first EVENT, which is an exact fact about our own
         * history and carries no error bar at all.
         */
        first_event_at: timestampView(thread.firstSeen),
        last_activity: timestampView(thread.lastActivity),
        total: thread.events.length,
        items: records(thread.events, precision, siteUrl, repoUrl),
      }),
    );
  }

  // ---- current catalog state --------------------------------------------
  const models = currentModels(changes, feed, siteUrl, threadSlugs, repoUrl);
  files.push(
    file('models.json', {
      api_version: API_VERSION,
      // Null rather than an empty list when the archive holds no capture of the
      // catalog at all. An empty `models` array would read as "OpenRouter lists
      // nothing", which is a claim about OpenRouter; null with a source of null
      // is a claim about this archive, which is the only one we can make.
      source: models === null ? null : models.source,
      total: models === null ? null : models.models.length,
      models: models === null ? [] : models.models,
    }),
  );

  // ---- current retirement floors ----------------------------------------
  const retirements = currentRetirements(changes, repoUrl);
  files.push(
    file('retirements.json', {
      api_version: API_VERSION,
      source: retirements === null ? null : retirements.source,
      total: retirements === null ? null : retirements.retirements.length,
      // Spelled out because it is the one join in this API and the boundary it
      // does not cross is the point of the whole entity model.
      namespace_note:
        'Model names here are the provider\'s own API model names, read from that provider\'s own document. They are not OpenRouter catalog ids and are not joined to them: the two are different strings issued by different parties, and deciding they name the same model is a judgement this archive does not make.',
      retirements: retirements === null ? [] : retirements.retirements,
    }),
  );

  // ---- the leaks desk -----------------------------------------------------
  const leakItems = records(
    feed.filter((i) => i.kind === 'leak'),
    precision,
    siteUrl,
    repoUrl,
  );
  const byTier: Record<string, number> = { 'confirmed-artifact': 0, credible: 0, unconfirmed: 0 };
  for (const item of leakItems) {
    if (item.tier !== null) byTier[item.tier] = (byTier[item.tier] ?? 0) + 1;
  }
  files.push(
    file('leaks.json', {
      api_version: API_VERSION,
      total: leakItems.length,
      by_tier: byTier,
      tier_note:
        'The tier is about the artifact, not about confidence. confirmed-artifact means a publicly observable artifact exists and is linked at the sha below.',
      accuracy: apiUrl(siteUrl, 'accuracy.json'),
      items: leakItems,
      // Refusals are published beside the items rather than counted, because a
      // signal that stopped parsing and a week with no reveals both produce
      // zero items, and the second is the failure this desk exists to surface.
      refusals: refusals.map((r) => refusalRecord(r, repoUrl)),
    }),
  );

  // ---- the public accuracy ledger ----------------------------------------
  files.push(
    file('accuracy.json', {
      api_version: API_VERSION,
      scorecard: scorecardRecord(scoreLedger(ledger)),
      accuracy_note:
        'accuracy_pct is confirmed over resolved. It is null, never zero and never a hundred, while nothing has resolved: a ledger with no resolved claims has no accuracy.',
      claims: ledger.map(claimRecord),
    }),
  );

  // ---- the directory ------------------------------------------------------
  const observations = observationsBySource(changes);
  const sources = [...new Set(changes.map((c) => c.sourceId))].sort().map((id) => {
    const newest = changes.find((c) => c.sourceId === id);
    const p = precisionView(precision.get(id) ?? Infinity);
    return {
      id,
      captures: observations.get(id)?.length ?? 0,
      latest_artifact: newest === undefined ? null : artifactPermalink(newest.sha, newest.path, repoUrl),
      latest_commit: newest === undefined ? null : commitPermalink(newest.sha, repoUrl),
      latest_timestamp: newest === undefined ? null : timestampView(newest.stamp),
      ...p,
    };
  });

  files.push(
    file('index.json', {
      api_version: API_VERSION,
      name: 'llm-catalog-archive',
      description:
        'A keyless static JSON API over a git archive of AI provider catalogs, documentation indexes and lifecycle tables. Every record links the raw artifact it was derived from, at the full sha of the commit that changed it.',
      site: siteUrl,
      repository: repoUrl,
      docs: `${siteUrl}/api.html`,
      terms: {
        auth: 'none',
        api_key: false,
        signup: false,
        rate_limit: 'none imposed by this project; GitHub Pages fair use applies',
        cors: 'served by GitHub Pages, which sends access-control-allow-origin: *',
        cost: 'free',
      },
      rules: [
        'Every record carries the artifact permalink at the full sha of the commit that changed it, never HEAD.',
        'Every timestamp is an object naming the field it came from: origin_date is the provider\'s own generation time, observed_at is this runner\'s clock at request completion.',
        'No date is emitted at a resolution finer than precision_seconds allows. first_seen_in_catalog_at is null wherever the measured worst-case error for that source is wider than a day.',
        'precision_seconds is null when unbounded, meaning the archive holds fewer than two captures of that source. Null is not zero error.',
        'Every sentence names an artifact as its subject. No record here says why a value changed.',
      ],
      counts: {
        items: feed.length,
        events: feed.filter((i) => i.kind === 'event').length,
        leaks: leakItems.length,
        models: models === null ? 0 : models.models.length,
        model_endpoints: modelThreads.length,
        threads: threads.threads.length,
        held: threads.held.length,
        labs: labs.length,
        retirements: retirements === null ? 0 : retirements.retirements.length,
        ledger_claims: ledger.length,
        refusals: refusals.length,
        pages: pageCount,
      },
      endpoints: {
        index: apiUrl(siteUrl, 'index.json'),
        models: apiUrl(siteUrl, 'models.json'),
        model: apiUrl(siteUrl, 'models/{slug}.json'),
        events: apiUrl(siteUrl, 'events.json'),
        events_page: apiUrl(siteUrl, 'events/page-{n}.json'),
        events_by_type: apiUrl(siteUrl, 'events/{type}.json'),
        lab: apiUrl(siteUrl, 'labs/{lab}.json'),
        leaks: apiUrl(siteUrl, 'leaks.json'),
        accuracy: apiUrl(siteUrl, 'accuracy.json'),
        retirements: apiUrl(siteUrl, 'retirements.json'),
      },
      // The literal lists, not just the templates above. This is what makes the
      // directory the authority: a client can tell an absent lab from a broken
      // deploy without guessing.
      types: ALL_TYPES.map((t) => ({ type: t, url: apiUrl(siteUrl, `events/${typeSlug(t)}.json`) })),
      labs: labs.map((l) => ({ lab: l, url: apiUrl(siteUrl, `labs/${l}.json`) })),
      pages: pageUrls,
      sources,
    }),
  );

  return files;
}
