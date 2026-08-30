/**
 * meta/retractions.jsonl, parsed. Pure: the argument is the file's text.
 *
 * The ledger is empty at launch and the record schema belongs to sub-project D.
 * What A1 fixes, and what this file implements, is the semantics: a line naming
 * a commit sha marks that change retracted, and the change's page still renders
 * at its permalink. Deletion is not an option, because deletion breaks the
 * audit trail the whole design exists to provide.
 *
 * A malformed line THROWS. It would be easy to skip it and keep building, and
 * that is exactly the failure worth refusing: a retraction that fails to parse
 * silently publishes an unretracted page, which is the one outcome the ledger
 * exists to prevent. A build that stops is recoverable; a page that lies is not,
 * because R7 makes the commit permanent.
 */

import type { Retraction } from './record.js';

const SHA = /^[0-9a-f]{40}$/;

function stringOrNull(v: unknown, field: string, line: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new Error(`meta/retractions.jsonl line ${line}: ${field} must be a string`);
  return v;
}

export function parseRetractions(text: string): Retraction[] {
  const out: Retraction[] = [];
  const rows = text.split('\n');
  for (let i = 0; i < rows.length; i++) {
    const raw = (rows[i] ?? '').trim();
    if (raw === '') continue;
    const lineNo = i + 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`meta/retractions.jsonl line ${lineNo}: not valid JSON`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`meta/retractions.jsonl line ${lineNo}: must be a JSON object`);
    }

    const row = parsed as Record<string, unknown>;
    const sha = row['sha'];
    if (typeof sha !== 'string' || !SHA.test(sha)) {
      throw new Error(`meta/retractions.jsonl line ${lineNo}: sha must be a full 40 character commit sha`);
    }

    out.push({
      sha,
      path: stringOrNull(row['path'], 'path', lineNo),
      reason: stringOrNull(row['reason'], 'reason', lineNo),
    });
  }
  return out;
}

/** First retraction naming this commit, or null. */
export function retractionFor(retractions: Retraction[], sha: string): Retraction | null {
  return retractions.find((r) => r.sha === sha) ?? null;
}
