/**
 * The data a page is rendered from, and the pure helpers every renderer shares.
 *
 * Nothing in this file, or in render.ts, reads git or the filesystem.
 * src/site/history.ts is the only module that does. A page is therefore a pure
 * function of a ChangeRecord and can be asserted against from a literal, which
 * is what makes the guards below mutation-testable at all.
 *
 * One thing this type deliberately does NOT carry: commit time. Spec section 9
 * fixes every published timestamp to `origin_date` from the sidecar, falling
 * back to `observed_at`, because one captured response had an origin 14 hours
 * before we saw it. A record with no committer clock in it cannot render one by
 * accident.
 */

/** Where a page links its evidence. */
export const REPO_URL = 'https://github.com/MaxwellBrohm/llm-catalog-archive';

/**
 * Where the generated pages are served from. Used only by the feed, which needs
 * absolute URLs; every link inside a page is relative and does not care.
 *
 * There is no `/site` segment any more. The generated site is deployed by
 * Actions with the build directory as the artifact ROOT, so a page that used to
 * be reached at `<pages-root>/site/x.html` is now reached at
 * `<pages-root>/x.html`. Override with LCA_SITE_URL when building for anywhere
 * else.
 */
export const SITE_URL = 'https://maxwellbrohm.github.io/llm-catalog-archive';

/**
 * The CLI's command name, and the spec `npx` resolves it from.
 *
 * A GitHub spec rather than a bare package name because this package is not on
 * npm and saying `npx llmcat` on the docs page would send a reader to whatever
 * somebody else has published under that name. `npx github:owner/repo` installs
 * from this repository, which is the repository the docs page is served from.
 */
export const CLI_NAME = 'llmcat';
export const REPO_SLUG = 'github:MaxwellBrohm/llm-catalog-archive';

export type DiffLineKind = 'add' | 'remove' | 'context' | 'hunk';

export type DiffLine = {
  kind: DiffLineKind;
  /** The line with its leading +/-/space marker removed. Third-party bytes. */
  text: string;
  /** True when `text` was cut at MAX_LINE_CHARS. */
  truncated: boolean;
};

/** The subset of the committed sidecar a page shows, spec section 9. */
export type SidecarView = {
  observedAt: string | null;
  originDate: string | null;
  status: number | null;
  finalUrl: string | null;
  etag: string | null;
  lastModified: string | null;
  date: string | null;
  age: string | null;
  cacheControl: string | null;
  cfCacheStatus: string | null;
  contentEncoding: string | null;
  contentLength: string | null;
};

export type ArtifactChange = {
  sourceId: string;
  path: string;
  /** The git status letter, narrowed. Nothing here infers "first release". */
  kind: 'added' | 'modified';
  linesAdded: number;
  linesRemoved: number;
  /** Size of the stored blob at this commit, measured with `git cat-file -s`. */
  bytes: number | null;
  sidecar: SidecarView | null;
  diff: DiffLine[];
  diffTruncated: boolean;
};

/**
 * One line of meta/retractions.jsonl, resolved against a commit.
 *
 * The record schema belongs to sub-project D. What A1 fixes is the semantics:
 * a retracted change stays in the archive and stays resolvable at its
 * permalink, marked retracted, never deleted.
 */
export type Retraction = {
  sha: string;
  /** When set, only this artifact within the commit is retracted. */
  path: string | null;
  reason: string | null;
};

export type ChangeRecord = {
  /** Full 40 character sha. The permalink rests on this being the commit sha. */
  sha: string;
  /** The collector's own commit subject, verbatim from git. */
  subject: string;
  artifacts: ArtifactChange[];
  retraction: Retraction | null;
};

/** How much of a diff a page shows before it stops and links the artifact. */
export const MAX_DIFF_LINES = 400;

/**
 * How wide one rendered diff line gets. Not decoration: openrouter-models is a
 * single 685 KB JSON line, so an untruncated first capture would be one page
 * carrying most of a megabyte on one row.
 */
export const MAX_LINE_CHARS = 300;

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape every value that reaches a page.
 *
 * Diff content is third-party bytes going into a public document, and one of
 * the archived sources is 797 KB of provider-authored markdown. A single regex
 * pass rather than chained replaces, because chained replaces have to escape
 * the ampersand first or they double-encode their own output.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/**
 * The artifact permalink, spec section 11.
 *
 * The sha is the commit that changed the artifact, never HEAD and never a
 * branch name. R5 overwrites one path in place, so a HEAD link on a change page
 * would show whatever the artifact became rather than what this change made it,
 * and the evidence the auto-publish tier rests on would quietly rot with every
 * later capture.
 */
export function artifactPermalink(sha: string, path: string, repoUrl: string = REPO_URL): string {
  return `${repoUrl}/blob/${sha}/${path}`;
}

/** The commit itself, for a reader who wants the whole diff rather than ours. */
export function commitPermalink(sha: string, repoUrl: string = REPO_URL): string {
  return `${repoUrl}/commit/${sha}`;
}

export type Stamp = { iso: string; kind: 'origin' | 'observed' };

/**
 * Which timestamp a page is allowed to show, and what it must be called.
 *
 * `origin_date` is the response `date` minus `age`, so it is when the provider
 * generated the bytes. `observed_at` is when the runner saw them. They are not
 * interchangeable: one captured response carried an origin 14 hours before the
 * fetch. Where the provider sent no Age the sidecar records a null origin, and
 * the page shows `observed_at` LABELLED as observed rather than silently
 * substituting it under the origin label.
 */
export function stampFor(sidecar: SidecarView | null): Stamp | null {
  if (sidecar === null) return null;
  if (sidecar.originDate !== null) return { iso: sidecar.originDate, kind: 'origin' };
  if (sidecar.observedAt !== null) return { iso: sidecar.observedAt, kind: 'observed' };
  return null;
}

/** The stamp a whole commit is filed under: the first artifact that has one. */
export function recordStamp(record: ChangeRecord): Stamp | null {
  for (const a of record.artifacts) {
    const s = stampFor(a.sidecar);
    if (s !== null) return s;
  }
  return null;
}

/**
 * Newest first, by the timestamp the page actually shows.
 *
 * Not by commit order. One collector run commits its thirteen sources within a
 * few seconds of each other while their `origin_date` values are spread over
 * eighteen hours, so commit order puts 06:24 between 20:25 and 05:28 on the
 * same page and a reader has no way to tell that from a bug. Ordering by the
 * displayed stamp is not a claim about anything; it is the list being in the
 * order it is printed in.
 *
 * Records with no usable stamp sort last and keep their relative input order,
 * which Array.prototype.sort guarantees.
 */
export function sortByStampDesc(records: ChangeRecord[]): ChangeRecord[] {
  // A record with no usable timestamp gets the lowest key there is, which puts
  // it last with no null branch in the comparator. Comparing keys for equality
  // first is what keeps -Infinity minus -Infinity, which is NaN, out of the
  // subtraction, and it is also where the index tie-break lands.
  const key = (r: ChangeRecord): number => {
    const s = recordStamp(r);
    if (s === null) return -Infinity;
    const ms = Date.parse(s.iso);
    return Number.isNaN(ms) ? -Infinity : ms;
  };
  // Ties keep the order the archive committed them in, which Array.prototype
  // .sort has guaranteed since ES2019. An index decoration was tried instead
  // and removed: mutation testing showed both of its arms surviving, because a
  // wrong tie-break is invisible through a sort that was already stable.
  return [...records].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    // Two records with no usable timestamp both key to -Infinity, and
    // -Infinity minus -Infinity is NaN, which the spec leaves free to produce
    // any order at all. This branch is not observable through this function on
    // any engine that already sorts stably, and it is here so that the
    // comparator never returns NaN in the first place.
    return ka === kb ? 0 : kb - ka;
  });
}

/** True when this artifact, inside this commit, is covered by a retraction. */
export function isArtifactRetracted(record: ChangeRecord, path: string): boolean {
  if (record.retraction === null) return false;
  if (record.retraction.path === null) return true;
  return record.retraction.path === path;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * A fixed UTC rendering. Not toLocaleString: that reads the runner's ICU data
 * and locale, so the same archive would render differently on two machines and
 * the generated site would not be byte-reproducible across machines.
 */
export function formatUtc(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  const month = MONTHS[d.getUTCMonth()] ?? '';
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()} ${hh}:${mm} UTC`;
}

/** The UTC calendar day a stamp falls in, as YYYY-MM-DD, for grouping. */
export function utcDay(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Thousands separators without touching the runner's locale. */
export function formatInt(n: number): string {
  const neg = n < 0;
  const digits = String(Math.abs(Math.trunc(n)));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return neg ? `-${out}` : out;
}

/** `raw/<source-id>/<file>` is the only shape R5 allows under raw/. */
export function sourceIdFromPath(path: string): string | null {
  const m = /^raw\/([a-z0-9-]+)\/[^/]+$/.exec(path);
  return m === null ? null : (m[1] ?? null);
}

export function changePagePath(sha: string): string {
  return `changes/${sha}.html`;
}

export function sourcePagePath(sourceId: string): string {
  return `sources/${sourceId}.html`;
}

/**
 * A thread's permalink. It lives here rather than in render.ts because two
 * renderers now build it: the pages, and the 3D front door's tab data. One
 * address, constructed once. render.ts re-exports it so its existing callers
 * are unaffected.
 */
export function threadPagePath(slug: string): string {
  return `threads/${slug}.html`;
}

export const THREADS_INDEX_PATH = 'threads/index.html';

/**
 * The directory the site used to be served from, back when GitHub Pages
 * published it from the `main` branch at `/docs` and `docs/site/` therefore
 * landed one level below the Pages root.
 *
 * Spec section 10 treats a change page's URL as a permalink, so moving the site
 * to the Pages root does not free those URLs: it obliges the new site to answer
 * at them. Every page keeps a stub here that forwards to its new address.
 */
export const LEGACY_PREFIX = 'site';

/** Where the stub for a page now at `p` has to be written. */
export function legacyPagePath(p: string): string {
  return `${LEGACY_PREFIX}/${p}`;
}

/**
 * What that stub points at, relative to itself.
 *
 * One `../` escapes the legacy prefix and one more is needed per directory the
 * page itself sits in, so `site/index.html` reaches `../index.html` and
 * `site/changes/<sha>.html` reaches `../../changes/<sha>.html`.
 */
export function legacyRedirectTarget(p: string): string {
  const depth = p.split('/').length;
  return `${'../'.repeat(depth)}${p}`;
}
