/**
 * Picking the one place to post, and being able to say why.
 *
 * The desk's job is to hand back a decision, not a menu. Six buttons put the
 * choice back on whoever is holding the phone at eight in the morning, which is
 * the moment they have the least information and the least patience; and the
 * temptation a menu creates is to press all of them, which is what a community
 * reads as spam and what actually costs the account.
 *
 * SO: one primary venue, the reason it was chosen, and the rest kept behind a
 * disclosure for when the recommendation is wrong. Never nothing: if the route
 * yields no eligible venue, the reason for that is returned instead, because
 * "no button" and "no explanation" are different failures and only one of them
 * is recoverable by the reader.
 *
 * ELIGIBILITY IS THE INTERESTING PART. A venue is dropped when the sentence
 * does not fit it, because a draft is never trimmed to fit (see drafts.ts), and
 * when the item has already gone there, because the ledger says so. Hacker
 * News therefore loses its slot most days on an 80 character title limit
 * against 150 character sentences, and the routing quietly falls through to the
 * next real audience rather than offering a button that cannot be pressed.
 */

import type { FeedItem } from '../derive/feed.js';
import { draftFor, PLATFORM_BY_ID, type Draft, type Shortfall } from './drafts.js';
import { venuesFor, type RoutedVenue } from './venues.js';

export type Recommendation = {
  /** The one venue to press. Null when nothing is eligible. */
  readonly primary: Draft | null;
  /** Why THIS type belongs at THAT venue, from the routing table. */
  readonly why: string | null;
  /** The rest, in preference order, for when the recommendation is wrong. */
  readonly others: readonly Draft[];
  /** Venues the sentence could not fit, with the shortfall. */
  readonly shortfalls: readonly Shortfall[];
  /** Present only when `primary` is null: which gate emptied the route. */
  readonly blocked: string | null;
};

/**
 * `posted` holds `<item id>::<venue id>` for everything already sent, so a
 * venue that has had this item is skipped and the next one is offered. It is
 * keyed on VENUE and not platform: an item that went to r/OpenAI has not been
 * to r/LocalLLaMA, and treating those as the same place would silently retire
 * a real audience after one post.
 */
export function recommend(
  item: FeedItem,
  siteUrl: string,
  posted: ReadonlySet<string> = new Set(),
): Recommendation {
  const venues = venuesFor(item);
  if (venues.length === 0) {
    return { primary: null, why: null, others: [], shortfalls: [], blocked: `no venue is routed for ${item.type}` };
  }

  const eligible: Draft[] = [];
  const shortfalls: Shortfall[] = [];
  let sent = 0;

  for (const venue of venues) {
    if (posted.has(`${item.id}::${venue.id}`)) {
      sent += 1;
      continue;
    }
    const spec = PLATFORM_BY_ID[venue.platform];
    const out = draftFor(item, spec, siteUrl, venue.id, venue.label, venue.sub);
    if ('need' in out) shortfalls.push(out);
    else eligible.push(out);
  }

  if (eligible.length === 0) {
    return {
      primary: null,
      why: null,
      others: [],
      shortfalls,
      blocked:
        sent === venues.length
          ? 'already posted everywhere it was routed'
          : 'the sentence fits none of the venues routed for this type',
    };
  }

  const [primary, ...others] = eligible;
  return { primary: primary!, why: fitOf(venues, primary!.venue), others, shortfalls, blocked: null };
}

function fitOf(venues: readonly RoutedVenue[], id: string): string | null {
  return venues.find((v) => v.id === id)?.why ?? null;
}
