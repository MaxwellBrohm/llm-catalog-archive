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

/** Item ids already sent to a given platform, so a rerun cannot repeat one. */
export function postedIds(rows: readonly PostedRow[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) ids.add(`${row.id}::${row.platform}`);
  return ids;
}
