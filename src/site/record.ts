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
 * The `/site` segment is not a typo. GitHub Pages' branch source can publish
 * the repository root or `/docs`, and nothing else, so `docs/site/` is reached
 * at `<pages-root>/site/`. Override with LCA_SITE_URL if the repository is
 * later switched to the Actions Pages deployment, which can publish
 * `docs/site/` as the root.
 */
export const SITE_URL = 'https://maxwellbrohm.github.io/llm-catalog-archive/site';

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
 * the committed docs/site/ would churn for no reason.
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
