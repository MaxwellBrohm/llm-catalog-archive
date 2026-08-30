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

import { canRenderAt, claimSentence, DAY_SECONDS, type DerivedEvent } from '../derive/events.js';
import type { Thread, ThreadSet } from '../derive/threads.js';
import {
  artifactPermalink,
  changePagePath,
  commitPermalink,
  escapeHtml,
  formatInt,
  formatUtc,
  isArtifactRetracted,
  recordStamp,
  REPO_URL,
  SITE_URL,
  sourcePagePath,
  stampFor,
  utcDay,
  MAX_DIFF_LINES,
  MAX_LINE_CHARS,
  type ArtifactChange,
  type ChangeRecord,
  type SidecarView,
  type Stamp,
} from './record.js';

/** Relative prefixes, so a page at any depth links the same targets. */
function links(depth: number): { up: string } {
  return { up: '../'.repeat(depth) };
}

function plural(n: number, word: string): string {
  return `${formatInt(n)} ${word}${n === 1 ? '' : 's'}`;
}

function layout(opts: { title: string; depth: number; body: string }): string {
  const { up } = links(opts.depth);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<link rel="stylesheet" href="${up}style.css">
<link rel="alternate" type="application/rss+xml" title="llm-catalog-archive" href="${up}feed.xml">
</head>
<body>
<header class="site-head"><div class="wrap">
<a class="brand" href="${up}index.html">llm-catalog-archive</a>
<nav>
<a href="${up}index.html">Changes</a>
<a href="${up}threads/index.html">Threads</a>
<a href="${up}feed.xml">Feed</a>
<a href="${REPO_URL}">Repository</a>
</nav>
</div></header>
<main><div class="wrap">
${opts.body}
</div></main>
<footer class="site-foot"><div class="wrap">
Generated from git history over <code>raw/</code>. Timestamps are the sidecar's
<code>origin_date</code> where the provider sent an <code>Age</code> header, and
<code>observed_at</code>, labelled as such, where it did not.
</div></footer>
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
  const body = a.diff
    .map((l) => {
      const cut = l.truncated ? '<span class="cut">&#8230;</span>' : '';
      return `<div class="dl dl-${l.kind}"><span class="g">${GUTTER[l.kind]}</span><code>${escapeHtml(l.text)}${cut}</code></div>`;
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
  return layout({ title: `${short} - llm-catalog-archive`, depth: 1, body });
}

type Row = { record: ChangeRecord; artifact: ArtifactChange };

function rowsOf(records: ChangeRecord[]): Row[] {
  return records.flatMap((record) => record.artifacts.map((artifact) => ({ record, artifact })));
}

function rowHtml(row: Row, depth: number): string {
  const { up } = links(depth);
  const { record, artifact } = row;
  const stamp = stampFor(artifact.sidecar);
  const retracted = isArtifactRetracted(record, artifact.path);
  return `<tr>
<td class="mono"><a href="${up}${sourcePagePath(artifact.sourceId)}">${escapeHtml(artifact.sourceId)}</a></td>
<td class="mono">${escapeHtml(artifact.path)}${retracted ? ' <span class="badge badge-retracted">retracted</span>' : ''}</td>
<td class="mono">${countsHtml(artifact)}</td>
<td class="mono">${stampHtml(stamp)}</td>
<td class="mono"><a href="${up}${changePagePath(record.sha)}">${escapeHtml(record.sha.slice(0, 7))}</a></td>
</tr>`;
}

function changesTable(rows: Row[], depth: number): string {
  return `<div class="table-scroll"><table class="changes">
<thead><tr><th>Source</th><th>Artifact</th><th>Lines</th><th>Timestamp</th><th>Change</th></tr></thead>
<tbody>
${rows.map((r) => rowHtml(r, depth)).join('\n')}
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

export function renderIndexPage(records: ChangeRecord[]): string {
  const sourceIds = [...new Set(rowsOf(records).map((r) => r.artifact.sourceId))].sort();
  const perSource = new Map<string, number>();
  for (const row of rowsOf(records)) perSource.set(row.artifact.sourceId, (perSource.get(row.artifact.sourceId) ?? 0) + 1);

  const cards = sourceIds
    .map(
      (id) => `<div class="source-card">
<a href="${sourcePagePath(id)}">${escapeHtml(id)}</a>
<p>${plural(perSource.get(id) ?? 0, 'change')}</p>
</div>`,
    )
    .join('\n');

  const days = byDay(records)
    .map(
      (g) => `<section class="day">
<h2>${escapeHtml(g.day)}</h2>
${changesTable(rowsOf(g.records), 0)}
</section>`,
    )
    .join('\n');

  const body = `<p class="eyebrow">Archive</p>
<h1>Change log</h1>
<p class="lede">One entry per commit that changed a stored artifact under <code>raw/</code>. ${plural(records.length, 'change')} across ${plural(sourceIds.length, 'source')}, newest first.</p>
<div class="panel">
<h2>Sources</h2>
<div class="grid-sources">
${cards}
</div>
</div>
${days}`;
  return layout({ title: 'llm-catalog-archive', depth: 0, body });
}

export function renderSourcePage(sourceId: string, records: ChangeRecord[]): string {
  const rows = rowsOf(records).filter((r) => r.artifact.sourceId === sourceId);
  const latest = rows[0];
  const latestStamp = latest === undefined ? null : stampFor(latest.artifact.sidecar);
  const finalUrl = latest?.artifact.sidecar?.finalUrl ?? null;
  const paths = [...new Set(rows.map((r) => r.artifact.path))].sort();

  const body = `<p class="eyebrow">Source</p>
<h1 class="sha-title">${escapeHtml(sourceId)}</h1>
<dl class="facts">
<div class="fact"><dt>Recorded changes</dt><dd class="big">${formatInt(rows.length)}</dd></div>
<div class="fact"><dt>Latest recorded change</dt><dd>${stampHtml(latestStamp)}</dd></div>
<div class="fact"><dt>Stored path</dt><dd>${paths.map((p) => escapeHtml(p)).join('<br>')}</dd></div>
<div class="fact"><dt>Final URL at the latest change</dt><dd>${finalUrl === null ? 'not recorded' : `<a href="${escapeHtml(finalUrl)}">${escapeHtml(finalUrl)}</a>`}</dd></div>
</dl>
${changesTable(rows, 1)}`;
  return layout({ title: `${sourceId} - llm-catalog-archive`, depth: 1, body });
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

export function threadPagePath(slug: string): string {
  return `threads/${slug}.html`;
}

export const THREADS_INDEX_PATH = 'threads/index.html';

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
    rows.push(['first-seen worst-case error', `${formatInt(event.precisionSeconds)} seconds`]);
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
 * One event on a thread.
 *
 * The artifact link uses THIS EVENT'S commit sha, never HEAD and never a branch
 * name. R5 overwrites one path in place, so a HEAD link would show whatever the
 * artifact later became rather than the bytes the claim was read out of, and
 * the evidence the auto-publish tier rests on would rot with every capture.
 */
function eventHtml(event: DerivedEvent, depth: number): string {
  const { up } = links(depth);
  const permalink = artifactPermalink(event.sha, event.path);
  const facts = eventFactsHtml(event);
  return `<li class="event">
<p class="claim">${escapeHtml(claimSentence(event))}</p>
<p class="event-meta"><span class="badge badge-type">${escapeHtml(event.type)}</span> ${stampHtml(event.stamp)} &middot; <a href="${up}${sourcePagePath(event.sourceId)}">${escapeHtml(event.sourceId)}</a> &middot; <a href="${up}${changePagePath(event.sha)}">${escapeHtml(event.sha.slice(0, 7))}</a> &middot; <a href="${escapeHtml(permalink)}">raw artifact at this commit</a></p>
${facts}
</li>`;
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
<h1 class="sha-title">${escapeHtml(thread.entity.label)}</h1>
<p class="sha-full">${escapeHtml(thread.entity.id)}</p>
<dl class="facts">
<div class="fact"><dt>Events</dt><dd class="big">${formatInt(thread.events.length)}</dd></div>
<div class="fact"><dt>First event in the archive</dt><dd>${stampHtml(thread.firstSeen)}</dd></div>
<div class="fact"><dt>Last activity</dt><dd>${stampHtml(thread.lastActivity)}</dd></div>
</dl>
<ol class="events">
${thread.events.map((e) => eventHtml(e, 1)).join('\n')}
</ol>`;
  return layout({ title: `${thread.entity.label} - llm-catalog-archive`, depth: 1, body });
}

function threadRowHtml(thread: Thread): string {
  return `<tr>
<td class="mono"><a href="${escapeHtml(thread.slug)}.html">${escapeHtml(thread.entity.label)}</a></td>
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
<div class="table-scroll"><table class="changes">
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
      : `<ol class="events">\n${set.held.map((e) => eventHtml(e, 1)).join('\n')}\n</ol>`;

  const body = `<p class="eyebrow">Threads</p>
<h1>Entity threads</h1>
<p class="lede">${plural(set.threads.length, 'thread')} carrying ${plural(totalEvents, 'event attachment')}, most recently active first. An event attaches to every entity it names, so one price change appears on the model's thread and on its lab's.</p>
${sections}
<section class="day">
<h2>Held</h2>
<p class="note">${plural(set.held.length, 'event')} could not be attached to an entity mechanically, and nothing here guesses. Product spec section 4.</p>
${held}
</section>`;
  return layout({ title: 'Threads - llm-catalog-archive', depth: 1, body });
}
