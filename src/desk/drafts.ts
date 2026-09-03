/**
 * Turning one scored item into the text of a post.
 *
 * THE ONE RULE: THIS FILE NEVER REWRITES A CLAIM. The sentence a draft carries
 * is the sentence the deriving module already wrote, byte for byte, or there is
 * no draft. It is not shortened to fit, not rephrased to sound punchier, and
 * not summarised. Everything else in this project spends effort making sure a
 * sentence says exactly what the stored bytes support, and a paraphrase at the
 * last step would throw all of it away in the one place where the claim travels
 * furthest from its evidence.
 *
 * WHY NOT JUST TRUNCATE. Because prefix truncation can invert a claim, not only
 * weaken it: "no models were removed from the catalogue" cut to fit becomes "no
 * models were removed". There is no length limit at which that is safe, so the
 * limit is enforced by refusing rather than by cutting. A platform whose limit
 * the sentence cannot meet gets `null`, the desk shows the shortfall, and a
 * human writes the title if they want one. That is the correct division: a
 * machine must not re-word a factual claim, and a person may.
 *
 * The link always points at the change page for the capture, because that page
 * shows the diff. The whole proposition is that a reader can check us, so the
 * post links to the evidence and not to the front door.
 */

import type { FeedItem } from '../derive/feed.js';
import { changePagePath } from '../site/record.js';

export type Platform = 'hn' | 'reddit' | 'bluesky' | 'mastodon' | 'x' | 'linkedin';

/**
 * `titleLimit` is for platforms that post a headline plus a URL field; `total`
 * is for platforms where the link is part of the body and costs characters.
 * `auto` records whether a machine may submit this without a human at the
 * keyboard, which is a rules question and not a technical one: see POSTING.md.
 */
export type PlatformSpec = {
  readonly id: Platform;
  readonly name: string;
  readonly titleLimit: number | null;
  readonly total: number | null;
  readonly auto: boolean;
};

export const PLATFORMS: readonly PlatformSpec[] = [
  { id: 'hn', name: 'Hacker News', titleLimit: 80, total: null, auto: false },
  { id: 'reddit', name: 'Reddit', titleLimit: 300, total: null, auto: false },
  { id: 'bluesky', name: 'Bluesky', titleLimit: null, total: 300, auto: true },
  { id: 'mastodon', name: 'Mastodon', titleLimit: null, total: 500, auto: true },
  { id: 'x', name: 'X', titleLimit: null, total: 280, auto: false },
  { id: 'linkedin', name: 'LinkedIn', titleLimit: null, total: 3000, auto: false },
];

export type Draft = {
  readonly platform: Platform;
  /** The headline field, where the platform has one. Always the sentence. */
  readonly title: string | null;
  /** The body actually submitted, where the link rides inside the text. */
  readonly text: string | null;
  readonly url: string;
  /** A prefilled compose page, so approving is one tap and not a copy-paste. */
  readonly submitUrl: string | null;
};

/** Why a platform got no draft, in the form a human can act on. */
export type Shortfall = { readonly platform: Platform; readonly need: number; readonly limit: number };

export function changeUrl(item: FeedItem, siteUrl: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/${changePagePath(item.sha)}`;
}

/**
 * Bluesky and Mastodon count the link's characters in the body, so the budget
 * is the sentence plus a blank line plus the URL. Nothing is elided to make it
 * fit; this only reports what the body would be.
 */
function body(sentence: string, url: string): string {
  return `${sentence}\n\n${url}`;
}

export function draftFor(item: FeedItem, spec: PlatformSpec, siteUrl: string): Draft | Shortfall {
  const url = changeUrl(item, siteUrl);
  const sentence = item.sentence;

  if (spec.titleLimit !== null) {
    if (sentence.length > spec.titleLimit) {
      return { platform: spec.id, need: sentence.length, limit: spec.titleLimit };
    }
    return { platform: spec.id, title: sentence, text: null, url, submitUrl: submitUrl(spec.id, sentence, url) };
  }

  const text = body(sentence, url);
  if (spec.total !== null && text.length > spec.total) {
    return { platform: spec.id, need: text.length, limit: spec.total };
  }
  return { platform: spec.id, title: null, text, url, submitUrl: submitUrl(spec.id, text, url) };
}

/**
 * A compose page with the fields already filled. These are the platforms' own
 * documented share endpoints, so nothing here impersonates a client or posts
 * behind a login: the human lands on a submit form and presses the button.
 * Mastodon has no host-independent intent URL, so it gets none.
 */
export function submitUrl(platform: Platform, text: string, url: string): string | null {
  const t = encodeURIComponent(text);
  const u = encodeURIComponent(url);
  switch (platform) {
    case 'hn':
      return `https://news.ycombinator.com/submitlink?u=${u}&t=${t}`;
    case 'reddit':
      return `https://www.reddit.com/submit?url=${u}&title=${t}`;
    case 'x':
      return `https://x.com/intent/post?text=${t}`;
    case 'bluesky':
      return `https://bsky.app/intent/compose?text=${t}`;
    case 'linkedin':
      return `https://www.linkedin.com/sharing/share-offsite/?url=${u}`;
    case 'mastodon':
      return null;
  }
}

export type DraftSet = { readonly drafts: readonly Draft[]; readonly shortfalls: readonly Shortfall[] };

export function draftsFor(item: FeedItem, siteUrl: string): DraftSet {
  const drafts: Draft[] = [];
  const shortfalls: Shortfall[] = [];
  for (const spec of PLATFORMS) {
    const out = draftFor(item, spec, siteUrl);
    if ('need' in out) shortfalls.push(out);
    else drafts.push(out);
  }
  return { drafts, shortfalls };
}
