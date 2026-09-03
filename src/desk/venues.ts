/**
 * WHERE one finding should go, not just which platforms could carry it.
 *
 * The desk used to offer every platform at once, which is the wrong shape for
 * the job twice over. Posting one item to six places is what a bot does and
 * what a community reads as spam, and more importantly it pushes the decision
 * back onto the reader: six buttons is not a recommendation, it is a menu.
 * A finding has one best home. This file says which.
 *
 * A VENUE IS A PLACE, NOT A PLATFORM. Reddit is not a destination; r/LocalLLaMA
 * is. The subreddit is the whole difference between a post that lands and one
 * that is removed inside an hour, so it is part of the address here rather than
 * something left to whoever is holding the phone.
 *
 * THESE ARE EDITORIAL JUDGEMENTS AND THEY ARE NOT VERIFIED FROM INSIDE THIS
 * REPOSITORY. Nothing here can read a subreddit's current rules, so every
 * routing decision below is a claim about an audience that can turn out to be
 * wrong, and the honest thing is to say so in the one place someone will look
 * when a post gets removed. What makes them correctable rather than folklore is
 * that meta/posted.jsonl records where each item actually went: after a few
 * dozen posts there is evidence, and this table should be revised against it
 * rather than against anyone's intuition, this file's author included.
 *
 * DELIBERATE OMISSIONS, which are as much of the routing as the inclusions:
 *   r/MachineLearning  removes news, product and catalogue posts; it is for
 *                      research, and sending a diff there wastes the item and
 *                      earns a strike.
 *   r/artificial       broad and low-engagement for this material.
 *   vendor subs beyond OpenAI and Anthropic are left out rather than guessed
 *                      at, because a subreddit that has been renamed sends the
 *                      post nowhere and the failure is silent. Those items fall
 *                      back to r/LocalLLaMA, which is a real audience for them.
 */

import type { FeedItem, FeedType } from '../derive/feed.js';
import { labFromVendor, providerFromSourceId, type Lab } from '../derive/entities.js';
import type { Platform } from './drafts.js';

/** A venue plus the reason this type belongs at it. */
export type RoutedVenue = Venue & { readonly why: string };

export type Venue = {
  /** Stable id. `reddit:LocalLLaMA`, `hn`, `bluesky`. Recorded in the ledger. */
  readonly id: string;
  readonly platform: Platform;
  /** What the button says: a place, not a platform. */
  readonly label: string;
  /** The subreddit, where the platform has locations. Null where it does not. */
  readonly sub: string | null;
  /** Why this audience, in one line, shown on the desk. */
  readonly fit: string;
};

export const VENUES: Record<string, Venue> = {
  'reddit:LocalLLaMA': {
    id: 'reddit:LocalLLaMA',
    platform: 'reddit',
    label: 'r/LocalLLaMA',
    sub: 'LocalLLaMA',
    fit: 'the most active technical audience for open-weight and frontier model news, and one that expects evidence rather than a claim',
  },
  'reddit:singularity': {
    id: 'reddit:singularity',
    platform: 'reddit',
    label: 'r/singularity',
    sub: 'singularity',
    fit: 'much larger and much less technical: reach at the cost of the comments being about implications rather than about the artifact',
  },
  'reddit:OpenAI': {
    id: 'reddit:OpenAI',
    platform: 'reddit',
    label: 'r/OpenAI',
    sub: 'OpenAI',
    fit: 'where the developers who have to act on an OpenAI change actually are',
  },
  'reddit:ClaudeAI': {
    id: 'reddit:ClaudeAI',
    platform: 'reddit',
    label: 'r/ClaudeAI',
    sub: 'ClaudeAI',
    fit: 'where the developers who have to act on an Anthropic change actually are',
  },
  hn: {
    id: 'hn',
    platform: 'hn',
    label: 'Hacker News',
    sub: null,
    fit: 'the highest-value audience and the least forgiving: only worth it when the finding stands on its own to a programmer who has never heard of the site',
  },
  bluesky: {
    id: 'bluesky',
    platform: 'bluesky',
    label: 'Bluesky',
    sub: null,
    fit: 'broadcast rather than discussion, and the only venue whose API permits posting without a person present',
  },
  mastodon: {
    id: 'mastodon',
    platform: 'mastodon',
    label: 'Mastodon',
    sub: null,
    fit: 'small but technical, and open in the same way this archive is',
  },
  x: { id: 'x', platform: 'x', label: 'X', sub: null, fit: 'reach, with almost no click-through to a page like this one' },
  linkedin: {
    id: 'linkedin',
    platform: 'linkedin',
    label: 'LinkedIn',
    sub: null,
    fit: 'the wrong audience for a catalogue diff; kept only because it costs nothing to offer',
  },
};

/** The vendor sub for a lab, where one is written down rather than guessed. */
const LAB_SUB: Partial<Record<Lab, string>> = {
  openai: 'reddit:OpenAI',
  anthropic: 'reddit:ClaudeAI',
};

/**
 * The lab a finding is about.
 *
 * Prefers the derived lab entity, which is normalized. Falls back to the source
 * id, because a status feed or a deprecations page names its provider in its id
 * even when the event carries no lab entity, and that is exactly the case for
 * the two types where vendor routing matters most.
 */
export function labOf(item: FeedItem): Lab | null {
  for (const entity of item.entities) {
    if (entity.kind === 'lab') {
      const bare = entity.id.startsWith('lab/') ? entity.id.slice(4) : entity.id;
      const lab = labFromVendor(bare);
      if (lab !== null) return lab;
    }
  }
  const provider = providerFromSourceId(item.sourceId);
  return provider === null ? null : labFromVendor(provider);
}

/**
 * One step of a route: where, and why THIS type belongs THERE.
 *
 * `why` is required rather than optional, so adding a route means stating a
 * reason. It also has to live here rather than on the venue: r/LocalLLaMA's own
 * description is about model news, and reusing it for a merged inference-engine
 * pull request produced a desk that told the reader a vLLM commit was
 * newsworthy because it was "an unreleased model sighting". The reason belongs
 * to the pairing, not to either half of it.
 */
type RouteStep = { readonly id: string; readonly why: string };

/**
 * Venues in preference order for a type, before eligibility is considered.
 *
 * `vendor` is a placeholder resolved against the item's lab, so that one row
 * covers "the sub for whoever this is about" without enumerating labs. It
 * disappears when there is no known sub, which is why every route that uses it
 * also names a real fallback.
 */
const ROUTES: Record<FeedType, readonly RouteStep[]> = {
  // An unreleased model spotted under a codename, with the bytes to prove it.
  // This is r/LocalLLaMA's core subject, and the evidence link is what makes it
  // a post there rather than a rumour.
  codename_unmasked: [
    { id: 'reddit:LocalLLaMA', why: 'a codename resolving to a real model id is that sub\'s core subject, and the diff is the evidence it asks for' },
    { id: 'hn', why: 'an unreleased model identified from a vendor\'s own bytes stands on its own to a programmer who has never heard of this site' },
    { id: 'bluesky', why: 'broadcast, once the discussion venues have had it' },
  ],
  codename_entered: [
    { id: 'reddit:LocalLLaMA', why: 'a new codename appearing is a lead that audience actively watches for' },
    { id: 'bluesky', why: 'broadcast, once the discussion venues have had it' },
  ],
  stealth_listing: [
    { id: 'reddit:LocalLLaMA', why: 'an unannounced model listed on a public endpoint is that sub\'s core subject' },
    { id: 'hn', why: 'a model shipped before it was announced is a story on its own terms' },
    { id: 'bluesky', why: 'broadcast, once the discussion venues have had it' },
  ],

  // A model appearing. Whose model decides the room.
  model_added: [
    { id: 'vendor', why: 'a new model from this lab matters first to the people already building on it' },
    { id: 'reddit:LocalLLaMA', why: 'the general audience for a model appearing in a catalogue' },
    { id: 'bluesky', why: 'broadcast, once the discussion venues have had it' },
  ],

  // A removal or a dated retirement floor is a migration someone has to do, so
  // it goes where the people who have to do it are, ahead of where the most
  // people are.
  model_removed: [
    { id: 'vendor', why: 'a removal is a migration somebody has to perform, so it goes where those people are before it goes where the most people are' },
    { id: 'reddit:LocalLLaMA', why: 'the general audience for a model disappearing from a catalogue' },
    { id: 'hn', why: 'worth the front page only when the model was widely depended on' },
    { id: 'bluesky', why: 'broadcast, once the discussion venues have had it' },
  ],
  retirement_floor: [
    { id: 'vendor', why: 'a dated shutdown is a deadline for this lab\'s users specifically, and the date comes from the vendor\'s own bytes' },
    { id: 'reddit:LocalLLaMA', why: 'the general audience for a retirement date' },
    { id: 'bluesky', why: 'broadcast, once the discussion venues have had it' },
  ],

  // Inference-engine work: that audience is r/LocalLLaMA almost by definition.
  upstream_pr_merged: [
    { id: 'reddit:LocalLLaMA', why: 'inference-engine work landing is that audience almost by definition: they run these engines' },
    { id: 'hn', why: 'worth it when the merge implies hardware or an architecture nobody has shipped yet' },
  ],
  upstream_pr_opened: [
    { id: 'reddit:LocalLLaMA', why: 'a pull request opened against an engine they run is a lead, not yet news' },
  ],

  // An outage matters to that vendor's users and to almost nobody else. HN
  // flags status-page submissions, so it is deliberately not offered.
  incident_opened: [
    { id: 'vendor', why: 'an outage matters to the people whose builds are failing right now and to almost nobody else' },
    { id: 'bluesky', why: 'broadcast, once the vendor\'s own audience has it' },
  ],

  // Everything else is archive telemetry, or a leak type the desk does not
  // offer. Every one is listed EXPLICITLY rather than defaulted, because the
  // Record is exhaustive over FeedType: adding a type without deciding where it
  // belongs is then a compile error here rather than an item that quietly
  // arrives on the desk with no venue and no button. That guarantee is the
  // reason for the empty arrays, and it already earned its keep once, catching
  // three type names in this table that do not exist.
  price_changed: [],
  context_changed: [],
  expiration_set: [],
  alias_retargeted: [],
  doc_added: [],
  doc_moved: [],
  doc_removed: [],
  post_listed: [],
  post_published: [],
  expiration_scheduled: [],
};

/**
 * Exposed so a test can check the TABLE rather than this function's output.
 *
 * It has to be, and the reason is worth writing down. venuesFor used to skip an
 * id it could not resolve, and a test that walked its results therefore could
 * not fail when a route named a venue that did not exist: the filter hid the
 * bug from the only test looking for it. A mutation pointing a route at
 * `reddit:DoesNotExist` stayed green through 42 tests.
 */
export const ROUTE_TABLE: Readonly<Record<FeedType, readonly RouteStep[]>> = ROUTES;

/** Every venue id any route can resolve to, `vendor` expanded. */
export function allRoutedVenueIds(): string[] {
  const ids = new Set<string>();
  for (const route of Object.values(ROUTES)) {
    for (const step of route) {
      if (step.id === 'vendor') {
        for (const sub of Object.values(LAB_SUB)) if (sub !== undefined) ids.add(sub);
      } else ids.add(step.id);
    }
  }
  return [...ids];
}

/**
 * Ordered, concrete venues for an item, vendor placeholders resolved.
 *
 * THROWS on a route naming a venue that is not in VENUES, rather than skipping
 * it. A bad id is a static mistake in a table three lines from the venue it
 * meant, and skipping it costs a whole type its audience with nothing thrown
 * and nothing logged: the same silent shape this project has already been
 * bitten by twice, once when a source suffix went unlisted and once when a
 * camera swap did not apply. Loud is cheaper.
 */
export function venuesFor(item: FeedItem): RoutedVenue[] {
  const route = ROUTES[item.type] ?? [];
  const lab = labOf(item);
  const out: RoutedVenue[] = [];
  const seen = new Set<string>();
  for (const step of route) {
    const id = step.id === 'vendor' ? (lab === null ? null : LAB_SUB[lab] ?? null) : step.id;
    if (id === null || seen.has(id)) continue;
    const venue = VENUES[id];
    if (venue === undefined) {
      throw new Error(`the route for ${item.type} names ${id}, which is not a venue in VENUES`);
    }
    seen.add(id);
    out.push({ ...venue, why: step.why });
  }
  return out;
}
