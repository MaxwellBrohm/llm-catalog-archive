/**
 * The change predicate: the gate between a healthy response and a commit.
 *
 * R1 governs what is written; this module governs WHETHER to write. It may
 * look inside the response, and the bytes it lets through are still the bytes
 * that arrived. R4 is the rule that makes that legal, and it is the only
 * reason five sources can be archived at all: under a byte predicate each
 * commits a full blob on every run, forever, into a history R7 forbids
 * rewriting.
 *
 * Pure by construction. No filesystem, no network, no clock. Every projection
 * here is a total function of the response bytes.
 *
 * A projection is a string. Two responses are "the same" when their
 * projections are equal, so every extractor's job is to throw away exactly the
 * per-request noise and keep everything that could be content. Throwing away
 * too much is the dangerous direction: a projection that collapses to a
 * constant reports "no change" forever and the source goes silently dark.
 * That is what the arena record floor exists to catch.
 */

import type { Source } from './config.js';

export type Projection = { ok: true; key: string } | { ok: false; reason: string };

/**
 * Below this many records the arena payload is not the leaderboard any more.
 *
 * It is an undocumented Next.js flight payload and it will change shape
 * without notice. When it does, the record regexes match nothing, the
 * projection is the empty string on every run, and the predicate reports "no
 * change" for ever while the leaderboard ships model after model. A floor
 * turns that silent failure into a loud one. 817 records were observed live;
 * 500 is a floor well under it and far above zero.
 */
export const ARENA_MIN_RECORDS = 500;

/**
 * A `lastmod` this many URLs deep is a build stamp, not an edit.
 *
 * Measured on www.anthropic.com/sitemap.xml: 25 of 522 URLs carried one
 * identical millisecond stamp that oscillated between two edge generations
 * four minutes apart, while every other value held still. A real single-page
 * edit does not arrive on 25 pages at the same millisecond.
 */
export const SHARED_LASTMOD_FLOOR = 3;

/** Namespace prefixes are stripped everywhere: `<sitemap:loc>` is a loc. */
const NS = '(?:[A-Za-z_][\\w.-]*:)?';

/**
 * One element of this name, with its inner text in group 1.
 *
 * A self-closing `<entry/>` matches too, and then group 1 is undefined rather
 * than empty. That distinction is the point: `<loc/>` is a URL element with no
 * URL in it and is dropped, while a self-closing `<entry/>` is still an entry
 * and is still counted. `src/health.ts` counts self-closing feed items for the
 * same reason, and a predicate that disagreed with the health check about what
 * an entry is would be a quiet way for the two to drift.
 */
const tagRe = (name: string, flags: string): RegExp =>
  new RegExp(`<${NS}${name}(?:\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</${NS}${name}\\s*>)`, flags);

const LOC_G = tagRe('loc', 'g');
const URL_G = tagRe('url', 'g');
const ENTRY_G = tagRe('entry', 'g');
const LOC_ONE = tagRe('loc', '');
const LASTMOD_ONE = tagRe('lastmod', '');
const ID_ONE = tagRe('id', '');
const UPDATED_ONE = tagRe('updated', '');
const LI_G = /<li\b[^>]*>([\s\S]*?)<\/li\s*>/g;

const first = (re: RegExp, text: string): string | null => {
  const m = re.exec(text);
  return m === null || m[1] === undefined ? null : m[1].trim();
};

/**
 * `arena-leaderboard`: the record tuples, and nothing else.
 *
 * Three regions of this page are per-request by construction and none of them
 * is content: a provisional `userId` UUIDv7 whose embedded millisecond
 * timestamp decodes to the fetch instant, a 37-to-41 key `posthogFlags` map
 * that re-rolls because the visitor is anonymous, and a
 * `window.__CF$cv$params` blob carrying the response's own `cf-ray` and clock.
 * A mask over the first leaves the bodies unequal; a mask over all three rots
 * the moment arena ships another experiment, because it is keyed on flag
 * names. Projecting the records is stable against both.
 *
 * The payload is JSON escaped inside JS string literals, at a nesting depth
 * that varies by which flight chunk a record lands in, so every quote below is
 * written `\\?"` rather than unescaping the document first. Records are
 * delimited by their own leading key, which bounds each field search to one
 * record and makes the projection independent of field order.
 *
 * Both spellings are accepted because the payload carries both: leaderboard
 * entries key on `modelKey`/`modelDisplayName`, the model picker on
 * `publicName`/`displayName`.
 *
 * Sorted, because record ORDER is exactly the kind of thing an anonymous
 * request can permute, and nothing is lost: rank is recoverable from rating.
 */
export type ArenaRow = { name: string; display: string; rating: string; votes: string };

/**
 * The record tuples in an arena payload, in payload order.
 *
 * Split out of extractArena so the predicate and the leaks desk read the SAME
 * parser. Two parsers over one undocumented framework payload is two things to
 * notice breaking, and the one that breaks silently is the one nobody is
 * watching: the predicate would report "no change" for ever while the desk
 * reported no reveals, and both would look like a quiet week.
 *
 * BOTH SPELLINGS ARE ACCEPTED because the payload carries both: leaderboard
 * entries key on `modelKey`/`modelDisplayName`, the model picker on
 * `publicName`/`displayName`. `keyed` records which one delimited the record,
 * because the codename map is a claim about the PICKER's pair specifically and
 * a leaderboard row is not the same artifact.
 *
 * EVERY QUOTE IS WRITTEN `\\?"` RATHER THAN UNESCAPING THE DOCUMENT FIRST. The
 * payload is JSON escaped inside JS string literals at a nesting depth that
 * varies by which flight chunk a record lands in, and the bare form matches
 * zero times: an implementer who writes `"publicName":"` sees an empty
 * leaderboard rather than a bug.
 */
export function arenaRows(text: string, keyed: 'any' | 'publicName' = 'any'): ArenaRow[] {
  const splitter =
    keyed === 'publicName' ? /\\?"publicName\\?":\\?"/ : /\\?"(?:modelKey|publicName)\\?":\\?"/;
  const displayRe =
    keyed === 'publicName'
      ? /\\?"displayName\\?":\\?"([^"\\]*)/
      : /\\?"(?:modelDisplayName|displayName)\\?":\\?"([^"\\]*)/;

  const rows: ArenaRow[] = [];
  for (const chunk of text.split(splitter).slice(1)) {
    rows.push({
      name: /^([^"\\]*)/.exec(chunk)![1]!,
      display: displayRe.exec(chunk)?.[1] ?? '',
      rating: /\\?"rating\\?":(-?\d+(?:\.\d+)?)/.exec(chunk)?.[1] ?? '',
      votes: /\\?"votes\\?":(\d+)/.exec(chunk)?.[1] ?? '',
    });
  }
  return rows;
}

export function extractArena(text: string): Projection {
  const rows = arenaRows(text).map((r) => `${r.name}\t${r.display}\t${r.rating}\t${r.votes}`);

  if (rows.length < ARENA_MIN_RECORDS) {
    return { ok: false, reason: `arena projection found ${rows.length} records, floor is ${ARENA_MIN_RECORDS}` };
  }
  return { ok: true, key: rows.sort().join('\n') };
}

/**
 * A markdown table row: a line whose first non-space character is a pipe.
 *
 * Anchored, and the anchor is load bearing in both directions. Without `^` a
 * sentence containing a pipe joins the table block beside it and gets sorted
 * into it. Without allowing leading space an indented table stops being a
 * table at all and its rows never get sorted, which silently returns that
 * table to committing its own permutation.
 */
const isTableRow = (line: string): boolean => /^\s*\|/.test(line);

/**
 * A markdown delimiter row: pipes, colons, spaces and at least one dash.
 *
 * The dash is what separates `| --- | --- |` from a data row of empty cells.
 * Without it `| | |` reads as a delimiter and the row below it stops being
 * sorted, which is a silent hole in exactly one table.
 */
const isDelimiterRow = (line: string): boolean => /^\s*\|[\s:|-]*\|\s*$/.test(line) && line.includes('-');

/**
 * `xai-llms-txt`: table rows sorted WITHIN each table block.
 *
 * The rows re-permute per request, so `bytes` commits 1.46 MB of pure
 * permutation daily and `mask` cannot express it at all, because a reordering
 * is not a substring. Sorting in the deriver cannot fix it either: the deriver
 * only sees what was committed and this decision is upstream of that.
 *
 * Within blocks, never over the whole file. Sorting the file would make a
 * legitimate section reorder invisible, and the measured volatility is
 * adjacent row swaps inside two pricing tables, not a document-wide shuffle.
 * A block's header and delimiter rows keep their positions, so a renamed
 * column is still a change.
 */
export function extractXai(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];

  let i = 0;
  while (i < lines.length) {
    if (!isTableRow(lines[i]!)) {
      out.push(lines[i]!);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && isTableRow(lines[j]!)) j++;
    const block = lines.slice(i, j);
    const fixed = block.length >= 2 && isDelimiterRow(block[1]!) ? 2 : 0;
    out.push(...block.slice(0, fixed), ...block.slice(fixed).sort());
    i = j;
  }
  return out.join('\n');
}

/**
 * `openrouter-sitemap`: the `<loc>` set.
 *
 * Rebuilt several times a day (`max-age=0, must-revalidate`, `cf-cache-status:
 * DYNAMIC`), rewriting roughly a hundred `<lastmod>` values per rebuild with
 * no content behind them. The URL set is what this source is for.
 */
export function extractSitemapLoc(text: string): string {
  return [...text.matchAll(LOC_G)]
    .flatMap((m) => (m[1] === undefined ? [] : [m[1].trim()]))
    .sort()
    .join('\n');
}

/**
 * `anthropic-sitemap`: the `<loc>` set PLUS each URL's `lastmod`, minus the
 * build stamps.
 *
 * `sitemapLoc` would work here and would be wrong. Keying on the URL set alone
 * reduces this source to add/remove detection, and its per-URL `lastmod` is
 * the thing that makes an EDIT to an existing page detectable at all.
 *
 * So the noise is removed at the value level instead: any `lastmod` shared by
 * three or more URLs at the same millisecond is dropped, which is the
 * shared-timestamp anomaly rule applied at predicate level. The 24-to-25
 * oscillating values share one stamp and vanish; an edit to one page keeps its
 * own.
 */
export function extractSitemapDated(text: string): string {
  const urls: { loc: string; lastmod: string }[] = [];

  for (const m of text.matchAll(URL_G)) {
    const inner = m[1]!;
    const loc = first(LOC_ONE, inner);
    if (loc === null) continue;
    urls.push({ loc, lastmod: first(LASTMOD_ONE, inner) ?? '' });
  }

  const shared = new Map<string, number>();
  for (const u of urls) {
    if (u.lastmod !== '') shared.set(u.lastmod, (shared.get(u.lastmod) ?? 0) + 1);
  }

  return urls
    .map((u) => `${u.loc}\t${(shared.get(u.lastmod) ?? 0) >= SHARED_LASTMOD_FLOOR ? '' : u.lastmod}`)
    .sort()
    .join('\n');
}

/**
 * `openai-status`: each entry's id, its `updated`, and its component list
 * SORTED.
 *
 * Two things move per generation and neither is an incident: the feed-level
 * `<updated>` re-stamps, and the affected-component list inside every entry is
 * permuted. Sorting the component list kills the permutation while leaving a
 * component APPEARING or VANISHING visible, which is the quiet withdrawal a
 * status feed exists to leak. Dropping the list entirely would be cheaper and
 * would throw that away.
 *
 * The feed-level `<updated>` is outside every `<entry>` and so is never read
 * here. Entries are sorted for the same reason their components are.
 */
export function extractAtomStatus(text: string): string {
  const rows: string[] = [];

  for (const m of text.matchAll(ENTRY_G)) {
    const inner = m[1] ?? '';
    const id = first(ID_ONE, inner) ?? '';
    const updated = first(UPDATED_ONE, inner) ?? '';
    const components = [...inner.matchAll(LI_G)].map((c) => c[1]!.trim()).sort();
    rows.push(`${id}\t${updated}\t${components.join('|')}`);
  }
  return rows.sort().join('\n');
}

/**
 * `transformers-pulls` and `vllm-pulls`: the pull-request tuples, sorted.
 *
 * `bytes` is wrong here and would be wrong quietly. GitHub's search payload
 * carries four things that move with no pull request changing: every item's
 * `score` is a relevance float recomputed per query, `updated_at` advances on a
 * comment or a label, `reactions` counts every thumbs-up, and `total_count`
 * moves as unrelated pull requests match the query. A daily `bytes` predicate
 * would commit roughly 650 KB of that per repository per day into a history R7
 * forbids rewriting, and none of it is the signal.
 *
 * WHAT IS PROJECTED IS EXACTLY WHAT THE LEAKS DESK READS: the number, the
 * title, the state, and `merged_at`. So a commit happens when and only when a
 * pull request enters the window, changes title, closes, or merges, which are
 * the four transitions the desk can make a claim about.
 *
 * `merged_at` is projected because `state` cannot stand in for it. A closed
 * pull request is abandoned or merged and the search payload distinguishes
 * them; keying on `state` alone would make an abandoned attempt and a landed
 * runtime commit the same event.
 *
 * A body that is not `{ items: [...] }` projects to the empty string and IS
 * reported as a change against a stored projection, which is the loud failure:
 * the health check already requires `items` for these sources, so bytes that
 * reach here without it were committed in violation of an invariant.
 */
export function extractGithubPulls(text: string): Projection {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'github pulls projection: body is not valid JSON' };
  }
  const items = (json as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) {
    return { ok: false, reason: 'github pulls projection: body has no `items` array' };
  }

  const rows = items.map((raw) => {
    const it = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const pr = (typeof it['pull_request'] === 'object' && it['pull_request'] !== null
      ? it['pull_request']
      : {}) as Record<string, unknown>;
    const merged = typeof pr['merged_at'] === 'string' ? pr['merged_at'] : '';
    return `${String(it['number'] ?? '')}\t${String(it['title'] ?? '')}\t${String(it['state'] ?? '')}\t${merged}`;
  });
  return { ok: true, key: rows.sort().join('\n') };
}

/**
 * Replace every match of every declared pattern with one fixed marker.
 *
 * A marker rather than the empty string, so two masked regions that happen to
 * be adjacent cannot fuse into a third thing, and so a region that appears in
 * one response and not the other still registers as a difference.
 *
 * Compiled `gm`: global because a pattern that matched once would otherwise
 * leave its later occurrences in place, multiline because these patterns
 * describe LINES of a feed and `^` has to mean start-of-line for that to be
 * sayable.
 */
export function applyMask(text: string, patterns: string[]): string {
  let out = text;
  for (const p of patterns) out = out.replace(new RegExp(p, 'gm'), '\u0000masked\u0000');
  return out;
}

/**
 * An announcement feed: the set of post links, sorted, and nothing else.
 *
 * `bytes` is wrong here and would be wrong DAILY. openai-news-feed carries a
 * channel-level `<lastBuildDate>` that re-stamps on every rebuild, so a bytes
 * predicate would commit 700 KB on every run into a history that is never
 * rewritten, for a feed whose posts had not changed. Two fetches 15 seconds
 * apart were byte-identical, which is evidence about one cache generation and
 * says nothing about tomorrow's rebuild.
 *
 * The LINK set rather than the guid set: RSS guids are optional, and a CMS
 * migration rewrites them while the posts stay the same. Titles are excluded
 * too, so a provider correcting a typo in a headline is stored but is not a
 * second story.
 */
export function extractFeedPosts(text: string): string {
  const links = new Set<string>();
  for (const m of text.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const link = /<link>([^<]*)<\/link>/.exec(m[1] ?? '')?.[1]?.trim();
    if (link !== undefined && link !== '') links.add(link);
  }
  for (const m of text.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const link = /<link[^>]*href="([^"]*)"/.exec(m[1] ?? '')?.[1]?.trim();
    if (link !== undefined && link !== '') links.add(link);
  }
  return [...links].sort().join('\n');
}

const EXTRACTORS = {
  arena: extractArena,
  xai: (t: string): Projection => ({ ok: true, key: extractXai(t) }),
  sitemapLoc: (t: string): Projection => ({ ok: true, key: extractSitemapLoc(t) }),
  sitemapDated: (t: string): Projection => ({ ok: true, key: extractSitemapDated(t) }),
  atomStatus: (t: string): Projection => ({ ok: true, key: extractAtomStatus(t) }),
  feedPosts: (t: string): Projection => ({ ok: true, key: extractFeedPosts(t) }),
  githubPulls: extractGithubPulls,
} as const;

/** What this source's predicate compares. */
export function project(source: Source, bytes: Uint8Array): Projection {
  const p = source.predicate;
  if (p.type === 'bytes') return { ok: true, key: new TextDecoder('utf-8', { fatal: false }).decode(bytes) };

  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (p.type === 'mask') {
    try {
      return { ok: true, key: applyMask(text, p.patterns) };
    } catch (e) {
      return { ok: false, reason: `mask pattern failed: ${String(e instanceof Error ? e.message : e)}` };
    }
  }
  return EXTRACTORS[p.extractor](text);
}

export type ChangeVerdict = { ok: true; changed: boolean } | { ok: false; reason: string };

/**
 * Whether these bytes are a change against the stored snapshot.
 *
 * Byte equality short-circuits ahead of every projection, and that is a
 * correctness statement as well as a speed one: equal bytes project equally
 * under every predicate in this file, so the short circuit can never disagree
 * with the long path. It is also what keeps a 5 MB body off the regex engine
 * on the overwhelmingly common no-change run.
 *
 * No stored snapshot means SEED, which is a change: the first fetch is what
 * creates the baseline every later run is measured against.
 *
 * A projection that fails is NOT reported as "unchanged". Unchanged is the
 * answer that lets a broken extractor sit silently on a live source for
 * months, so the failure is handed up for the caller to treat as a failure.
 */
export function changedUnderPredicate(
  source: Source,
  next: Uint8Array,
  prev: Uint8Array | null,
): ChangeVerdict {
  if (prev === null) return { ok: true, changed: true };

  if (next.byteLength === prev.byteLength) {
    let same = true;
    for (let i = 0; i < next.byteLength; i++) {
      if (next[i] !== prev[i]) {
        same = false;
        break;
      }
    }
    if (same) return { ok: true, changed: false };
  }

  if (source.predicate.type === 'bytes') return { ok: true, changed: true };

  const a = project(source, next);
  if (!a.ok) return a;
  const b = project(source, prev);
  if (!b.ok) return b;
  return { ok: true, changed: a.key !== b.key };
}
