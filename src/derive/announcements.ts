/**
 * The half of "AI news" the archive was collecting and throwing away.
 *
 * WHAT WAS MISSING. Every one of the 18 sources is a catalogue, a documentation
 * index, a sitemap, a status feed or a pull-request search, and the derivation
 * read only the first two kinds. So a developer asking what happened this week
 * got price changes and doc moves, which is API-surface news and not general
 * news, while two rich veins sat in the archive producing nothing:
 *
 *   anthropic-sitemap  439 URLs under /news/, /research/ and /engineering/
 *   claude-status      incidents like "Degraded performance on claude.ai and
 *   openai-status      Claude Code", already parsed by the change predicate
 *
 * Both are stored, both are diffable, and neither reached a page.
 *
 * NO MODEL, SAME RULES. Every sentence here is a fixed template filled from
 * values read out of the stored bytes, every third-party value is quoted, and
 * the subject is always an artifact. A sitemap carries no title, so a post event
 * quotes the URL and nothing else: inventing a headline from a slug is exactly
 * the inference this project refuses, and the URL is the fact.
 *
 * A BASELINE STILL EMITS NOTHING. Rule 2 holds: the first capture of a sitemap
 * with 439 news URLs is not 439 stories published today, it is one observation
 * that they exist. Only URLs that appear in a LATER capture are news.
 */

import { extractSitemapLoc } from '../predicate.js';

/** Which stored sources are announcement indexes, and what counts as a post. */
export const ANNOUNCEMENT_PATHS: Readonly<Record<string, readonly string[]>> = {
  'anthropic-sitemap': ['/news/', '/research/', '/engineering/'],
};

/** Which stored sources are incident feeds. */
export const INCIDENT_SOURCES: readonly string[] = ['claude-status', 'openai-status'];

export function isAnnouncementSource(sourceId: string): boolean {
  return Object.hasOwn(ANNOUNCEMENT_PATHS, sourceId);
}

export function isIncidentSource(sourceId: string): boolean {
  return INCIDENT_SOURCES.includes(sourceId);
}

/**
 * The announcement URLs in one sitemap, as a set.
 *
 * Filtered by path prefix, because a sitemap is the whole site: without this
 * every pricing page and legal notice would be filed as news. The prefixes are
 * derivation policy rather than collection config, so they live here and not in
 * meta/sources.json, which stays a description of what is FETCHED.
 */
export function announcementUrls(text: string, prefixes: readonly string[]): Set<string> {
  const out = new Set<string>();
  const locs = extractSitemapLoc(text);
  if (locs === '') return out;
  for (const url of locs.split('\n')) {
    if (url === '') continue;
    if (prefixes.some((p) => url.includes(p))) out.add(url);
  }
  return out;
}

export type IncidentEntry = { id: string; title: string; url: string; published: string | null };

const ENTRY_G = /<entry>([\s\S]*?)<\/entry>/g;
const ID_ONE = /<id>([^<]*)<\/id>/;
const TITLE_ONE = /<title[^>]*>([\s\S]*?)<\/title>/;
const PUBLISHED_ONE = /<published>([^<]*)<\/published>/;
const LINK_ONE = /<link[^>]*href="([^"]*)"/;

/**
 * Decode the five XML entities an Atom title can carry, and unwrap CDATA.
 *
 * CDATA is not decoration. openai-status wraps its titles in it, so without
 * this the published headline read
 * `<![CDATA[Elevated errors in ChatGPT conversations for Free and Go plans]]>`,
 * markers and all, on a site whose whole claim is that it prints what the
 * artifact says. Anthropic's feed does not wrap, so one provider looked fine
 * and the other did not.
 */
function unescapeXml(s: string): string {
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(s.trim());
  if (cdata !== null) return cdata[1] as string;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Every entry in an Atom incident feed. Entries with no id are skipped. */
export function incidentEntries(text: string): IncidentEntry[] {
  const out: IncidentEntry[] = [];
  for (const m of text.matchAll(ENTRY_G)) {
    const inner = m[1] ?? '';
    const id = ID_ONE.exec(inner)?.[1]?.trim() ?? '';
    if (id === '') continue;
    out.push({
      id,
      title: unescapeXml(TITLE_ONE.exec(inner)?.[1]?.trim() ?? ''),
      url: LINK_ONE.exec(inner)?.[1]?.trim() ?? '',
      published: PUBLISHED_ONE.exec(inner)?.[1]?.trim() ?? null,
    });
  }
  return out;
}
