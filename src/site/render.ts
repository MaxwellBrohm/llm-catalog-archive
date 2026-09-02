/**
 * Every page, as a pure function of ChangeRecords and of the events derived
 * from them. No git, no fs, no clock.
 *
 * THE COPY RULE THIS FILE IMPLEMENTS. The subject of every sentence is the
 * artifact, never the company and never the reason. "OpenAI's documentation
 * index removed 6 entries" is renderable; "OpenAI deprecated the Assistants
 * API" is not. Nothing here summarises, groups by theme, or explains. Every
 * number on every page is read off a diff or a sidecar, so a changelog built
 * from `git log` has no model anywhere in it and auto-publishes by the
 * publishing gate's own rule: who composed the sentence.
 *
 * If a sentence appears here that a diff cannot justify, it is a bug.
 */

import { canRenderAt, DAY_SECONDS, type DerivedEvent } from '../derive/events.js';
import { entitySlug } from '../derive/entities.js';
import { quoteValue } from '../derive/quoting.js';
import type { Lab } from '../derive/entities.js';
import {
  ALL_TYPES,
  countsByType,
  feedItemFromLeak,
  itemsOfLab,
  itemsOfType,
  labsInFeed,
  labsOf,
  type FeedItem,
  type FeedType,
} from '../derive/feed.js';
import {
  confirmationQuery,
  modelSupportName,
  PULL_SOURCE_IDS,
  type LeakItem,
  type LeakRefusal,
} from '../derive/leaks.js';
import { scoreLedger, type LedgerClaim } from './ledger.js';
import { countEmails, redactLine } from './redact.js';
import { wallHtml, jsonIsland, WALL_JS_PATH } from './wall.js';
import { FILTER_JS_PATH } from './filter-js.js';
import type { Thread, ThreadSet } from '../derive/threads.js';
import {
  artifactPermalink,
  changePagePath,
  CLI_NAME,
  commitPermalink,
  escapeHtml,
  formatInt,
  formatUtc,
  isArtifactRetracted,
  recordStamp,
  REPO_SLUG,
  REPO_URL,
  SITE_URL,
  sourcePagePath,
  stampFor,
  threadPagePath,
  THREADS_INDEX_PATH,
  utcDay,
  MAX_DIFF_LINES,
  MAX_LINE_CHARS,
  type ArtifactChange,
  type ChangeRecord,
  type SidecarView,
  type Stamp,
} from './record.js';

// Re-exported rather than moved outright: the address itself belongs beside
// the other page addresses in record.ts, but build.ts and the thread tests have
// always imported it from here, and a permalink's module of origin is not worth
// churning callers over.
export { threadPagePath, THREADS_INDEX_PATH };

/** Relative prefixes, so a page at any depth links the same targets. */
function links(depth: number): { up: string } {
  return { up: '../'.repeat(depth) };
}

function plural(n: number, word: string): string {
  return `${formatInt(n)} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Which section of the publication a page belongs to.
 *
 * The sections are the product design's section 5, and they are one
 * publication rather than four products: Everything is the front page and the
 * default view, the desk and the changelog are two ways of reading the same
 * derivations, and Threads is the entity archive both of them link into.
 */
export type Section = 'everything' | 'leaks' | 'changelog' | 'threads' | 'api' | 'about';

const NAV: { key: Section; href: string; label: string }[] = [
  { key: 'everything', href: 'index.html', label: 'Everything' },
  { key: 'leaks', href: 'leaks/index.html', label: 'Rumors and leaks' },
  { key: 'changelog', href: 'changelog/index.html', label: 'Changelog' },
  { key: 'threads', href: 'threads/index.html', label: 'Threads' },
  { key: 'api', href: 'api.html', label: 'API and CLI' },
  { key: 'about', href: 'about.html', label: 'About' },
];

/**
 * A one-line summary of a page, for the description meta and the share card.
 *
 * TAKEN FROM THE PAGE'S OWN LEDE, never composed. The lede is already a
 * template filled from the derivation, so using it here adds no sentence this
 * project did not already publish under its own byline, and the copy rule that
 * governs it governs this. HTML is stripped rather than escaped-through,
 * because a meta content attribute cannot carry markup.
 *
 * Truncated on a word boundary at 300 characters. A description longer than
 * that is cut by every consumer anyway, and cutting it here means the cut
 * happens somewhere chosen rather than mid-entity.
 */
export function pageDescription(body: string, fallback: string): string {
  const lede = /<p class="lede">([\s\S]*?)<\/p>/.exec(body)?.[1];
  const text = (lede ?? fallback)
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= 300) return text;
  const cut = text.slice(0, 300);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 200 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

function layout(opts: {
  title: string;
  depth: number;
  body: string;
  active?: Section;
  /** The page's own address, so a share card can name it. Root-relative. */
  canonical?: string;
  /**
   * Feeds this page in particular offers, beyond the two every page carries.
   * A category page that publishes a feed and does not advertise it is a feed
   * only somebody reading the directory listing would find.
   */
  feeds?: { href: string; title: string }[];
  /**
   * Load the client-side filter on this page. Off by default: a page with one
   * short table gains nothing from a filter box, and the script itself refuses
   * to build one for a table under two rows.
   */
  filterable?: boolean;
}): string {
  const { up } = links(opts.depth);
  /*
   * SHARE AND INDEX METADATA. 494 pages carried none: no description, no
   * og:title, no twitter card. Nothing unfurled as nothing, because consumers
   * fall back to <title>, but every single link in every chat and every feed
   * reader showed the same six words, so a thread page about one model and the
   * leaks desk were indistinguishable before you clicked.
   *
   * No og:image. There is no image to point at, and a card promising one that
   * 404s is worse than a card without one.
   */
  const description = pageDescription(opts.body, 'A byte-level archive of what model providers publish, with every claim linked to the bytes it came from.');
  const canonical = opts.canonical === undefined ? null : `${SITE_URL}/${opts.canonical}`;
  const nav = NAV.map(
    (n) =>
      `<a${n.key === opts.active ? ' class="on" aria-current="page"' : ''} href="${up}${n.href}">${escapeHtml(n.label)}</a>`,
  ).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<meta name="description" content="${escapeHtml(description)}">
${canonical === null ? '' : `<link rel="canonical" href="${escapeHtml(canonical)}">\n`}<meta property="og:type" content="website">
<meta property="og:site_name" content="llm-catalog-archive">
<meta property="og:title" content="${escapeHtml(opts.title)}">
<meta property="og:description" content="${escapeHtml(description)}">
${canonical === null ? '' : `<meta property="og:url" content="${escapeHtml(canonical)}">\n`}<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${escapeHtml(opts.title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<link rel="icon" href="${up}favicon.svg" type="image/svg+xml">
<link rel="alternate icon" href="${up}favicon.ico" sizes="32x32">
<link rel="apple-touch-icon" href="${up}apple-touch-icon.png">
<link rel="stylesheet" href="${up}style.css">
<link rel="alternate" type="application/rss+xml" title="llm-catalog-archive: everything" href="${up}${EVERYTHING_FEED_PATH}">
<link rel="alternate" type="application/rss+xml" title="llm-catalog-archive: changelog" href="${up}feed.xml">
${(opts.feeds ?? []).map((f) => `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(f.title)}" href="${up}${escapeHtml(f.href)}">`).join('\n')}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-head"><div class="wrap">
<a class="brand" href="${up}index.html">llm-catalog-archive</a>
<nav>
${nav}
</nav>
<div class="util">
<a href="${up}${EVERYTHING_FEED_PATH}">RSS</a>
<a href="${REPO_URL}">Repository</a>
</div>
</div></header>
<main id="main"><div class="wrap">
${opts.body}
</div></main>
${opts.filterable === true ? `<script src="${up}${FILTER_JS_PATH}" defer></script>\n` : ''}<footer class="site-foot"><div class="wrap">
<p>Generated at deploy time from git history over <code>raw/</code>. Nothing on this site is written by a
language model, here or anywhere in the generator. Every sentence is a template filled from a diff or a
sidecar, and every value read out of a stored payload is quoted.</p>
<p>Timestamps are the sidecar's <code>origin_date</code> where the provider sent an <code>Age</code> header, and
<code>observed_at</code>, labelled as such, where it did not. <a href="${up}about.html">What this archive stores</a>.</p>
</div></footer>
</body>
</html>
`;
}

/**
 * A stub that forwards one old URL to its new address.
 *
 * Deliberately NOT built on `layout`: it links no stylesheet and shows no
 * navigation, because the only correct outcome of loading it is leaving it. A
 * `<link rel="canonical">` accompanies the refresh so a crawler that does not
 * follow a meta refresh still learns which URL is the real one. GitHub Pages
 * serves static files and cannot issue a 301, so a meta refresh is the whole of
 * what is available.
 */
export function renderRedirect(target: string): string {
  const href = escapeHtml(target);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Moved</title>
<link rel="canonical" href="${href}">
<meta http-equiv="refresh" content="0; url=${href}">
</head>
<body>
<p>This page moved to <a href="${href}">${href}</a>.</p>
</body>
</html>
`;
}

function stampHtml(stamp: Stamp | null): string {
  if (stamp === null) return '<span class="badge badge-observed">no sidecar</span>';
  return `<time datetime="${escapeHtml(stamp.iso)}">${escapeHtml(formatUtc(stamp.iso))}</time> <span class="badge badge-${stamp.kind}">${stamp.kind}</span>`;
}

function countsHtml(a: ArtifactChange): string {
  return `<span class="count-add">+${formatInt(a.linesAdded)}</span> <span class="count-remove">-${formatInt(a.linesRemoved)}</span>`;
}

/**
 * The same counts as text, for a title attribute.
 *
 * Written as a concatenation rather than as a template literal that opens with
 * a plus sign followed by an interpolation. That byte sequence is exactly the
 * shape of a forced refspec, so the guard in test/git.test.ts flags it, and
 * that guard scans every file that can hand git an argument, comments included,
 * which is correct: a scanner that skipped comments could be walked straight
 * past. The guard is deliberately broader than git's own syntax and has already
 * been worked around four times, so when it fires on a false positive the right
 * move is to write the string differently rather than to teach it an exception
 * that will be beaten through later. This comment is phrased to describe the
 * sequence rather than to contain it, for the same reason.
 */
function plainCounts(a: ArtifactChange): string {
  return '+' + formatInt(a.linesAdded) + ' -' + formatInt(a.linesRemoved);
}

const SIDECAR_ROWS: ReadonlyArray<readonly [string, keyof SidecarView]> = [
  ['observed_at', 'observedAt'],
  ['origin_date', 'originDate'],
  ['status', 'status'],
  ['final URL', 'finalUrl'],
  ['etag', 'etag'],
  ['last-modified', 'lastModified'],
  ['date', 'date'],
  ['age', 'age'],
  ['cache-control', 'cacheControl'],
  ['cf-cache-status', 'cfCacheStatus'],
  ['content-encoding', 'contentEncoding'],
  ['content-length', 'contentLength'],
];

function sidecarHtml(sidecar: SidecarView | null): string {
  if (sidecar === null) return '<p class="note">No headers.json was stored beside this artifact at this commit.</p>';
  const rows = SIDECAR_ROWS.map(([label, key]) => {
    const v = sidecar[key];
    const text = v === null ? 'null' : String(v);
    return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(text)}</td></tr>`;
  }).join('\n');
  return `<details class="headers">
<summary>Recorded headers</summary>
<div class="table-scroll"><table class="kv">
${rows}
</table></div>
</details>`;
}

const GUTTER = { add: '+', remove: '-', context: ' ', hunk: '@' } as const;

function diffHtml(a: ArtifactChange): string {
  if (a.diff.length === 0) return '<p class="note">This commit recorded no textual diff for this artifact.</p>';
  let redactedCount = 0;
  const body = a.diff
    .map((l) => {
      const cut = l.truncated ? '<span class="cut">&#8230;</span>' : '';
      redactedCount += countEmails(l.text);
      const text = redactLine(l.text);
      return `<div class="dl dl-${l.kind}"><span class="g">${GUTTER[l.kind]}</span><code>${escapeHtml(text)}${cut}</code></div>`;
    })
    .join('\n');
  // Both notes are statements about this page's own rendering, with numbers
  // that come from the renderer. Neither says anything about the data.
  const notes: string[] = [];
  if (a.diffTruncated) {
    notes.push(
      `Diff display stops at ${formatInt(MAX_DIFF_LINES)} lines. The line counts above are from the whole diff.`,
    );
  }
  const cutLines = a.diff.filter((l) => l.truncated).length;
  if (cutLines > 0) {
    notes.push(`${plural(cutLines, 'line')} shown here cut at ${formatInt(MAX_LINE_CHARS)} characters.`);
  }
  if (redactedCount > 0) {
    notes.push(
      `${plural(redactedCount, 'email address')} masked in this display. See the About page on personal data.`,
    );
  }
  if (notes.length > 0) notes.push('The raw artifact at this commit is linked above.');
  const note = notes.length === 0 ? '' : `<p class="note">${escapeHtml(notes.join(' '))}</p>`;
  return `<div class="diff">\n${body}\n</div>\n${note}`;
}

function artifactSection(record: ChangeRecord, a: ArtifactChange): string {
  const stamp = stampFor(a.sidecar);
  const retracted = isArtifactRetracted(record, a.path);
  const permalink = artifactPermalink(record.sha, a.path);
  const bytes = a.bytes === null ? 'not recorded' : formatInt(a.bytes);
  return `<section class="artifact" id="${escapeHtml(a.sourceId)}">
<h2 class="path">${escapeHtml(a.path)} <span class="badge badge-${a.kind}">${a.kind}</span>${retracted ? ' <span class="badge badge-retracted">retracted</span>' : ''}</h2>
<dl class="facts">
<div class="fact"><dt>Source</dt><dd><a href="../${sourcePagePath(a.sourceId)}">${escapeHtml(a.sourceId)}</a></dd></div>
<div class="fact"><dt>Lines added</dt><dd class="big"><span class="plus">+${formatInt(a.linesAdded)}</span></dd></div>
<div class="fact"><dt>Lines removed</dt><dd class="big"><span class="minus">-${formatInt(a.linesRemoved)}</span></dd></div>
<div class="fact"><dt>Stored bytes at this commit</dt><dd>${escapeHtml(bytes)}</dd></div>
<div class="fact"><dt>Timestamp</dt><dd>${stampHtml(stamp)}</dd></div>
<div class="fact"><dt>Raw artifact at this commit</dt><dd><a href="${escapeHtml(permalink)}">${escapeHtml(a.path)}</a></dd></div>
</dl>
${sidecarHtml(a.sidecar)}
${diffHtml(a)}
</section>`;
}

function retractionHtml(record: ChangeRecord): string {
  const r = record.retraction;
  if (r === null) return '';
  const scope =
    r.path === null
      ? 'This change is retracted.'
      : `The artifact <code>${escapeHtml(r.path)}</code> in this change is retracted.`;
  const reason = r.reason === null ? '' : `\n<p class="reason">reason: ${escapeHtml(r.reason)}</p>`;
  return `<div class="retracted-note">
<p><span class="badge badge-retracted">retracted</span> ${scope} The page and its artifact link stay resolvable; nothing is deleted.</p>${reason}
<p class="note">Recorded in <code>meta/retractions.jsonl</code>.</p>
</div>`;
}

/** One permalinked page per commit that changed a stored artifact. */
export function renderChangePage(record: ChangeRecord): string {
  const short = record.sha.slice(0, 7);
  const body = `<p class="eyebrow">Change</p>
<h1 class="sha-title">${escapeHtml(short)}</h1>
<p class="sha-full">${escapeHtml(record.sha)} &middot; <a href="${escapeHtml(commitPermalink(record.sha))}">commit on GitHub</a></p>
<p class="subject">${escapeHtml(record.subject)}</p>
${retractionHtml(record)}
${record.artifacts.map((a) => artifactSection(record, a)).join('\n')}`;
  return layout({ title: `${short} - llm-catalog-archive`, depth: 1, body, active: 'changelog' });
}

/**
 * How big a change was, in the units the artifact actually has.
 *
 * WHY THE LINE COUNTS WERE NOT ENOUGH. The changelog is titled "The narrated
 * diff" and its magnitude column read `+1 -1` on every row that mattered,
 * because `openrouter-models/response.json` is 700KB of minified JSON on ONE
 * LINE. The commit that dropped 29 catalogue ids and the commit that moved a
 * single price rendered identically, so the column could not distinguish the
 * largest event in the archive from the smallest. A line count is a fact about
 * the file's formatting, not about the change.
 *
 * This counts the DERIVED events at that commit for that source instead, which
 * is the same number the thread pages and the API serve. It is not a summary
 * and it is not a judgement: every count here is the length of a list the
 * deriver already produced, and a commit whose events are zero gets null so the
 * caller can fall back to lines rather than print a confident "0 changes".
 */
const MAGNITUDE_LABEL: Partial<Record<FeedType, string>> = {
  model_added: 'entered',
  model_removed: 'left',
  price_changed: 'repriced',
  context_changed: 'context moved',
  doc_moved: 'docs moved',
  post_listed: 'posts listed',
  post_published: 'posts published',
  incident_opened: 'incidents opened',
  doc_added: 'docs listed',
  doc_removed: 'docs delisted',
  codename_entered: 'codenames',
  codename_unmasked: 'codenames revealed',
};

export function changeMagnitude(sha: string, sourceId: string, feed: readonly FeedItem[]): string | null {
  const counts = new Map<FeedType, number>();
  for (const item of feed) {
    if (item.sha !== sha || item.sourceId !== sourceId) continue;
    counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts]
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1))
    .map(([type, n]) => `${formatInt(n)} ${MAGNITUDE_LABEL[type] ?? type}`)
    .join(', ');
}

type Row = { record: ChangeRecord; artifact: ArtifactChange };

function rowsOf(records: ChangeRecord[]): Row[] {
  return records.flatMap((record) => record.artifacts.map((artifact) => ({ record, artifact })));
}

function rowHtml(row: Row, depth: number, feed: readonly FeedItem[] = []): string {
  const { up } = links(depth);
  const { record, artifact } = row;
  const stamp = stampFor(artifact.sidecar);
  const retracted = isArtifactRetracted(record, artifact.path);
  // Derived magnitude when the archive has one, line counts otherwise, and the
  // line counts stay reachable either way as the cell's title.
  const derived = changeMagnitude(record.sha, artifact.sourceId, feed);
  const size =
    derived === null
      ? countsHtml(artifact)
      : `<span title="the unified diff is ${escapeHtml(plainCounts(artifact))}, which counts lines rather than records">${escapeHtml(derived)}</span>`;
  return `<tr>
<td class="mono"><a href="${up}${sourcePagePath(artifact.sourceId)}">${escapeHtml(artifact.sourceId)}</a></td>
<td class="mono">${escapeHtml(artifact.path)}${retracted ? ' <span class="badge badge-retracted">retracted</span>' : ''}</td>
<td class="mono">${size}</td>
<td class="mono">${stampHtml(stamp)}</td>
<td class="mono"><a href="${up}${changePagePath(record.sha)}">${escapeHtml(record.sha.slice(0, 7))}</a></td>
</tr>`;
}

function changesTable(rows: Row[], depth: number, feed: readonly FeedItem[] = []): string {
  return `<div class="table-scroll"><table class="changes" data-filter="changes">
<thead><tr><th>Source</th><th>Artifact</th><th>Magnitude</th><th>Timestamp</th><th>Change</th></tr></thead>
<tbody>
${rows.map((r) => rowHtml(r, depth, feed)).join('\n')}
</tbody>
</table></div>`;
}

const NO_DAY = 'no timestamp recorded';

/**
 * Records bucketed by the UTC day of their stamp, days in first-seen order.
 *
 * A Map rather than a run-length grouping of adjacent records, so a day cannot
 * appear twice on the page if the caller ever hands over unsorted input.
 */
function byDay(records: ChangeRecord[]): { day: string; records: ChangeRecord[] }[] {
  const buckets = new Map<string, ChangeRecord[]>();
  for (const record of records) {
    const stamp = recordStamp(record);
    const day = stamp === null ? NO_DAY : utcDay(stamp.iso);
    const bucket = buckets.get(day);
    if (bucket === undefined) buckets.set(day, [record]);
    else bucket.push(record);
  }
  return [...buckets].map(([day, rs]) => ({ day, records: rs }));
}

/**
 * The changelog: one row per commit that changed a stored artifact.
 *
 * This is the surface the project started as, and it is now a SECTION rather
 * than the front page. It is the evidence layer under everything else: the
 * narrated diff, at commit granularity, with no derivation applied. A reader
 * who distrusts a sentence on the front page arrives here, and from here at the
 * commit, and from there at the bytes.
 *
 * It lives one directory down, so every link out of it carries the `../` that
 * `links(1)` supplies. The change pages it links to did NOT move: spec section
 * 10 makes a change page's URL a permalink, and moving the index is not licence
 * to move what the index points at.
 */
export function renderChangelogPage(records: ChangeRecord[], feed: readonly FeedItem[] = []): string {
  const { up } = links(1);
  const sourceIds = [...new Set(rowsOf(records).map((r) => r.artifact.sourceId))].sort();
  const perSource = new Map<string, number>();
  for (const row of rowsOf(records)) perSource.set(row.artifact.sourceId, (perSource.get(row.artifact.sourceId) ?? 0) + 1);

  const cards = sourceIds
    .map(
      (id) => `<div class="source-card">
<a href="${up}${sourcePagePath(id)}">${escapeHtml(id)}</a>
<p>${plural(perSource.get(id) ?? 0, 'change')}</p>
</div>`,
    )
    .join('\n');

  const days = byDay(records)
    .map(
      (g) => `<section class="day">
<h2>${escapeHtml(g.day)}</h2>
${changesTable(rowsOf(g.records), 1, feed)}
</section>`,
    )
    .join('\n');

  /*
   * THE GRAPH'S DATA, as the changelog already knows it: one node per commit
   * that changed a stored artifact, carrying its source and its size. The 3D
   * layer reads this island; the tables below are the page whether or not it
   * ever runs.
   */
  const graphNodes = rowsOf(records).map((r) => ({
    sha: r.record.sha.slice(0, 7),
    source: r.artifact.sourceId,
    size: r.artifact.linesAdded + r.artifact.linesRemoved,
    href: changePagePath(r.record.sha),
  }));

  const body = `<p class="eyebrow">Changelog</p>
<h1>The narrated diff</h1>
<p class="lede">One entry per commit that changed a stored artifact under <code>raw/</code>. ${plural(records.length, 'change')} across ${plural(sourceIds.length, 'source')}, newest first by the timestamp each row shows rather than by commit order. This is the evidence layer: <a href="${up}index.html">Everything</a> is the same archive with the derivations applied.</p>
<div class="panel graph-panel">
<h2>Every capture, by source</h2>
<div class="graph-stage" data-graph-stage></div>
<p class="note">One node per commit that changed a stored artifact, one lane per source, newest at the front. Node size is the size of that diff. Where this browser cannot draw it, the source counts below are the same data.</p>
</div>
<div class="panel">
<h2>Sources</h2>
<div class="grid-sources">
${cards}
</div>
</div>
${days}
<script type="application/json" data-graph-nodes>${jsonIsland(graphNodes)}</script>
<script type="module" src="${up}${WALL_JS_PATH}"></script>`;
  return layout({
    title: 'Changelog - llm-catalog-archive',
    depth: 1,
    body,
    active: 'changelog',
    canonical: CHANGELOG_INDEX_PATH,
    filterable: true,
  });
}

/**
 * What the archive knows about one configured source, INCLUDING one that has
 * never stored a byte.
 *
 * A source with no captures used to have no page at all, because the page list
 * was built from the directories present under raw/. xai-llms-txt has been
 * configured and active for days, held out of the archive on every run by the
 * credential gate, and was invisible everywhere on the site: not in the source
 * list, not on the changelog, nowhere. A collection this project chose to make
 * and cannot complete is exactly the kind of thing the About page's own
 * standard says to state rather than imply.
 *
 * `configured` carries what meta/sources.json says about it. Absent means the
 * page is rendered from records alone, which is every other caller.
 */
export function renderSourcePage(
  sourceId: string,
  records: ChangeRecord[],
  configured?: { url: string; status: string; notes: string } | null,
): string {
  const rows = rowsOf(records).filter((r) => r.artifact.sourceId === sourceId);
  const latest = rows[0];
  const latestStamp = latest === undefined ? null : stampFor(latest.artifact.sidecar);
  const finalUrl = latest?.artifact.sidecar?.finalUrl ?? null;
  const paths = [...new Set(rows.map((r) => r.artifact.path))].sort();

  /*
   * Said plainly, at the top, because a zero on its own reads as "nothing has
   * happened here" when the truth is "we have never been able to store this".
   * Naming the source is not a disclosure risk: what the credential gate exists
   * to withhold is the vendor's key bytes, not the fact that a source is held,
   * and the About page already discloses the incident in general terms.
   */
  const empty =
    rows.length > 0 || configured === undefined || configured === null
      ? ''
      : `<p class="note">This source is configured and <strong>${escapeHtml(configured.status)}</strong>, and the archive holds no capture of it at all. Every run so far has either failed its health check or been held out of the archive before the write. Nothing here is missing by accident.</p>`;

  const body = `<p class="eyebrow">Source</p>
<h1 class="sha-title">${escapeHtml(sourceId)}</h1>
${empty}<dl class="facts">
<div class="fact"><dt>Recorded changes</dt><dd class="big">${formatInt(rows.length)}</dd></div>
${configured === undefined || configured === null ? '' : `<div class="fact"><dt>Configured URL</dt><dd><a href="${escapeHtml(configured.url)}">${escapeHtml(configured.url)}</a></dd></div>\n<div class="fact"><dt>Status in meta/sources.json</dt><dd>${escapeHtml(configured.status)}</dd></div>\n`}
<div class="fact"><dt>Latest recorded change</dt><dd>${stampHtml(latestStamp)}</dd></div>
<div class="fact"><dt>Stored path</dt><dd>${paths.map((p) => escapeHtml(p)).join('<br>')}</dd></div>
<div class="fact"><dt>Final URL at the latest change</dt><dd>${finalUrl === null ? 'not recorded' : `<a href="${escapeHtml(finalUrl)}">${escapeHtml(finalUrl)}</a>`}</dd></div>
</dl>
${changesTable(rows, 1)}`;
  return layout({ title: `${sourceId} - llm-catalog-archive`, depth: 1, body, active: 'changelog' });
}

const FEED_LIMIT = 50;

function rfc822(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toUTCString();
}

/**
 * RSS 2.0. Item titles are the same templated form the pages use, because a
 * feed is where a summary would be most tempting and least defensible.
 */
export function renderFeed(records: ChangeRecord[], siteUrl: string = SITE_URL): string {
  const items = rowsOf(records)
    .slice(0, FEED_LIMIT)
    .map(({ record, artifact }) => {
      const stamp = stampFor(artifact.sidecar);
      const url = `${siteUrl}/${changePagePath(record.sha)}#${artifact.sourceId}`;
      const retracted = isArtifactRetracted(record, artifact.path);
      const title = `${artifact.sourceId}: ${artifact.path} ${artifact.kind}, ${plural(artifact.linesAdded, 'line')} added, ${plural(artifact.linesRemoved, 'line')} removed`;
      const when = stamp === null ? 'no timestamp recorded' : `${formatUtc(stamp.iso)} (${stamp.kind})`;
      const description = `${retracted ? 'RETRACTED. ' : ''}${artifact.path} ${artifact.kind}: ${plural(artifact.linesAdded, 'line')} added, ${plural(artifact.linesRemoved, 'line')} removed. Timestamp ${when}. Raw artifact at this commit: ${artifactPermalink(record.sha, artifact.path)}`;
      const pubDate = stamp === null ? '' : `\n<pubDate>${escapeHtml(rfc822(stamp.iso))}</pubDate>`;
      return `<item>
<title>${escapeHtml(title)}</title>
<link>${escapeHtml(url)}</link>
<guid isPermaLink="true">${escapeHtml(url)}</guid>${pubDate}
<description>${escapeHtml(description)}</description>
</item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>llm-catalog-archive</title>
<link>${escapeHtml(siteUrl)}/index.html</link>
<atom:link href="${escapeHtml(siteUrl)}/feed.xml" rel="self" type="application/rss+xml"/>
<description>One item per commit that changed a stored artifact under raw/.</description>
<language>en</language>
${items}
</channel>
</rss>
`;
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------


/**
 * The extra facts one event type carries, as rows a reader can check against
 * the linked artifact.
 *
 * context_changed ALWAYS prints top_provider.context_length on both sides.
 * OpenRouter's `context_length` is the maximum across the providers currently
 * routing a model, and 39 of 416 models in the capture stored today carry a
 * top_provider value that disagrees with it, so the pair is what lets a reader
 * see routing churn without the page asserting a cause. It is not an optional
 * detail row: without it the sentence invites exactly the inference spec
 * section 10.1 forbids.
 *
 * model_added prints its first-seen date only when the precision allows it.
 * Spec section 10.1: a renderer may show a date only when precision_seconds is
 * at or below the resolution it renders at. A daily-tier capture carries a
 * worst-case error above one day, so a day is not a resolution it may render.
 */
function eventFactsHtml(event: DerivedEvent): string {
  const rows: [string, string][] = [];
  if (event.type === 'context_changed') {
    rows.push(['top_provider.context_length before', event.topProviderFrom === null ? 'absent' : String(event.topProviderFrom)]);
    rows.push(['top_provider.context_length after', event.topProviderTo === null ? 'absent' : String(event.topProviderTo)]);
  }
  if (event.type === 'model_added') {
    rows.push(['catalog created', event.created === null ? 'absent' : String(event.created)]);
    // Infinity is a real value of this field: a source the archive has captured
    // once bounds nothing. formatInt would render it "Inf,ini,ty", so the
    // unbounded case is spelled out instead, and it says WHY rather than
    // printing a number a reader would try to compare.
    rows.push([
      'first-seen worst-case error',
      Number.isFinite(event.precisionSeconds)
        ? `${formatInt(event.precisionSeconds)} seconds, measured from this source's capture history`
        : 'unbounded: the archive holds one capture of this source',
    ]);
    const stamp = event.stamp;
    rows.push([
      'first seen in the catalog',
      canRenderAt(event.precisionSeconds, DAY_SECONDS) && stamp !== null
        ? utcDay(stamp.iso)
        : 'not shown: the worst-case error is wider than a day',
    ]);
  }
  if (event.type === 'model_removed') {
    rows.push(['last seen present', event.lastSeen === null ? 'not recorded' : formatUtc(event.lastSeen.iso)]);
  }
  if (event.type === 'retirement_floor') {
    rows.push(['parsed floor date', event.floorDate ?? 'the cell holds no date']);
  }
  if (rows.length === 0) return '';
  const body = rows
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
    .join('\n');
  return `<div class="table-scroll"><table class="kv">\n${body}\n</table></div>`;
}

/**
 * Where a micro-category page lives, and where a lab page lives.
 *
 * A type is already `[a-z_]+` from the two derivations' own discriminants, so
 * the only fold is the underscore, and a lab is a member of the closed LABS
 * list. Neither can collide the way an entity slug can, which is why these need
 * no equivalent of threads.ts's collision refusal.
 */
export function typePagePath(type: FeedType): string {
  return `type/${type.replace(/_/g, '-')}.html`;
}

export function labPagePath(lab: Lab): string {
  return `lab/${lab}.html`;
}

export const EVERYTHING_FEED_PATH = 'everything.xml';

/** The feed for one micro-category, beside its page. */
export function typeFeedPath(type: FeedType): string {
  return `type/${type.replace(/_/g, '-')}.xml`;
}

/** The desk's own feed, so rumors and leaks can be followed on their own. */
export const LEAKS_FEED_PATH = 'leaks/index.xml';
export const ABOUT_PATH = 'about.html';
export const CHANGELOG_INDEX_PATH = 'changelog/index.html';

/**
 * The entities an item files under, as links into the entity archive.
 *
 * An item with no entity prints that it was HELD rather than printing nothing.
 * Zero chips and "we could not attach this mechanically" look identical on a
 * page and are completely different facts, and the product spec's section 4
 * makes the second one a first-class outcome rather than an error.
 */
function entityChips(item: FeedItem, depth: number): string {
  const { up } = links(depth);
  if (item.entities.length === 0) {
    return '<p class="chips"><span class="chip chip-held">held: no entity was mechanically extractable</span></p>';
  }
  // THE LABEL IS IN A <code> BECAUSE IT IS A THIRD-PARTY STRING. An entity
  // label is a catalogue id or a documentation host and path, chosen by
  // somebody else, and the copy-rule scan strips code spans for exactly that
  // reason. Rendered bare it is prose this file composed: an entity built from
  // the catalog id `stealth/x-1. Anthropic is preparing its next flagship`
  // put that sentence on the front page through the chip row, which is how
  // test/copy-rule-live.ts caught it.
  const chips = item.entities
    .map(
      (e) =>
        `<a class="chip" href="${up}${threadPagePath(entitySlug(e))}"><span class="chip-kind">${escapeHtml(e.kind)}</span><code>${escapeHtml(e.label)}</code></a>`,
    )
    .join('\n');
  return `<p class="chips">${chips}</p>`;
}

/**
 * ONE CARD FOR BOTH DERIVATIONS, used by every surface in the publication.
 *
 * There used to be two near-identical renderers, one for an event and one for a
 * leak item, and they had already drifted: only one of them linked the item's
 * micro-category and neither linked its entities. A reader should not be able
 * to tell which code path drew a row, because the guarantees are the same
 * either way: the sentence came from a deriving module, the artifact link is at
 * the item's OWN commit rather than HEAD, and every value under it is a cell a
 * reader can check against those bytes.
 *
 * The sourcing tier is printed only where there is one. An event carries no
 * tier, and stamping every event `confirmed-artifact` to make the two look
 * alike would be inventing a grade the derivation never assigned.
 */
/**
 * A stable HTML id for one feed item, safe in a fragment and in an attribute.
 *
 * WHY EVERY ITEM NEEDS ONE. The everything feed pointed each of its 50 entries
 * at `changes/<sha>.html#<sourceId>`, which is the same address for every item
 * derived from one commit's read of one source. 48 of 50 entries collapsed onto
 * two URLs, so a subscriber who clicked a headline about a codename landed on a
 * page of truncated JSON that did not contain the sentence they clicked. The
 * feed promised a permalink per story and delivered a permalink per commit.
 *
 * The item id is `<sha>:<type>:<subject>` and a subject can hold a slash, a
 * colon and a dot, so it is folded to a conservative character set. Collisions
 * are not possible within a build: the id is already unique per build and this
 * mapping is injective on the characters that survive, because every run of
 * rejected characters becomes a single dash and the sha prefix differs.
 */
export function feedItemAnchor(item: FeedItem): string {
  return `item-${item.id.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()}`;
}

export function feedItemHtml(item: FeedItem, depth: number): string {
  const { up } = links(depth);
  const permalink = artifactPermalink(item.sha, item.path);
  const facts = item.event !== null ? eventFactsHtml(item.event) : item.leak !== null ? leakFactsHtml(item.leak) : '';
  const confirm = item.leak === null ? '' : confirmationHtml(item.leak);
  const tier =
    item.tier === null
      ? ''
      : ` <span class="badge badge-tier badge-${escapeHtml(item.tier)}">${escapeHtml(item.tier)}</span>`;
  return `<li class="event" id="${escapeHtml(feedItemAnchor(item))}">
<p class="claim">${escapeHtml(item.sentence)}</p>
<p class="event-meta"><a class="badge badge-type" href="${up}${typePagePath(item.type)}">${escapeHtml(item.type)}</a>${tier} ${stampHtml(item.stamp)} &middot; <a href="${up}${sourcePagePath(item.sourceId)}">${escapeHtml(item.sourceId)}</a> &middot; <a href="${up}${changePagePath(item.sha)}">${escapeHtml(item.sha.slice(0, 7))}</a> &middot; <a href="${escapeHtml(permalink)}">raw artifact at this commit</a></p>
${entityChips(item, depth)}
${facts}
${confirm}
</li>`;
}

/** A list of cards, or a sentence saying there are none. Never nothing. */
function itemListHtml(items: FeedItem[], depth: number, empty: string): string {
  if (items.length === 0) return `<p class="note">${escapeHtml(empty)}</p>`;
  return `<ol class="events">\n${items.map((i) => feedItemHtml(i, depth)).join('\n')}\n</ol>`;
}

const KIND_LABEL: Record<string, string> = {
  lab: 'Lab',
  model: 'Model',
  'api-surface': 'API surface',
};

/** One permalinked page per entity, listing that entity's events newest first. */
export function renderThreadPage(thread: Thread): string {
  const kind = KIND_LABEL[thread.entity.kind] ?? thread.entity.kind;
  const body = `<p class="eyebrow">${escapeHtml(kind)} thread</p>
<h1 class="sha-title"><code>${escapeHtml(thread.entity.label)}</code></h1>
<p class="sha-full"><code>${escapeHtml(thread.entity.id)}</code></p>
<dl class="facts">
<div class="fact"><dt>Events</dt><dd class="big">${formatInt(thread.events.length)}</dd></div>
<div class="fact"><dt>First event in the archive</dt><dd>${stampHtml(thread.firstSeen)}</dd></div>
<div class="fact"><dt>Last activity</dt><dd>${stampHtml(thread.lastActivity)}</dd></div>
</dl>
<ol class="events">
${thread.events.map((e) => feedItemHtml(e, 1)).join('\n')}
</ol>`;
  // THE <title> IS QUOTED for the same reason every other rendered appearance
  // of a third-party value is. An entity label is a catalogue id somebody else
  // chose, and a browser tab and a search result are the two places a bare one
  // reads most like a headline this project wrote.
  return layout({
    title: `${quoteValue(thread.entity.label)} - llm-catalog-archive`,
    depth: 1,
    body,
    active: 'threads',
  });
}

function threadRowHtml(thread: Thread): string {
  return `<tr>
<td class="mono"><a href="${escapeHtml(thread.slug)}.html"><code>${escapeHtml(thread.entity.label)}</code></a></td>
<td class="mono">${escapeHtml(thread.entity.kind)}</td>
<td class="mono">${formatInt(thread.events.length)}</td>
<td class="mono">${stampHtml(thread.lastActivity)}</td>
</tr>`;
}

/**
 * The threads index.
 *
 * Held events are listed here rather than hidden. An event whose entity could
 * not be extracted mechanically is real and its artifact link resolves; what it
 * lacks is a thread to sit on, and product spec section 4 says such an event is
 * held rather than guessed at. A held count of zero is a claim about the
 * extractor, so it is printed either way.
 */
export function renderThreadsIndex(set: ThreadSet): string {
  const kinds: Thread['entity']['kind'][] = ['model', 'lab', 'api-surface'];
  const sections = kinds
    .map((kind) => {
      const rows = set.threads.filter((t) => t.entity.kind === kind);
      if (rows.length === 0) return '';
      return `<section class="day">
<h2>${escapeHtml(KIND_LABEL[kind] ?? kind)}</h2>
<div class="table-scroll"><table class="changes" data-filter="threads">
<thead><tr><th>Thread</th><th>Kind</th><th>Events</th><th>Last activity</th></tr></thead>
<tbody>
${rows.map(threadRowHtml).join('\n')}
</tbody>
</table></div>
</section>`;
    })
    .filter((s) => s !== '')
    .join('\n');

  const totalEvents = set.threads.reduce((n, t) => n + t.events.length, 0);
  const held =
    set.held.length === 0
      ? '<p class="note">No event was held. Every derived event attached to at least one entity.</p>'
      : `<ol class="events">\n${set.held.map((e) => feedItemHtml(e, 1)).join('\n')}\n</ol>`;

  const body = `<p class="eyebrow">Threads</p>
<h1>Entity threads</h1>
<p class="lede">${plural(set.threads.length, 'thread')} carrying ${plural(totalEvents, 'event attachment')}, most recently active first. An event attaches to every entity it names, so one price change appears on the model's thread and on its lab's.</p>
${sections}
<section class="day">
<h2>Held</h2>
<p class="note">${plural(set.held.length, 'event')} could not be attached to an entity mechanically, and nothing here guesses. They keep their place in the stream and on their micro-category page; what they lack is a thread to accrete onto.</p>
${held}
</section>`;
  return layout({
    title: 'Threads - llm-catalog-archive',
    depth: 1,
    body,
    active: 'threads',
    canonical: 'threads/index.html',
    filterable: true,
  });
}

// ---------------------------------------------------------------------------
// The leaks desk
// ---------------------------------------------------------------------------

export const LEAKS_INDEX_PATH = 'leaks/index.html';
export const LEDGER_PATH = 'leaks/ledger.html';

/**
 * THE DEFAMATION LINE IS A COPY RULE AND NOT A DISCLAIMER, so it is enforced in
 * the sentence generator and re-stated here rather than parked in a footer.
 *
 * Nothing below composes a sentence of its own. Every claim on the leaks pages
 * comes from leakSentence in src/derive/leaks.ts, whose subject is always an
 * artifact, and everything this file adds around it is a label, a number read
 * off the item, or a link. A footer saying "these are rumors" would not make a
 * sentence with a company as its subject safe, and a page with no such sentence
 * on it does not need one.
 */
const LEAKS_STANDING_NOTE =
  'Every line on this page describes an artifact stored in this repository and linked at the commit that stored it. ' +
  'None of them says what a model is, who made it, what it will be called at launch, or when it ships, because a stored ' +
  'payload is evidence for none of that. Nothing here rehosts weights or source.';

const TIER_NOTE: Record<string, string> = {
  'confirmed-artifact': 'a publicly observable artifact exists and is linked',
  credible: 'a named source with a track record in this ledger',
  unconfirmed: 'reported, no artifact',
};

/**
 * The fact rows under a leak claim.
 *
 * Every value cell is marked `quoted`, and the class is load bearing rather
 * than cosmetic: these cells hold third-party bytes read out of a stored
 * artifact, and the copy-rule scan in test/site-leaks.test.ts excludes them for
 * exactly that reason. A pull request titled "OpenAI deprecated the Assistants
 * API" is what the payload says, and quoting it is describing an artifact. The
 * scan has to be able to tell a quoted value from a sentence this file wrote,
 * and an unmarked cell is indistinguishable from the ledger's own claim column.
 */
function leakFactsHtml(item: LeakItem): string {
  if (item.facts.length === 0) return '';
  const rows = item.facts
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td class="quoted">${escapeHtml(v)}</td></tr>`)
    .join('\n');
  return `<div class="table-scroll"><table class="kv">\n${rows}\n</table></div>`;
}

/**
 * The confirmation step for an upstream pull request, printed as a query a
 * reader runs and never as a result.
 *
 * `huggingface.co/api/models?search=<name>` returning `[]` is evidence about a
 * weights repository; the pull request is evidence about a runtime. Printing
 * "no weights exist for X" would merge the two into a claim about what a lab
 * has published, which one private repository falsifies.
 */
function confirmationHtml(item: LeakItem): string {
  if (!PULL_SOURCE_IDS.some((id) => id === item.sourceId)) return '';
  const title = item.facts.find(([k]) => k === 'title')?.[1] ?? '';
  const name = modelSupportName(title);
  if (name === null) return '';
  const url = confirmationQuery(name);
  return `<p class="note">Check for a published weights repository under this name: <a href="${escapeHtml(url)}"><code>${escapeHtml(url)}</code></a>. An empty array is a statement about that search, not about what exists.</p>`;
}

const SIGNAL_LABEL: Record<string, string> = {
  codename_entered: 'Arena codename map: a name entered the payload',
  codename_unmasked: 'Arena codename map: a name was unmasked',
  upstream_pr_opened: 'Upstream runtime: a model-support pull request appeared',
  upstream_pr_merged: 'Upstream runtime: a model-support pull request merged',
  stealth_listing: 'OpenRouter: an id under the stealth/ namespace',
  expiration_scheduled: 'OpenRouter: an expiration_date was recorded',
};

/**
 * The desk. One section per signal, each in the fixed order below.
 *
 * A signal with no items still gets its heading and a count of zero. A section
 * that vanishes when it is empty makes "no reveals this week" and "the
 * extractor broke three weeks ago" render identically, and the second is the
 * failure this whole project is organised around not making invisible.
 */
export function renderLeaksPage(
  items: LeakItem[],
  claims: LedgerClaim[] = [],
  refusals: LeakRefusal[] = [],
): string {
  const order: LeakItem['type'][] = [
    'codename_unmasked',
    'codename_entered',
    'upstream_pr_merged',
    'upstream_pr_opened',
    'stealth_listing',
    'expiration_scheduled',
  ];

  const sections = order
    .map((type) => {
      const rows = items.filter((i) => i.type === type);
      const body =
        rows.length === 0
          ? '<p class="note">No item of this kind is derivable from the archive as it stands.</p>'
          : `<ol class="events">\n${rows.map((i) => feedItemHtml(feedItemFromLeak(i), 1)).join('\n')}\n</ol>`;
      return `<section class="day">
<h2>${escapeHtml(SIGNAL_LABEL[type] ?? type)}</h2>
<p class="note">${plural(rows.length, 'item')}.</p>
${body}
</section>`;
    })
    .join('\n');

  const score = scoreLedger(claims);

  // REFUSALS ARE PRINTED, and this is the section a reader has to be able to
  // see before trusting a count of zero. A derivation that declined to run
  // across a change produces the same "no items" a quiet week produces, and one
  // of those two is a broken parser. The refusal says which change, which
  // artifact, and what was measured against what floor.
  const refusalSection =
    refusals.length === 0
      ? `<p class="note">No change was refused. Every stored change of a desk source was read, and the counts above are counts of what was there rather than of what could be parsed.</p>`
      : `<ol class="events">
${refusals
          .map(
            (r) => `<li class="event refusal">
<p class="claim">The desk derived nothing across one recorded change of ${escapeHtml(r.sourceId)}, because ${escapeHtml(r.reason)}</p>
<p class="event-meta"><span class="badge badge-refusal">refused</span> ${stampHtml(r.stamp)} &middot; <a href="../${sourcePagePath(r.sourceId)}">${escapeHtml(r.sourceId)}</a> &middot; <a href="../${changePagePath(r.sha)}">${escapeHtml(r.sha.slice(0, 7))}</a> &middot; <a href="${escapeHtml(artifactPermalink(r.sha, r.path))}">raw artifact at this commit</a></p>
</li>`,
          )
          .join('\n')}
</ol>`;

  const body = `<p class="eyebrow">Leaks</p>
<h1>The leaks desk</h1>
<p class="lede">${plural(items.length, 'item')} derived from stored artifacts. ${escapeHtml(LEAKS_STANDING_NOTE)}</p>
<div class="panel">
<h2>Sourcing tiers</h2>
<div class="table-scroll"><table class="kv">
${Object.entries(TIER_NOTE)
    .map(([tier, note]) => `<tr><th>${escapeHtml(tier)}</th><td>${escapeHtml(note)}</td></tr>`)
    .join('\n')}
</table></div>
<p class="note">The tier is about the artifact, not about confidence. Every item on this page is <code>confirmed-artifact</code>, because a derivation reads stored bytes and cannot vouch for a source it has never had.</p>
<p><a href="ledger.html">The accuracy ledger</a>: ${plural(score.total, 'recorded claim')}, ${formatInt(score.confirmed)} confirmed, ${formatInt(score.refuted)} refuted, ${formatInt(score.open)} open. A ledger claim is a PREDICTION, and the only ones the archive can make honestly are the catalog's own: an <code>expiration_date</code> is a dated, falsifiable statement about an id in the same namespace, so it can be checked against a later capture without joining anything. Nothing else on this page is scored there: the items below describe stored artifacts and predict nothing.</p>
</div>
${sections}
<section class="day">
<h2>Refused</h2>
<p class="note">${plural(refusals.length, 'change')} the desk declined to derive from. A refusal and a quiet week both produce zero items, and only one of them is a broken parser.</p>
${refusalSection}
</section>`;
  return layout({
    title: 'Rumors and leaks - llm-catalog-archive',
    depth: 1,
    body,
    active: 'leaks',
    canonical: LEAKS_INDEX_PATH,
    feeds: [{ href: LEAKS_FEED_PATH, title: 'llm-catalog-archive: rumors and leaks' }],
  });
}

const OUTCOME_LABEL: Record<string, string> = {
  confirmed: 'confirmed',
  refuted: 'refuted',
  open: 'open',
};

/**
 * The public accuracy ledger.
 *
 * Every rumor and whether it panned out, in the order it was recorded, which is
 * file order because the ledger is append-only. The accuracy rate is printed as
 * "not yet scored" rather than as a number while nothing has resolved: an empty
 * ledger has no accuracy, and both 0% and 100% would be a score nobody earned.
 */
export function renderLedgerPage(claims: LedgerClaim[], deskItems: number = 0): string {
  const score = scoreLedger(claims);
  const rows =
    claims.length === 0
      ? '<p class="note">The ledger is empty. Nothing has been claimed here, so nothing has been scored.</p>'
      : `<div class="table-scroll"><table class="changes">
<thead><tr><th>Recorded</th><th>Claim</th><th>Tier</th><th>Outcome</th><th>Resolved</th><th>Artifact</th></tr></thead>
<tbody>
${claims
          .map(
            (c) => `<tr>
<td class="mono">${escapeHtml(c.recorded)}</td>
<td>${escapeHtml(c.claim)}${c.resolutionNote === null ? '' : `<br><span class="note">${escapeHtml(c.resolutionNote)}</span>`}</td>
<td class="mono">${escapeHtml(c.tier)}</td>
<td class="mono"><span class="badge badge-outcome-${escapeHtml(c.outcome)}">${escapeHtml(OUTCOME_LABEL[c.outcome] ?? c.outcome)}</span></td>
<td class="mono">${escapeHtml(c.resolved ?? 'not yet')}</td>
<td class="mono">${c.artifact === null ? 'none' : `<a href="${escapeHtml(c.artifact)}">artifact</a>`}</td>
</tr>`,
          )
          .join('\n')}
</tbody>
</table></div>`;

  const body = `<p class="eyebrow">Leaks</p>
<h1>Accuracy ledger</h1>
<p class="lede">Every claim ENTERED IN THIS LEDGER and what became of it. Append-only: a claim line is written once and a resolution line is appended later naming it, so the outcome cannot be edited into the record after the fact. Enforced by <code>.github/workflows/append-only.yml</code>.</p>
<p class="lede">It is not a scorecard for the whole desk, and saying so is the difference between a ledger and a boast. A claim here is a PREDICTION that can turn out to be right or wrong, and it scores a FIELD rather than a company: whether OpenRouter's catalog <code>expiration_date</code> predicts the catalog's own behaviour. Nothing here says a lab missed a deadline. A retirement floor cannot be scored this way, because those dates are in a provider's own API namespace and joining <code>anthropic/claude-opus-4.1</code> to <code>claude-opus-4-1-20250805</code> is the guess this archive refuses. A derived item on <a href="index.html">the desk</a> describes a stored artifact, predicts nothing, and is never scored here; the desk currently holds ${plural(deskItems, 'item')}.</p>
<dl class="facts">
<div class="fact"><dt>Recorded claims</dt><dd class="big">${formatInt(score.total)}</dd></div>
<div class="fact"><dt>Confirmed</dt><dd class="big">${formatInt(score.confirmed)}</dd></div>
<div class="fact"><dt>Refuted</dt><dd class="big">${formatInt(score.refuted)}</dd></div>
<div class="fact"><dt>Open</dt><dd class="big">${formatInt(score.open)}</dd></div>
<div class="fact"><dt>Accuracy over resolved claims</dt><dd>${score.accuracyPct === null ? 'not yet scored: no claim has resolved' : `${score.accuracyPct}%`}</dd></div>
</dl>
${rows}
<p class="note"><a href="index.html">Back to the leaks desk</a>.</p>`;
  return layout({ title: 'Accuracy ledger - llm-catalog-archive', depth: 1, body, active: 'leaks' });
}

// ---------------------------------------------------------------------------
// Everything, and the micro-categories
// ---------------------------------------------------------------------------

/**
 * What a micro-category is called in a heading.
 *
 * THE SUBJECT OF EVERY ONE OF THESE IS AN ARTIFACT, on purpose, because a
 * category heading is a sentence a reader reads before any evidence at all.
 * "A context_length changed" is the diff; "context windows are being cut" is
 * the story, and the story is exactly what the archive cannot support. Every
 * type in ALL_TYPES has an entry, which test/site-everything.test.ts asserts,
 * so a type added to a derivation cannot ship with a page titled by its
 * discriminant.
 */
export const TYPE_LABEL: Record<FeedType, string> = {
  post_listed: 'A post appeared in a provider sitemap',
  post_published: 'A provider feed published a post',
  incident_opened: 'A provider opened a status incident',
  model_added: 'A model id entered the catalog',
  model_removed: 'A model id left the catalog',
  price_changed: 'A listed price changed',
  context_changed: 'A context_length changed',
  expiration_set: 'An expiration_date was recorded',
  alias_retargeted: 'A canonical_slug was retargeted',
  retirement_floor: 'A retirement date the table records',
  doc_moved: 'A documentation index entry moved',
  doc_added: 'A documentation index gained an entry',
  doc_removed: 'A documentation index lost an entry',
  codename_entered: 'A name entered the arena payload',
  codename_unmasked: 'A name in the arena payload was unmasked',
  upstream_pr_opened: 'A model-support pull request appeared',
  upstream_pr_merged: 'A model-support pull request merged',
  stealth_listing: 'An id under the stealth/ namespace',
  expiration_scheduled: 'An expiration_date was scheduled',
};

/**
 * How many items the front page carries before it stops.
 *
 * A cap rather than everything, because the archive grows every day and a front
 * page that renders its whole history is a page that gets slower for ever on
 * the device most shared links open on. A cap is only honest if it says so and
 * if nothing is reachable ONLY through the page that was capped, which is why
 * every item also sits on its micro-category page, its lab page and its entity
 * thread, none of which are capped.
 */
export const EVERYTHING_LIMIT = 150;

/** How many threads the front page's live rail carries. */
const RAIL_LIMIT = 8;

const NO_DAY_HEADING = 'no timestamp recorded';

/** Feed items bucketed by the UTC day of the stamp shown, in feed order. */
function feedByDay(items: FeedItem[]): { day: string; items: FeedItem[] }[] {
  const buckets = new Map<string, FeedItem[]>();
  for (const item of items) {
    const day = item.stamp === null ? NO_DAY_HEADING : utcDay(item.stamp.iso);
    const bucket = buckets.get(day);
    if (bucket === undefined) buckets.set(day, [item]);
    else bucket.push(item);
  }
  return [...buckets].map(([day, is]) => ({ day, items: is }));
}

function typeChips(feed: FeedItem[], depth: number, current: FeedType | null): string {
  const { up } = links(depth);
  const counts = countsByType(feed);
  return ALL_TYPES.map((type) => {
    const n = counts.get(type) ?? 0;
    const on = type === current ? ' chip-on' : '';
    const empty = n === 0 ? ' chip-empty' : '';
    return `<a class="chip${on}${empty}" href="${up}${typePagePath(type)}"><span class="chip-kind">${escapeHtml(type)}</span>${formatInt(n)}</a>`;
  }).join('\n');
}

function labChips(feed: FeedItem[], depth: number, current: Lab | null): string {
  const { up } = links(depth);
  const labs = labsInFeed(feed);
  if (labs.length === 0) {
    return '<p class="note">No item in the archive carries a vendor prefix this repository maps to a lab, so there is nothing to filter by. The table is in src/derive/entities.ts and it is closed on purpose.</p>';
  }
  const chips = labs
    .map((lab) => {
      const n = itemsOfLab(feed, lab).length;
      const on = lab === current ? ' chip-on' : '';
      return `<a class="chip${on}" href="${up}${labPagePath(lab)}"><span class="chip-kind">${escapeHtml(lab)}</span>${formatInt(n)}</a>`;
    })
    .join('\n');
  return `<p class="chips">${chips}</p>`;
}

/**
 * The live-thread rail, and the reason the publication has threads at all.
 *
 * QUIET DAYS ARE THE POINT, from the product spec's section 4: a day with no
 * new item still has live threads worth reading. The rail is on the front page
 * unconditionally rather than appearing when the feed is thin, because a rail
 * that shows up only on a quiet day is a rail that announces the quiet day.
 *
 * It reads "most recently active" off buildThreads' own ordering rather than
 * off a clock. This module has no clock, and "recent" measured against a build
 * time would make the same archive render differently on two runs.
 */
function threadRail(threads: ThreadSet, depth: number): string {
  const { up } = links(depth);
  const rows = threads.threads.slice(0, RAIL_LIMIT);
  if (rows.length === 0) {
    return `<div class="panel">
<h2>Live threads</h2>
<p class="note">No thread exists yet: no derived item has attached to an entity. <a href="${up}${THREADS_INDEX_PATH}">The threads index</a> says the same thing in more detail.</p>
</div>`;
  }
  const list = rows
    .map(
      (t) => `<li><a href="${up}${threadPagePath(t.slug)}">${escapeHtml(t.entity.label)}</a>
<span class="rail-meta">${escapeHtml(t.entity.kind)} &middot; ${plural(t.events.length, 'item')} &middot; last activity ${stampHtml(t.lastActivity)}</span></li>`,
    )
    .join('\n');
  return `<div class="panel">
<h2>Live threads</h2>
<p class="note">A thread is an entity and everything the archive has ever recorded about it, newest first. A day with no new item still has these, which is the whole reason the publication is organised this way rather than as a stream. ${plural(threads.threads.length, 'thread')} in all.</p>
<ul class="rail">
${list}
</ul>
<p class="note"><a href="${up}${THREADS_INDEX_PATH}">Every thread</a>.</p>
</div>`;
}

/**
 * The front page: everything the archive supports, newest first.
 *
 * This is the "general AI news for developers" surface and the default view,
 * and it is one stream over BOTH derivations rather than a link to two. What it
 * adds over the sections it draws from is exactly nothing: the sentences are
 * the ones the deriving modules wrote, in one order, with the micro-category
 * and the entities each item already carried turned into links.
 */
/**
 * The micro-categories as a rail list rather than a chip row.
 *
 * A key and a count, right-aligned, monospace, so the column reads as a table
 * of what the archive holds. Chips are the right shape on a filter page, where
 * they are the subject; in a 320px rail beside a stream of stories they wrap
 * into a block that competes with the stories, which is the failure the front
 * page had before this: two panels of navigation above the first sentence of
 * news.
 */
function typeRail(feed: FeedItem[], depth: number): string {
  const { up } = links(depth);
  const counts = countsByType(feed);
  const rows = ALL_TYPES.map((type) => {
    const n = counts.get(type) ?? 0;
    return `<li${n === 0 ? ' class="off"' : ''}><a href="${up}${typePagePath(type)}">${escapeHtml(type)}</a><span class="rail-n">${formatInt(n)}</span></li>`;
  }).join('\n');
  return `<ul class="rail-types">\n${rows}\n</ul>`;
}

/**
 * ONE CAPTURE MUST NOT OWN THE FRONT PAGE.
 *
 * The stream is chronological, which is right for news, but a single capture of
 * a catalogue can carry dozens of changes at one instant, and chronological
 * order then puts all of them at the top. Measured on the live front page
 * before this existed: 150 items, of which ONE commit contributed 40, and the
 * page opened with six near-identical price rows for two deepseek models. A
 * reader landing on "Everything" saw a spreadsheet, not what happened.
 *
 * So the cap is per commit as well as overall. Chronology is untouched: items
 * keep their order, and only the surplus from one commit is set aside, with a
 * line saying how many and where the rest are. The type pages stay uncapped,
 * which is what the front page's own copy has always said makes capping safe.
 *
 * Grouped by commit AND source, because one commit can change several sources
 * and those are unrelated stories that happen to share a sha.
 */
/**
 * THE ITEMS A PERSON WOULD CALL NEWS.
 *
 * The stream is chronological and complete, which is right, but on a catalogue
 * archive volume decides what a reader sees: measured on the live front page,
 * 170 of 444 items were price changes and NINE were announcements, incidents or
 * leaks. Two per cent. A visitor met four price rows and left without learning
 * that a provider had an outage or that a model shipped.
 *
 * So the front page leads with a headline strip and keeps the full stream under
 * it. Nothing is reordered and nothing is hidden: the same items appear again
 * below in their chronological place, and this is a second view of the top of
 * the archive rather than an editorial cut.
 *
 * WHAT COUNTS. Somebody else's published announcement, a provider's own
 * incident, a leak signal, and a model arriving or leaving a catalogue. What
 * does NOT count is the routine telemetry of a catalogue: a price moving, a
 * context length moving, a documentation page being relisted. Those matter to
 * developers, which is why they are still on the page, but 170 of them are an
 * activity log and not a front page.
 */
export const HEADLINE_TYPES: ReadonlySet<FeedType> = new Set<FeedType>([
  'post_published',
  'post_listed',
  'incident_opened',
  'codename_entered',
  'codename_unmasked',
  'stealth_listing',
  'upstream_pr_opened',
  'upstream_pr_merged',
  'model_added',
  'model_removed',
  'retirement_floor',
]);

export const HEADLINE_LIMIT = 8;

/** The newest headline-shaped items, one per subject so a bulk capture cannot fill it. */
export function headlines(feed: readonly FeedItem[], limit: number = HEADLINE_LIMIT): FeedItem[] {
  const out: FeedItem[] = [];
  const seenType = new Map<FeedType, number>();
  for (const item of feed) {
    if (!HEADLINE_TYPES.has(item.type)) continue;
    // At most three of any one kind, so a capture that added 30 models cannot
    // make the headline strip a list of 30 models.
    const n = seenType.get(item.type) ?? 0;
    if (n >= 3) continue;
    seenType.set(item.type, n + 1);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Raised from 4 when the tape arrived. The cap exists so one capture cannot own
 * the page, and at 4 it was sized for a world where every item was a full card.
 * A tape row costs a line, so twelve items from one capture is now roughly three
 * dispatches over a nine-row tape, which reads as one event rather than as a
 * wall. The cap still bites: the busiest capture in the archive carries forty.
 */
export const PER_COMMIT_LIMIT = 12;

export function capPerCommit(
  items: readonly FeedItem[],
  perCommit: number = PER_COMMIT_LIMIT,
): { shown: FeedItem[]; heldBack: Map<string, number> } {
  const seen = new Map<string, number>();
  const shown: FeedItem[] = [];
  const heldBack = new Map<string, number>();
  for (const item of items) {
    const key = `${item.sha}\u0000${item.sourceId}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (n < perCommit) shown.push(item);
    else heldBack.set(key, (heldBack.get(key) ?? 0) + 1);
  }
  return { shown, heldBack };
}

/**
 * The headline strip. Empty string when the archive holds no headline-shaped
 * item, rather than an empty box claiming there is no news: an empty archive
 * and a quiet week must not render the same.
 */
/**
 * THE STREAM, REBUILT AROUND WHAT THE CONTENT ACTUALLY IS.
 *
 * WHAT WAS WRONG. Below the front door the page was 103 identical cards: same
 * border, same padding, same rhythm, one after another for 27,000 pixels. An
 * outage that took Claude Code down rendered exactly like the two hundredth
 * price tick of the day. That is not a styling problem, it is a structural one:
 * the page was treating telemetry and news as the same kind of thing because
 * they arrive through the same pipe.
 *
 * TWO DEVICES, BOTH TRUE TO THE SUBJECT.
 *
 * THE WIRE. Git history is literally this project's database, so the stream is
 * drawn as a conductor with the CAPTURES as nodes on it. That is not
 * decoration: the node is a commit and a source, which is the primary key every
 * claim on this site is addressed by, and the pixel distance between two nodes
 * is how much that capture actually changed. A busy capture clusters; a quiet
 * one leaves the wire bare. The rhythm of the page becomes the rhythm of the
 * archive instead of a constant.
 *
 * THE TAPE. 207 of 391 items are price changes. Rendered as 207 cards they are
 * what makes the page feel infinite, and rendering them that way says they are
 * each a story, which is false: a listed price moving is telemetry. So the
 * price and context movements of one capture collapse into a monospace tape,
 * many rows in the height one card used, with both quoted values and the
 * direction. Nothing is lost or hidden: every one of them keeps its own
 * addressable row on its uncapped micro-category page, which is the arrangement
 * the front page's own copy has always described.
 *
 * Everything else is a DISPATCH and gets display type and room, because an
 * announcement, an incident, a leak and a model arriving are the things a
 * person came to read.
 */
const TAPE_TYPES: ReadonlySet<FeedType> = new Set<FeedType>(['price_changed', 'context_changed']);

/** What a capture really holds, before either cap. */
export type CaptureTruth = { items: number; tapeValues: number; tapeModels: number };

/** Keyed by sha and source, measured over the UNCAPPED feed. */
export function captureTruth(feed: readonly FeedItem[]): Map<string, CaptureTruth> {
  const out = new Map<string, CaptureTruth>();
  const models = new Map<string, Set<string>>();
  for (const item of feed) {
    const key = `${item.sha}\u0000${item.sourceId}`;
    const row = out.get(key) ?? { items: 0, tapeValues: 0, tapeModels: 0 };
    row.items += 1;
    if (TAPE_TYPES.has(item.type)) {
      row.tapeValues += 1;
      const seen = models.get(key) ?? new Set<string>();
      seen.add(tapeCells(item).subject);
      models.set(key, seen);
    }
    out.set(key, row);
  }
  for (const [key, row] of out) row.tapeModels = models.get(key)?.size ?? 0;
  return out;
}

/** One capture: the items a single commit produced for a single source. */
type Capture = { sha: string; sourceId: string; items: FeedItem[] };

/**
 * Consecutive items sharing a commit AND a source, in stream order.
 *
 * Consecutive rather than grouped globally, because the stream is chronological
 * and regrouping it would reorder the page. A source that appears twice in a
 * day with another source between gets two nodes on the wire, which is what
 * actually happened.
 */
export function capturesOf(items: readonly FeedItem[]): Capture[] {
  const out: Capture[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (last !== undefined && last.sha === item.sha && last.sourceId === item.sourceId) last.items.push(item);
    else out.push({ sha: item.sha, sourceId: item.sourceId, items: [item] });
  }
  return out;
}

/**
 * A price or context move as one tape row: both values as the artifact spelled
 * them, and the direction between them.
 *
 * The percentage is OUR arithmetic over two quoted values, not a third-party
 * claim, which is why it is not quoted and why it is omitted whenever the
 * numbers do not support one. `null` on either side, a zero denominator or an
 * unparseable value all yield no percentage rather than a confident 0%.
 */
export function tapeDelta(from: string | null, to: string | null): { dir: '+' | '-' | '=' ; pct: string | null } {
  if (from === null || to === null) return { dir: '=', pct: null };
  const a = Number(from);
  const b = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { dir: '=', pct: null };
  const dir = b > a ? '+' : b < a ? '-' : '=';
  if (a === 0 || dir === '=') return { dir, pct: null };
  const pct = Math.round(Math.abs((b - a) / a) * 100);
  return { dir, pct: pct === 0 ? null : `${pct}%` };
}

/** The model, field and both values a tape row shows, read off the event. */
function tapeCells(item: FeedItem): { subject: string; field: string; from: string | null; to: string | null } {
  const e = item.event;
  if (e !== null && e.type === 'price_changed') {
    return { subject: e.modelId, field: e.field, from: e.from, to: e.to };
  }
  if (e !== null && e.type === 'context_changed') {
    return {
      subject: e.modelId,
      field: 'context_length',
      from: e.from === null ? null : String(e.from),
      to: e.to === null ? null : String(e.to),
    };
  }
  return { subject: item.id, field: '', from: null, to: null };
}

function tapeRowHtml(item: FeedItem): string {
  const { field, from, to } = tapeCells(item);
  const { dir, pct } = tapeDelta(from, to);
  const arrow = dir === '+' ? '&#9650;' : dir === '-' ? '&#9660;' : '&middot;';
  const cls = dir === '+' ? 'up' : dir === '-' ? 'down' : 'flat';
  return `<tr class="tape-row tape-${cls}" id="${escapeHtml(feedItemAnchor(item))}">
<td class="tape-field">${escapeHtml(field)}</td>
<td class="tape-from">${escapeHtml(from ?? 'absent')}</td>
<td class="tape-arrow" aria-hidden="true">${arrow}</td>
<td class="tape-to">${escapeHtml(to ?? 'absent')}</td>
<td class="tape-pct">${pct === null ? '' : escapeHtml(pct)}</td>
</tr>`;
}

/**
 * The tape, GROUPED BY MODEL.
 *
 * The first build gave every row its own model column, which repeated the same
 * identifier three times running and, because those ids are long, squeezed the
 * two columns carrying the payload until the numbers themselves ellipsised. A
 * tape that truncates its numbers has lost the plot.
 *
 * Grouping states the true shape of a capture: one model, several of its fields
 * moved. The id is said once, spanning the width, and the fields sit under it
 * with room for both values in full.
 */
function tapeHtml(items: FeedItem[], depth = 0, trueValues = items.length, trueModels = 0): string {
  if (items.length === 0) return '';
  const { up } = links(depth);
  const groups = new Map<string, FeedItem[]>();
  for (const item of items) {
    const { subject } = tapeCells(item);
    const bucket = groups.get(subject);
    if (bucket === undefined) groups.set(subject, [item]);
    else bucket.push(item);
  }
  /*
   * The model name is a LINK to its thread, and that link is load-bearing.
   * A tape row shows the fields the sentence is built from rather than the
   * sentence, so without a route back the full claim would only exist on the
   * micro-category page. The thread carries the sentence, its permalink and
   * everything else the archive has recorded about that model.
   */
  const body = [...groups]
    .map(([subject, rows]) => {
      const thread = rows[0]?.entities.find((e) => e.kind === 'model') ?? null;
      const label = escapeHtml(subject);
      const head =
        thread === null
          ? label
          : `<a href="${up}threads/${escapeHtml(entitySlug(thread))}.html">${label}</a>`;
      return `<tr class="tape-model"><th colspan="5" scope="colgroup">${head}</th></tr>
${rows.map(tapeRowHtml).join('\n')}`;
    })
    .join('\n');
  return `<div class="tape">
<table>
<colgroup><col class="c-field"><col class="c-from"><col class="c-arrow"><col class="c-to"><col class="c-pct"></colgroup>
<caption>${
    trueValues > items.length
      ? `${plural(items.length, 'listed value')} shown of ${formatInt(trueValues)} that moved across ${plural(Math.max(trueModels, groups.size), 'model')} in this capture`
      : `${plural(items.length, 'listed value')} moved across ${plural(groups.size, 'model')} in this capture`
  }. Both numbers are the artifact's own; the percentage is this page's arithmetic over them. Each model links to its thread, which carries the full sentence and every other item recorded against it.</caption>
<thead><tr><th>Field</th><th>From</th><th aria-hidden="true"></th><th>To</th><th>Change</th></tr></thead>
<tbody>
${body}
</tbody>
</table>
</div>`;
}

/**
 * The claim sentence, escaped, with any quoted https:// run marked so the
 * stylesheet can set it in mono at reading size.
 *
 * THE TEXT IS NOT ALTERED. Escaping happens first and the wrapper goes around
 * the already-escaped run, so nothing is re-encoded and nothing is dropped: a
 * reader still sees the whole URL and the copy rule's quotes stay exactly where
 * the deriver put them. Setting a raw URL in 21px display type was making a
 * dispatch read as a broken headline.
 */
export function claimHtml(sentence: string): string {
  return escapeHtml(sentence).replace(
    /&quot;(https?:\/\/[^\s&]*)&quot;/g,
    (_m, url: string) => `&quot;<span class="url">${url}</span>&quot;`,
  );
}

/** A headline-shaped item: display type, room, and the evidence under it. */
function dispatchHtml(item: FeedItem, depth: number): string {
  const { up } = links(depth);
  const permalink = artifactPermalink(item.sha, item.path);
  const facts = item.event !== null ? eventFactsHtml(item.event) : item.leak !== null ? leakFactsHtml(item.leak) : '';
  const confirm = item.leak === null ? '' : confirmationHtml(item.leak);
  const tier =
    item.tier === null
      ? ''
      : ` <span class="badge badge-tier badge-${escapeHtml(item.tier)}">${escapeHtml(item.tier)}</span>`;
  return `<li class="dispatch" id="${escapeHtml(feedItemAnchor(item))}">
<a class="badge badge-type" href="${up}${typePagePath(item.type)}">${escapeHtml(item.type)}</a>${tier}
<p class="dispatch-claim">${claimHtml(item.sentence)}</p>
<p class="dispatch-meta">${stampHtml(item.stamp)} &middot; <a href="${escapeHtml(permalink)}">raw artifact at this commit</a></p>
${entityChips(item, depth)}
${facts}
${confirm}
</li>`;
}

/**
 * One node on the wire. The sha is set at display size in the mono face because
 * it is the archive's primary key, not a footnote: every claim here is
 * addressed by it, and printing it small was the page pretending its own
 * evidence was fine print.
 */
/**
 * THE COUNTS HAVE TO BE THE CAPTURE'S, NOT THE PAGE'S VIEW OF IT.
 *
 * The caption said "N listed values moved across M models IN THIS CAPTURE"
 * while N and M counted only the rows that survived two caps, and the
 * held-back note counted only the per-commit cap and not the page's overall
 * slice. On the live page one capture rendered "1 listed value moved across 1
 * model" and "1 further item is not shown" while the feed held 12 tape values
 * across 4 models and 11 items were hidden. A sentence that scopes itself to
 * the capture has to count the capture.
 */
function captureHtml(capture: Capture, depth: number, heldBack = 0, truth?: CaptureTruth): string {
  const { up } = links(depth);
  const tapeItems = capture.items.filter((i) => TAPE_TYPES.has(i.type));
  const dispatches = capture.items.filter((i) => !TAPE_TYPES.has(i.type));
  const stamp = capture.items[0]?.stamp ?? null;
  /*
   * data-weight is the number of items this capture actually produced, before
   * either cap. The 3D wire reads it to size and brighten the stud, so the
   * conductor shows WHERE THE ARCHIVE MOVED rather than merely where a commit
   * happened: a capture that changed 27 values is a bigger, hotter node than
   * one that changed a single price. The HTML is unaffected by its presence.
   */
  return `<li class="capture" data-weight="${truth?.items ?? capture.items.length}">
<div class="capture-head">
<a class="capture-sha" href="${up}${changePagePath(capture.sha)}">${escapeHtml(capture.sha.slice(0, 7))}</a>
<a class="capture-source" href="${up}${sourcePagePath(capture.sourceId)}">${escapeHtml(capture.sourceId)}</a>
<span class="capture-when">${stampHtml(stamp)}</span>
</div>
${dispatches.length === 0 ? '' : `<ol class="dispatches">\n${dispatches.map((i) => dispatchHtml(i, depth)).join('\n')}\n</ol>`}
${tapeHtml(tapeItems, depth, truth?.tapeValues ?? tapeItems.length, truth?.tapeModels ?? 0)}
${
  heldBack === 0
    ? ''
    : `<p class="capture-more">${plural(heldBack, 'further item')} from this capture ${heldBack === 1 ? 'is' : 'are'} not shown here. Every one of them is on its <a href="${up}${typePagePath(capture.items[0]?.type ?? 'model_added')}">micro-category page</a>, which is uncapped.</p>`
}
</li>`;
}

/** A day of the stream, drawn on the wire. */
function dayHtml(
  day: string,
  items: FeedItem[],
  depth: number,
  heldBack: ReadonlyMap<string, number> = new Map(),
  truth: ReadonlyMap<string, CaptureTruth> = new Map(),
): string {
  const captures = capturesOf(items);
  return `<section class="day">
<h2 class="day-mark"><span>${escapeHtml(day)}</span></h2>
<ol class="wire">
${captures
  .map((c) => {
    const key = `${c.sha}\u0000${c.sourceId}`;
    const real = truth.get(key);
    // Against what RENDERED, not against the per-commit cap: the page's overall
    // slice hides items too, and those were in nobody's count.
    const hidden = real === undefined ? (heldBack.get(key) ?? 0) : Math.max(real.items - c.items.length, 0);
    return captureHtml(c, depth, hidden, real);
  })
  .join('\n')}
</ol>
</section>`;
}

function headlineStripHtml(feed: readonly FeedItem[]): string {
  const items = headlines(feed);
  if (items.length === 0) return '';
  const rows = items
    .map(
      (i) =>
        `<li class="headline"><a class="badge badge-type" href="${typePagePath(i.type)}">${escapeHtml(i.type)}</a> <span class="headline-claim">${escapeHtml(i.sentence)}</span> <span class="headline-when">${stampHtml(i.stamp)}</span></li>`,
    )
    .join('\n');
  return `<div class="panel headlines">
<h2>What happened</h2>
<p class="note">Announcements, incidents, leaks, and models arriving or leaving a catalogue. The full stream below is chronological and includes these again, plus the routine catalogue activity they would otherwise be buried under.</p>
<ol class="headline-list">
${rows}
</ol>
</div>`;
}

export function renderEverythingPage(
  feed: FeedItem[],
  threads: ThreadSet = { threads: [], held: [] },
  limit: number = EVERYTHING_LIMIT,
): string {
  // Per commit FIRST, then overall, so the overall cap spends its budget on
  // distinct stories rather than on one capture's forty price rows.
  const { shown: spread, heldBack } = capPerCommit(feed);
  const truth = captureTruth(feed);
  const shown = spread.slice(0, limit);
  const heldBackTotal = [...heldBack.values()].reduce((n, v) => n + v, 0);

  const days = feedByDay(shown)
    .map((g) => dayHtml(g.day, g.items, 0, heldBack, truth))
    .join('\n');

  /*
   * THREE BUCKETS, AND THE SENTENCE USED TO NAME TWO.
   *
   * The page is capped twice: capPerCommit holds items back so no single
   * capture fills it, and the overall limit then truncates what survives. Only
   * the first was counted, so the note read "Showing 150 items of 408, with 192
   * more held back" and 150 + 192 is 342. SIXTY-SIX ITEMS WERE IN NEITHER
   * NUMBER, on the front page of an archive whose entire claim is that its
   * numbers can be checked.
   *
   * Both cuts are now named and the three add up, which the test beside this
   * asserts arithmetically rather than by matching the sentence.
   */
  const beyondLimit = spread.length - shown.length;
  const cuts = [
    heldBackTotal > 0
      ? `${formatInt(heldBackTotal)} held back so that no single capture fills the page`
      : '',
    beyondLimit > 0 ? `${formatInt(beyondLimit)} beyond this page's limit of ${formatInt(limit)}` : '',
  ].filter((c) => c !== '');
  const capped =
    feed.length > shown.length
      ? `<p class="note">Showing ${plural(shown.length, 'item')} of ${formatInt(feed.length)}${
          cuts.length === 0 ? '' : `: ${cuts.join(', and ')}`
        }. Nothing is dropped: every item is also on its micro-category page, on its lab page where it has one, and on the entity thread it attaches to where one could be resolved, and none of those are capped.</p>`
      : '';

  const stream =
    shown.length === 0
      ? `<div class="panel">
<h2>Nothing is derivable yet</h2>
<p class="note">No stored change in the archive supports a typed claim. That is a statement about the derivations in <code>src/derive/</code>, not about the industry: the <a href="${CHANGELOG_INDEX_PATH}">changelog</a> lists every commit that changed a stored artifact, including the ones nothing here knows how to read.</p>
</div>`
      : days;

  // THE STREAM COMES FIRST IN THE DOM, which is what puts the news above the
  // navigation on a phone. On a wide screen the rail sits beside it rather than
  // above it, so the same markup reads as a publication at both sizes without
  // an order override that would put filters in front of a reader who came to
  // read. The one exception is the lab filter, which is a single compact row
  // directly under the lede: filtering an AI news stream by lab is the thing
  // the research found nobody offers, so it is not allowed to be below a fold.
  // THE FRONT DOOR SITS ON TOP OF THE INDEX AND REPLACES NO PART OF IT. What it
  // emits into the DOM is a list of links; wall.js draws that list as a wall of
  // slabs only once a WebGL frame is actually on screen, and puts the list back
  // if the context is ever lost. Everything below this line renders identically
  // whether or not a single line of JavaScript ever runs, which is the whole
  // reason the 3D is allowed to exist: the archive is worth something because
  // it is linkable and indexable, and a crawler sees nothing inside a canvas.
  const body = `<p class="eyebrow">The archive</p>
<h1>Everything</h1>
<p class="lede">${plural(feed.length, 'item')} derived by replay from git history over <code>raw/</code>, newest first. Every sentence names the artifact it was read out of and links those bytes at the commit that stored them.</p>
${wallHtml(threads, threads.threads.length)}
${headlineStripHtml(feed)}
<div class="filterbar">
<span class="filterbar-label">By lab</span>
${labChips(feed, 0, null)}
</div>
<div class="split">
<div class="split-main">
${capped}
${stream}
</div>
<aside class="split-side">
<div class="panel">
<h2>Micro-categories</h2>
<p class="note">Every item carries the type its derivation gave it. A type with no items keeps its page: "nothing happened" and "the extractor broke" must not render identically.</p>
${typeRail(feed, 0)}
</div>
${threadRail(threads, 0)}
<div class="panel">
<h2>The other two ways in</h2>
<p class="note"><a href="${CHANGELOG_INDEX_PATH}">The changelog</a> is the same archive with no derivation applied: one row per commit that changed a stored artifact.</p>
<p class="note"><a href="${LEAKS_INDEX_PATH}">The leaks desk</a> is the subset graded by sourcing tier, with the accuracy ledger behind it.</p>
</div>
</aside>
</div>`;
  return layout({ title: 'llm-catalog-archive', depth: 0, body, active: 'everything' });
}

/** One micro-category, with every item in it. Never capped. */
export function renderTypePage(type: FeedType, feed: FeedItem[]): string {
  const items = itemsOfType(feed, type);
  const label = TYPE_LABEL[type];
  const body = `<p class="eyebrow">Micro-category</p>
<h1>${escapeHtml(label)}</h1>
<p class="sha-full">${escapeHtml(type)}</p>
<p class="lede">${plural(items.length, 'item')} in the archive, newest first. Every item of this kind, uncapped, which is what makes the front page safe to cap.</p>
<div class="panel">
<h2>Every micro-category</h2>
<p class="chips">
${typeChips(feed, 1, type)}
</p>
</div>
${itemListHtml(items, 1, 'No item of this kind is derivable from the archive as it stands. The page exists anyway: a category that vanished when it was empty would make a quiet week and a broken extractor look the same.')}`;
  return layout({
    title: `${label} - llm-catalog-archive`,
    depth: 1,
    body,
    active: 'everything',
    canonical: typePagePath(type),
    feeds: [{ href: typeFeedPath(type), title: `llm-catalog-archive: ${type}` }],
  });
}

/**
 * One lab, with every item that attaches to it.
 *
 * SEPARATE FROM THE LAB'S THREAD, and the difference is worth a sentence. The
 * thread is the entity archive's page for `lab/anthropic` and it carries every
 * item that names that lab, in the entity model's own terms. This page is the
 * front page filtered, and it exists because the research found the filter is
 * the unserved thing: every competitor is a stream and none of them lets a
 * reader ask for one lab. The two lists are the same items by construction,
 * because both read the same entities off the same feed.
 */
export function renderLabPage(lab: Lab, feed: FeedItem[]): string {
  const items = itemsOfLab(feed, lab);
  const slug = entitySlug({ kind: 'lab', id: `lab/${lab}`, label: lab });
  const body = `<p class="eyebrow">Lab</p>
<h1>${escapeHtml(lab)}</h1>
<p class="sha-full">lab/${escapeHtml(lab)}</p>
<p class="lede">${plural(items.length, 'item')} whose catalogue id or source carries a vendor prefix this repository maps to ${escapeHtml(lab)}, newest first. The mapping is a written table, never inferred: an unlisted vendor yields no lab at all rather than a guessed one.</p>
<div class="panel">
<h2>By lab</h2>
${labChips(feed, 1, lab)}
<p class="note">The same items in the entity model's own terms: <a href="../${threadPagePath(slug)}">the ${escapeHtml(lab)} thread</a>.</p>
</div>
${itemListHtml(items, 1, 'No item in the archive attaches to this lab.')}`;
  return layout({ title: `${lab} - llm-catalog-archive`, depth: 1, body, active: 'everything' });
}

// ---------------------------------------------------------------------------
// About: what is collected, and what that costs
// ---------------------------------------------------------------------------

/**
 * The page that states what this archive stores, including the part that is
 * uncomfortable.
 *
 * IT NAMES THE ERASURE PROBLEM RATHER THAN LEAVING IT IMPLIED. Two of the
 * sources are GitHub pull-request searches, and a search payload carries the
 * pull request's body text and its author's login, id, avatar URL and profile
 * URL. Those are named private individuals, they are recommitted on every
 * capture, and R7 forbids rewriting the history that holds them, so an erasure
 * request cannot be satisfied by construction. Every other source is vendor
 * documentation or a machine-readable catalogue and raises nothing like it.
 * A reader is entitled to know that before deciding what this project is.
 */
/** Where the API lives, so the docs page and the generator cannot disagree. */
export const API_PATH = 'api.html';

/**
 * The API and CLI documentation. One page, examples that run as written.
 *
 * WRITTEN AGAINST THE REAL BASE URL rather than a placeholder, because a docs
 * page whose examples have to be edited before they work is a docs page nobody
 * has run. `siteUrl` is threaded in from the generator for the same reason the
 * feed takes it: it is the one thing here that depends on how the repository's
 * Pages source is configured, which is a repository setting and not code.
 *
 * THE THREE TIERS ARE LABELLED HONESTLY, including the one that is a commodity.
 * Product design section 3 is explicit that the current model list, the current
 * prices and the current context windows cost nothing to serve and are the
 * front door rather than the product, and a page that presented them as unique
 * would be making the kind of claim the rest of this site exists to refuse.
 */
/**
 * The model id the documentation's worked examples are written against.
 *
 * WHY THIS IS COMPUTED AND NOT TYPED IN. The examples used to name
 * `anthropic/claude-opus-5`, whose `api` field is null, because a model only
 * gets an `api` URL once it has a thread. 342 of 425 catalogue models have no
 * thread, so the odds that a hand-picked id is one of them are good, and the
 * failure is silent: the pipeline resolves to `curl null` and prints nothing
 * under a heading that reads "Examples that run as written". Choosing the
 * busiest thread instead means the example is the one most likely to still
 * resolve tomorrow, and `renderApiPage` throws when there is no such model at
 * all, so the build fails rather than shipping a dead example.
 *
 * Ties break on the id so the page is byte-stable across builds.
 */
export const CATALOG_ENTITY_PREFIX = 'model/openrouter:';

export function exampleModelId(threads: readonly Thread[]): string | null {
  let best: { id: string; count: number } | null = null;
  for (const t of threads) {
    // The catalogue namespace only. A provider's own API model name lives under
    // a different prefix and is not a `models.json` id, so an example written
    // against one would 404 exactly the way the null `api` field did.
    if (t.entity.kind !== 'model' || !t.entity.id.startsWith(CATALOG_ENTITY_PREFIX)) continue;
    const id = t.entity.id.slice(CATALOG_ENTITY_PREFIX.length);
    if (id === '') continue;
    if (best === null || t.events.length > best.count || (t.events.length === best.count && id < best.id)) {
      best = { id, count: t.events.length };
    }
  }
  return best?.id ?? null;
}

export function renderApiPage(
  siteUrl: string = SITE_URL,
  cliName: string = CLI_NAME,
  repoSlug: string = REPO_SLUG,
  exampleId: string | null = null,
): string {
  const base = `${siteUrl.replace(/\/+$/, '')}/api/v1`;
  // NO FALLBACK ID, DELIBERATELY. A page that documents a dead example is worse
  // than a page with no example, because the reader blames their own shell. The
  // previous fallback was a hardcoded id whose `api` field is null in
  // production, and it was invisible to tests precisely because a fixture whose
  // only model IS that id resolves it fine. When the archive has no model
  // thread, the model-specific examples are omitted and the page says so.
  if (exampleId === '') throw new Error('renderApiPage: exampleId must be a model id or null, never empty');
  const example = exampleId;
  const npx = `npx ${repoSlug}`;
  const body = `<p class="eyebrow">Data product</p>
<h1>A keyless JSON API and a CLI</h1>
<p class="lede">Everything this archive derives is served as flat JSON from the same GitHub Pages deployment as the site. No key, no signup, no rate limit, no server. Every record carries the permalink of the raw artifact it was derived from, at the full sha of the commit that changed it, so any number here can be checked against the bytes it came from without asking us anything.</p>

<div class="panel prose">
<h2>Start here</h2>
<p><code>index.json</code> is a machine-readable directory of every other file, including the literal list of which micro-categories and which labs exist. That list is what lets a client tell "this lab has nothing in the archive" from "the deploy is broken", which are otherwise the same 404.</p>
<div class="shell">curl -s ${escapeHtml(base)}/index.json | jq '.endpoints'</div>
</div>

<div class="panel prose">
<h2>The endpoints</h2>
<div class="shell">${escapeHtml(base)}/index.json          the directory of everything below
${escapeHtml(base)}/models.json         current catalog state, one row per model
${escapeHtml(base)}/models/{slug}.json  one model with its full event history
${escapeHtml(base)}/events.json         every derived item, newest first, paginated
${escapeHtml(base)}/events/{type}.json  filtered by micro-category
${escapeHtml(base)}/events/page-{n}.json  page 2 and up of the stream
${escapeHtml(base)}/labs/{lab}.json     one lab
${escapeHtml(base)}/retirements.json    current retirement floors and recorded replacements
${escapeHtml(base)}/leaks.json          the leaks desk, with sourcing tiers and refusals
${escapeHtml(base)}/accuracy.json       the public accuracy ledger</div>
<p>A model's <code>{slug}</code> is the same slug its thread page uses, and every row of <code>models.json</code> carries it along with the absolute URL of its own endpoint, so nothing has to be constructed by hand.</p>
</div>

<div class="panel prose">
<h2>Examples that run as written</h2>
<p>Every model whose listed prompt price changed, newest first:</p>
<div class="shell">curl -s ${escapeHtml(base)}/events/price-changed.json \\
  | jq -r '.items[] | [.timestamp.value, .subject, .fields.field, .fields.from, .fields.to] | @tsv'</div>
<p>The catalog context_length beside the top_provider value on the same two sides, which is the pair that shows routing churn without anybody asserting a cause:</p>
<div class="shell">curl -s ${escapeHtml(base)}/events/context-changed.json \\
  | jq -r '.items[] | [.subject, .fields.from, .fields.to, .fields.top_provider_from, .fields.top_provider_to] | @tsv'</div>
${
    example === null
      ? '<p>The archive holds no model thread yet, so the worked example for one model is omitted rather than written against an id that would not resolve.</p>'
      : `<p>Everything the archive holds on one model, with the artifact behind each row:</p>
<div class="shell">curl -s ${escapeHtml(base)}/models.json \\
  | jq -r '.models[] | select(.id == &quot;${escapeHtml(example)}&quot;) | .api' \\
  | xargs curl -s | jq -r '.items[] | [.timestamp.value, .sentence, .artifact] | @tsv'</div>`
  }
<p>The leaks desk, confirmed-artifact tier only:</p>
<div class="shell">curl -s ${escapeHtml(base)}/leaks.json \\
  | jq -r '.items[] | select(.tier == "confirmed-artifact") | [.type, .subject, .artifact] | @tsv'</div>
<p>The accuracy ledger's single number:</p>
<div class="shell">curl -s ${escapeHtml(base)}/accuracy.json | jq '.scorecard'</div>
</div>

<div class="panel prose">
<h2>The CLI</h2>
<p>One file, no dependencies, nothing to install. It reads the same static files the examples above do.</p>
<div class="shell">${escapeHtml(npx)} models --lab anthropic${
    example === null
      ? ''
      : `
${escapeHtml(npx)} watch ${escapeHtml(example)} --once
${escapeHtml(npx)} price-history ${escapeHtml(example)}`
  }
${escapeHtml(npx)} leaks --tier confirmed-artifact
${escapeHtml(npx)} retiring --within 90d --models claude-opus-4-8,claude-sonnet-4-6</div>
<p>Every command takes <code>--json</code> to print the records instead of a table, and <code>--api &lt;base&gt;</code> to read from a local mirror of the API instead of the network. <code>${escapeHtml(cliName)} help</code> lists the rest.</p>
</div>

<div class="panel prose">
<h2>The query this exists for</h2>
<p>Which of the models I depend on have a retirement floor inside my planning horizon, and what the provider's own document recommends instead. One command:</p>
<div class="shell">${escapeHtml(npx)} retiring --within 90d --models claude-opus-4-8,claude-3-5-sonnet-20241022</div>
<p>The names are the provider's own API model names, because that is the namespace the retirement dates are published in. They are <strong>not</strong> OpenRouter catalog ids and this archive does not join the two: <code>anthropic/claude-opus-4.1</code> and <code>claude-opus-4-1-20250805</code> are different strings issued by different parties, and deciding they name the same model is a judgement nothing here makes on a reader's behalf. Pass a catalog id and the command says so rather than guessing.</p>
</div>

<div class="panel prose">
<h2>What is unique, what is merely accessible, and what is a commodity</h2>
<ul class="tierlist">
<li><span class="tiername">Unique</span><span class="tierwhat">The arena codename map, the upstream pull-request leak feed, the documentation differ across nine providers, and the join of all of them to catalog and lifecycle state in one surface. Published by nobody else, in this form, that we could find.</span></li>
<li><span class="tiername">Better because it is reachable</span><span class="tierwhat">Price history, lifecycle events and catalog history. These exist elsewhere and the incumbents are good. The claim here is shape, not accuracy and not price, and it is narrower than it used to be: an earlier version of this sentence said one of them had &quot;no API at all&quot;, which was wrong. pricepertoken.com serves a keyless <code>/_payload.json</code> carrying its pricing data and model changelog, so price history there is reachable, just undocumented and shaped for its own front end. llmstatus.ai redirects <code>/rss.xml</code> to a sign-in page. models.dev publishes current state, with its history existing solely as a diff over thousands of sync commits. What is different here is that every value is addressed by commit and linked to the bytes it came from.</span></li>
<li><span class="tiername">Free commodity</span><span class="tierwhat">The current model list, current prices, current context windows and current deprecation status. Several people serve this and it costs nothing to serve. It is the front door, not the product, and it is deliberately narrow: this archive tracks one catalogue and a handful of vendor documentation indexes, so its model list is a few hundred rows where models.dev publishes several thousand across two hundred providers. If a current list of everything is what you want, that is the better source and it is free.</span></li>
</ul>
</div>

<div class="panel prose">
<h2>Rules a consumer should know before parsing</h2>
<p>A timestamp is an object, never a bare string: <code>{"value": "...", "field": "origin_date"}</code> or <code>"field": "observed_at"</code>. <code>origin_date</code> is when the provider generated the bytes, <code>observed_at</code> is when this collector saw them. They are not interchangeable and neither is silently substituted for the other.</p>
<p><code>precision_seconds</code> is the measured worst-case first-seen error for that source, taken from the largest gap between consecutive accepted captures of it. It is <code>null</code> when unbounded, meaning the archive holds fewer than two captures. <strong>Null is not zero error.</strong></p>
<p><code>first_seen_in_catalog_at</code> is a day or it is null, and it is null wherever <code>precision_seconds</code> is wider than a day. Under the values this archive measures today that is every source, so the field publishes null rather than a date it has not earned. That is the rule working, not the API failing.</p>
<p>Every <code>sentence</code> names an artifact as its subject. No record here says why a value changed, and none should be re-published as if it did.</p>
</div>

<div class="panel prose">
<h2>Terms</h2>
<p>Free. No key, no signup, no rate limit imposed by this project, and GitHub Pages sends <code>access-control-allow-origin: *</code> so it works from a browser. Mirror it if you depend on it: <code>wget -r</code> over the directory in <code>index.json</code> takes the whole thing.</p>
</div>`;
  return layout({ title: 'API and CLI - llm-catalog-archive', depth: 0, body, active: 'api' });
}

export function renderAboutPage(): string {
  const body = `<p class="eyebrow">About</p>
<h1>What this archive stores</h1>
<p class="lede">A collector fetches a fixed list of public endpoints on a schedule and commits every response verbatim, with the response headers beside it. The git history IS the archive and it is never rewritten. Everything published here is derived from that history by replay, so any page can be regenerated from scratch and checked against the bytes it came from.</p>

<div class="panel prose">
<h2>How a sentence gets onto this site</h2>
<p>A stored artifact changes. A pure function over the two versions emits a typed claim with a fixed template. The template is filled from the diff and from the sidecar committed beside the bytes. There is no language model anywhere in the generator, no summarisation step, and no editorial pass.</p>
<p>Every value read out of a stored payload is printed inside quotes, and a value carrying a quote of its own has it neutralised before it is printed. That is not typography. A value interpolated bare into a sentence is prose this project publishes under its own byline, and a catalogue id or a pull-request title is chosen by somebody else.</p>
</div>

<div class="panel prose">
<h2>What a sentence here never says</h2>
<p>The subject of every rendered sentence is an artifact, never a company and never a reason. "OpenRouter's catalog context_length for X changed from A to B" is an observation. "X's usable context was cut" is an inference, and one live case shows why it is the wrong one: a catalogue context_length rose from 1048576 to 1310720 while the top_provider.context_length recorded beside it fell from 1048576 to 262144. The headline number went up by a quarter while what the routed provider serves fell by three quarters.</p>
</div>

<div class="panel prose">
<h2>Personal data, stated rather than implied</h2>
<p>Most sources here are vendor documentation indexes, sitemaps, status feeds and machine-readable catalogues. Three are not, and they are not equally risky, so this section names which is which rather than grouping them.</p>
<p>The one that actually reached these pages is <code>modelsdev-commits</code>, an Atom feed of commits to models.dev. An Atom commit entry carries an <code>&lt;email&gt;</code> for every author and for every <code>Co-authored-by:</code> trailer, and the change pages render a diff of the stored bytes. Nine distinct addresses were published that way, four of them personal. They are no longer rendered: every address in a displayed diff is masked, with no exception for role or noreply addresses, because a rule that spared those would have to judge which addresses are personal and would publish a private one every time it judged wrong. The count of masked addresses is printed under each diff that has any.</p>
<p>The other two are <code>transformers-pulls</code> and <code>vllm-pulls</code>, GitHub pull-request searches whose payloads carry each pull request's full description text and its author's login, numeric id, avatar URL and profile URL. Those fields are stored but never rendered: the derivation projects only the pull request's number, title, state and merge timestamp. That was already true when this section named these two sources and did not name the one whose data was on the page, which is the failure mode a disclosure like this is supposed to prevent.</p>
<p>Masking is a property of the publication, not of the archive. The stored bytes still contain the addresses, and every diff sits beside a permalink to the exact artifact at the exact commit, so nothing here is unverifiable. That is also the unpaid half of the tradeoff: this repository mirrors content written by named private individuals and recommits it into a history that is never rewritten, so an erasure request against it cannot be satisfied without violating the archive's own central rule. That is a real cost and not a technicality.</p>
</div>

<div class="panel prose">
<h2>Timestamps</h2>
<p>A published timestamp is the sidecar's <code>origin_date</code>, which is the response date minus its Age header, so it is when the provider generated the bytes. Where the provider sent no Age, the page shows <code>observed_at</code>, which is when this collector saw them, LABELLED as observed. One captured response carried an origin fourteen hours before the fetch, so the two are not interchangeable and neither is silently substituted for the other.</p>
<p>A first-seen date is shown only where the measured worst-case error for that source is narrower than the resolution being printed. A source captured once a day cannot support a claim about which day something appeared, so that page prints the reason instead of the date.</p>
</div>

<div class="panel prose">
<h2>Nothing is deleted</h2>
<p>A change that turns out to be wrong is retracted, not removed: the page and its artifact link stay resolvable and are marked. The retraction ledger and the leaks desk's accuracy ledger are both append-only and both enforced by a workflow that fails any diff removing or modifying a line.</p>
<p>That rule has been paid for once. A vendor published a live API key inside its own public documentation file, and the collector's credential gate now holds any snapshot carrying a credential pattern out of the archive rather than committing it. Separately, a test fixture captured from a challenge page carried an AWS access key id and a set of presigned URLs, all of which have since expired. The working tree, the tracked tree and every built page are clean, and the fixture no longer asserts against a real credential. What remains is in history, because history is not rewritten here, and saying so is better than letting a reader who finds it conclude nobody looked.</p>
</div>`;
  return layout({ title: 'About - llm-catalog-archive', depth: 0, body, active: 'about' });
}

// ---------------------------------------------------------------------------
// The everything feed
// ---------------------------------------------------------------------------

const EVERYTHING_FEED_LIMIT = 50;

/**
 * RSS 2.0 over the whole publication.
 *
 * SEPARATE FROM feed.xml, which stays exactly what it was. feed.xml is one item
 * per artifact change and its guids are live in whatever readers already
 * subscribe to it; repointing it at a different stream would silently replace
 * every subscriber's feed with a different publication.
 *
 * The link on an item is the CHANGE PAGE anchored at the source, which is the
 * evidence the claim was read out of, and the guid is the item's derivation id
 * marked `isPermaLink="false"` because it is an identity and not an address.
 * Two items derived from one commit therefore share a link and differ in guid,
 * which is the correct shape: they are two claims about one piece of evidence.
 */
/**
 * A filtered feed: the same items, the same claims, a narrower stream.
 *
 * WHY THERE ARE MORE THAN TWO FEEDS NOW. The publication carried 16
 * micro-categories and a leaks desk, and exactly two feeds, so the only way to
 * follow rumors and leaks was to subscribe to everything and filter by hand in
 * a reader. everything.xml already emitted `<category>` per item, so the
 * grouping was done and only the addresses were missing.
 *
 * It adds no claim. Every sentence is the one the deriving module already
 * wrote, and nothing here recomposes, merges or summarises.
 */
export function renderEverythingFeed(
  feed: FeedItem[],
  siteUrl: string = SITE_URL,
  channel: { title: string; path: string; description: string } = {
    title: 'llm-catalog-archive: everything',
    path: EVERYTHING_FEED_PATH,
    description: 'Every typed claim the archive supports, derived by replay from git history over raw/.',
  },
): string {
  const items = feed
    .slice(0, EVERYTHING_FEED_LIMIT)
    .map((item) => {
      // The TYPE page, not the change page. Every item appears on its own
      // micro-category page, which is uncapped, so this address always exists
      // and always contains the sentence in the title. The change page is still
      // one click away from the item, under its own sha link.
      const url = `${siteUrl}/${typePagePath(item.type)}#${feedItemAnchor(item)}`;
      const when = item.stamp === null ? 'no timestamp recorded' : `${formatUtc(item.stamp.iso)} (${item.stamp.kind})`;
      const tier = item.tier === null ? '' : ` Sourcing tier ${item.tier}.`;
      const description = `${item.sentence} Type ${item.type}. Timestamp ${when}.${tier} Raw artifact at this commit: ${artifactPermalink(item.sha, item.path)}`;
      const pubDate = item.stamp === null ? '' : `\n<pubDate>${escapeHtml(rfc822(item.stamp.iso))}</pubDate>`;
      return `<item>
<title>${escapeHtml(item.sentence)}</title>
<link>${escapeHtml(url)}</link>
<guid isPermaLink="true">${escapeHtml(url)}</guid>
<category>${escapeHtml(item.type)}</category>${pubDate}
<description>${escapeHtml(description)}</description>
</item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${escapeHtml(channel.title)}</title>
<link>${escapeHtml(siteUrl)}/index.html</link>
<atom:link href="${escapeHtml(siteUrl)}/${channel.path}" rel="self" type="application/rss+xml"/>
<description>${escapeHtml(channel.description)}</description>
<language>en</language>
${items}
</channel>
</rss>
`;
}
