/**
 * The only module in the site generator that reads git.
 *
 * Everything downstream of readChangeRecords and readContentChanges is a pure
 * function of what they return, which is what lets the page guards and the
 * whole of src/derive/ be tested from literals instead of from a fixture
 * repository.
 *
 * Two things are read AT THE COMMIT rather than at HEAD, and both are the whole
 * point of the design:
 *
 *   - the sidecar, because `observed_at` and `origin_date` describe the bytes
 *     stored by that commit and R5 overwrites the sidecar in place;
 *   - the artifact's size, for the same reason.
 *
 * Commit time is deliberately never read. Spec section 9 fixes every published
 * timestamp to the sidecar, and a field that is never fetched cannot leak into
 * a page.
 */

import { git } from '../git.js';
import { parseUnifiedDiff } from './diff.js';
import {
  sourceIdFromPath,
  stampFor,
  type ArtifactChange,
  type ChangeRecord,
  type Retraction,
  type SidecarView,
} from './record.js';
import { retractionFor } from './retractions.js';
import type { ContentChange, Tier } from '../derive/events.js';

/**
 * The field separator inside one `git log` line. A unit separator rather than a
 * space or a pipe, because the second field is the collector's commit subject
 * and a subject is free text.
 */
const UNIT = '\u001f';

export type CommitRef = { sha: string; subject: string };

/**
 * `git log --format=%H<US>%s` output to refs. Pure, so the format is asserted.
 *
 * There is no separate empty-line check: an empty line contains no separator,
 * so the one below already drops it. Mutation testing found the extra guard by
 * surviving a replacement with `false`, which is what a guard that never
 * decides anything looks like.
 */
export function parseLog(stdout: string): CommitRef[] {
  const out: CommitRef[] = [];
  for (const line of stdout.split('\n')) {
    const at = line.indexOf(UNIT);
    if (at === -1) continue;
    out.push({ sha: line.slice(0, at), subject: line.slice(at + 1) });
  }
  return out;
}

export type NameStatusEntry = { status: string; path: string };

/**
 * `git show --name-status` output to entries. Pure.
 *
 * A line with no tab has the same text as its own first and last field, so
 * `path === status` drops it: an empty line, a whitespace-only line and a bare
 * status letter all fall out there, and the separate blank-line check that used
 * to sit above was redundant. The two `undefined` arms cannot fire at runtime
 * (`split` always yields at least one element); they are there because
 * noUncheckedIndexedAccess types an index as possibly undefined.
 */
export function parseNameStatus(stdout: string): NameStatusEntry[] {
  const out: NameStatusEntry[] = [];
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t');
    const status = parts[0];
    // A rename prints `R100<tab>old<tab>new`; the destination is the last field.
    const path = parts[parts.length - 1];
    if (status === undefined || path === undefined || path === status) continue;
    out.push({ status, path });
  }
  return out;
}

/**
 * A stored artifact is `raw/<source-id>/<file>` and is not the sidecar. The
 * sidecar is evidence about an artifact, not an artifact, so a commit that
 * changed only headers.json is not a change to the archive's content.
 *
 * There is no `startsWith('raw/')` line here any more. It was redundant:
 * sourceIdFromPath's pattern is anchored at `raw/`, so every path the removed
 * line rejected was already rejected below it, and mutation testing found it by
 * surviving a replacement with `false`.
 */
export function isArtifactPath(path: string): boolean {
  if (path.endsWith('/headers.json')) return false;
  return sourceIdFromPath(path) !== null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** The committed sidecar JSON, narrowed to what a page shows. Pure. */
export function sidecarViewFrom(json: unknown): SidecarView | null {
  // `typeof null` is 'object', so the null arm is load-bearing rather than
  // belt-and-braces: without it the field reads below throw.
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const j = json as Record<string, unknown>;
  const status = j['status'];
  return {
    observedAt: str(j['observed_at']) ?? str(j['fetchedAt']),
    originDate: str(j['origin_date']),
    status: typeof status === 'number' ? status : null,
    finalUrl: str(j['finalUrl']),
    etag: str(j['etag']),
    lastModified: str(j['lastModified']),
    date: str(j['date']),
    age: str(j['age']),
    cacheControl: str(j['cacheControl']),
    cfCacheStatus: str(j['cfCacheStatus']),
    contentEncoding: str(j['contentEncoding']),
    contentLength: str(j['contentLength']),
  };
}

function blobAt(cwd: string, sha: string, path: string): string | null {
  const r = git(['show', `${sha}:${path}`], cwd);
  return r.status === 0 ? r.stdout : null;
}

function blobSizeAt(cwd: string, sha: string, path: string): number | null {
  const r = git(['cat-file', '-s', `${sha}:${path}`], cwd);
  if (r.status !== 0) return null;
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : null;
}

function sidecarAt(cwd: string, sha: string, sourceId: string): SidecarView | null {
  const text = blobAt(cwd, sha, `raw/${sourceId}/headers.json`);
  if (text === null) return null;
  try {
    return sidecarViewFrom(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Every commit that changed a stored artifact, newest first.
 *
 * `--no-renames` because a rename under raw/ would otherwise render as a change
 * to a path that never existed under that name. R5 gives every source one
 * stable path, so a rename is a repository event and not an artifact change.
 */
export function readChangeRecords(cwd: string, retractions: Retraction[] = []): ChangeRecord[] {
  const log = git(['log', '--no-merges', `--format=%H${UNIT}%s`, '--', 'raw/'], cwd);
  if (log.status !== 0) throw new Error(`git log failed: ${log.stderr}`);

  const records: ChangeRecord[] = [];
  for (const ref of parseLog(log.stdout)) {
    const names = git(['show', '--format=', '--name-status', '--no-renames', ref.sha, '--', 'raw/'], cwd);
    if (names.status !== 0) throw new Error(`git show --name-status failed for ${ref.sha}: ${names.stderr}`);

    const artifacts: ArtifactChange[] = [];
    for (const entry of parseNameStatus(names.stdout)) {
      if (!isArtifactPath(entry.path)) continue;
      if (entry.status !== 'A' && entry.status !== 'M') continue;
      const sourceId = sourceIdFromPath(entry.path);
      if (sourceId === null) continue;

      const raw = git(['show', '--format=', '--unified=3', '--no-renames', ref.sha, '--', entry.path], cwd);
      if (raw.status !== 0) throw new Error(`git show failed for ${ref.sha} ${entry.path}: ${raw.stderr}`);
      const parsed = parseUnifiedDiff(raw.stdout);

      artifacts.push({
        sourceId,
        path: entry.path,
        kind: entry.status === 'A' ? 'added' : 'modified',
        linesAdded: parsed.linesAdded,
        linesRemoved: parsed.linesRemoved,
        bytes: blobSizeAt(cwd, ref.sha, entry.path),
        sidecar: sidecarAt(cwd, ref.sha, sourceId),
        diff: parsed.lines,
        diffTruncated: parsed.truncated,
      });
    }

    if (artifacts.length === 0) continue;
    records.push({
      sha: ref.sha,
      subject: ref.subject,
      artifacts,
      retraction: retractionFor(retractions, ref.sha),
    });
  }
  return records;
}

/**
 * The same commits readChangeRecords walks, carrying the FULL stored bytes on
 * both sides instead of a rendered diff.
 *
 * This exists because the rendered diff cannot feed the deriver, and the reason
 * is specific rather than stylistic: openrouter-models is 685 KB of JSON on ONE
 * line, so parseUnifiedDiff sees exactly one removed line and one added line
 * and MAX_LINE_CHARS cuts both at 300 characters. Every price and context
 * transition in the archive lives past character 300. The deriver therefore
 * reads blobs, and it reads them AT THE COMMIT and AT ITS PARENT, which is
 * where R5's overwrite-in-place would otherwise destroy the before side.
 *
 * `tierOf` is passed in rather than read from meta/sources.json here, because
 * this module reads git and nothing else, and the tier decides an event's
 * first-seen precision.
 */
export function readContentChanges(cwd: string, tierOf: (sourceId: string) => Tier): ContentChange[] {
  const log = git(['log', '--no-merges', `--format=%H${UNIT}%s`, '--', 'raw/'], cwd);
  if (log.status !== 0) throw new Error(`git log failed: ${log.stderr}`);

  const out: ContentChange[] = [];
  for (const ref of parseLog(log.stdout)) {
    const names = git(['show', '--format=', '--name-status', '--no-renames', ref.sha, '--', 'raw/'], cwd);
    if (names.status !== 0) throw new Error(`git show --name-status failed for ${ref.sha}: ${names.stderr}`);

    for (const entry of parseNameStatus(names.stdout)) {
      if (!isArtifactPath(entry.path)) continue;
      if (entry.status !== 'A' && entry.status !== 'M') continue;
      const sourceId = sourceIdFromPath(entry.path);
      if (sourceId === null) continue;

      const after = blobAt(cwd, ref.sha, entry.path);
      // Unreadable at its own commit means the archive does not hold what the
      // name-status line says it holds, and a deriver cannot make an honest
      // claim about bytes it could not read.
      if (after === null) continue;

      // The PARENT commit, not the previous commit that touched this path.
      // They are the same content by R5 and the parent is what `git show`
      // diffed against, so anything else would compare a diff to bytes that
      // were never on the other side of it. Absent at the root commit, which
      // is exactly the baseline case eventsFromChange emits nothing for.
      const before = entry.status === 'A' ? null : blobAt(cwd, `${ref.sha}^`, entry.path);

      out.push({
        sourceId,
        path: entry.path,
        sha: ref.sha,
        tier: tierOf(sourceId),
        kind: entry.status === 'A' ? 'added' : 'modified',
        before,
        after,
        stamp: stampFor(sidecarAt(cwd, ref.sha, sourceId)),
        previousStamp: stampFor(sidecarAt(cwd, `${ref.sha}^`, sourceId)),
      });
    }
  }
  return out;
}
