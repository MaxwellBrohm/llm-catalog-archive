/**
 * What has already been posted, and where.
 *
 * APPEND-ONLY, like meta/retractions.jsonl and for the same reason: it is the
 * cooldown's memory and the public record of what this account has pushed at
 * people. A file you can rewrite is not a record of what you did, it is a record
 * of what you currently wish you had done. tools/append-only.sh already refuses
 * a commit that edits an existing line of a .jsonl under meta/, so this file
 * gets that guarantee for free by living there.
 *
 * IT IS ALSO THE STATE. There is no database behind the posting routine. The
 * cooldown, the deduplication and the "did that actually go out" question are
 * all answered by reading this file, which means the routine is restartable on
 * any machine with a clone and cannot double-post because a process died.
 */

import type { Platform } from './drafts.js';

export type PostedRow = {
  /** The FeedItem id. `<sha>:<type>:<subject>`, unique per build. */
  readonly id: string;
  readonly platform: Platform;
  /**
   * WHERE it went: `reddit:LocalLLaMA`, not `reddit`. Absent on rows written
   * before the desk routed to venues, which is why every reader below treats a
   * missing venue as the bare platform rather than as a gap to fill in. An old
   * row must not start claiming a subreddit it was never posted to.
   */
  readonly venue?: string;
  /** Entity keys the post was about, for the cooldown. */
  readonly entities: readonly string[];
  readonly posted_at: string;
  /** Where it landed, when the platform gives us a permalink back. */
  readonly permalink: string | null;
  /**
   * How it was submitted. `human` means a person pressed the button on the
   * platform's own form; `api` means the routine posted it. Recorded because
   * the two carry different accountability and the ledger should not blur them.
   */
  readonly via: 'human' | 'api';
};

export function parsePosted(text: string): PostedRow[] {
  const rows: PostedRow[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    rows.push(JSON.parse(trimmed) as PostedRow);
  }
  return rows;
}

export function serializeRow(row: PostedRow): string {
  return JSON.stringify(row);
}

/**
 * Most recent post instant per entity key.
 *
 * Takes the LATEST, not the first, because the cooldown asks "how long since we
 * last talked about this", and a first-wins fold would let an entity posted
 * about daily look untouched since the day it entered the ledger.
 */
export function lastPostedByEntity(rows: readonly PostedRow[]): Map<string, string> {
  const last = new Map<string, string>();
  for (const row of rows) {
    for (const key of row.entities) {
      const seen = last.get(key);
      if (seen === undefined || row.posted_at > seen) last.set(key, row.posted_at);
    }
  }
  return last;
}

/**
 * A row of meta/corrections.jsonl, insofar as this module needs one.
 *
 * Only two fields are read. `ledger` says which record is being corrected, so a
 * correction about the leaks scorecard cannot silently affect posting, and
 * `concerns` is the item id. The prose fields are for a reader, and nothing
 * here parses them: a rule that depended on the wording of an apology would be
 * a rule that breaks the next time somebody words one differently.
 */
export type CorrectionRow = {
  readonly ledger: string;
  readonly concerns: string;
};

export function parseCorrections(text: string): CorrectionRow[] {
  const rows: CorrectionRow[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    rows.push(JSON.parse(trimmed) as CorrectionRow);
  }
  return rows;
}

/**
 * Item ids whose posting record has been corrected.
 *
 * A CORRECTION NOBODY READS IS NOT A CORRECTION. Two rows went into
 * meta/posted.jsonl claiming posts that never happened, both were corrected in
 * the append-only way this archive requires, and the queue went on suppressing
 * those items anyway, because the thing that decides what to offer read only
 * the claim and never the correction. The false rows had become permanent by
 * being wrong.
 *
 * COARSE ON PURPOSE, and the direction of the coarseness is the point. This
 * retracts EVERY posted row for a corrected id rather than trying to work out
 * which venue a correction meant, because the alternative is reading intent out
 * of prose. The failure mode it chooses is re-offering something that was
 * genuinely posted, which costs a person one press of Skip. The failure mode it
 * avoids is suppressing something forever on the strength of a claim already
 * known to be false, which nothing recovers from.
 */
export function correctedIds(corrections: readonly CorrectionRow[]): Set<string> {
  const ids = new Set<string>();
  for (const row of corrections) {
    if (row.ledger === 'meta/posted.jsonl') ids.add(row.concerns);
  }
  return ids;
}

/**
 * `<item id>::<venue id>` for everything already sent.
 *
 * KEYED ON VENUE, not platform. An item that went to r/OpenAI has not been to
 * r/LocalLLaMA, and collapsing those to `reddit` would retire a real audience
 * after a single post. A row with no venue is keyed on its platform, which is
 * exactly what it meant when it was written.
 */
export function postedIds(
  rows: readonly PostedRow[],
  corrections: readonly CorrectionRow[] = [],
): Set<string> {
  const corrected = correctedIds(corrections);
  const ids = new Set<string>();
  for (const row of rows) {
    if (corrected.has(row.id)) continue;
    ids.add(`${row.id}::${row.venue ?? row.platform}`);
  }
  return ids;
}
