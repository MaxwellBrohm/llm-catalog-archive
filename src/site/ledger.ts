/**
 * `meta/leaks-ledger.jsonl`, the public accuracy ledger, parsed. Pure: the
 * argument is the file's text.
 *
 * WHY IT IS TWO LINE KINDS AND NOT ONE MUTABLE ROW. The ledger records every
 * rumor and whether it panned out, and a rumor's outcome is not known when the
 * rumor is recorded. In a mutable table the outcome is a field that gets edited
 * later; in an append-only file it cannot be, and append-only is the whole
 * value of the thing. A scorecard anyone can edit after the fact is not
 * evidence of being right, it is a claim to have been right.
 *
 * So a claim line is written once and never touched, and a resolution line is
 * appended later naming it. The file is therefore its own audit trail: `git log
 * -p meta/leaks-ledger.jsonl` shows when each prediction was made and when it
 * was scored, and .github/workflows/append-only.yml fails any diff that removes
 * or modifies a line.
 *
 * A MALFORMED LINE THROWS, exactly as src/site/retractions.ts refuses a
 * malformed retraction. The failure worth refusing is the quiet one: a
 * resolution that fails to parse leaves a refuted claim scored as open, which
 * inflates the accuracy rate, which is the single number the ledger exists to
 * make honest. A build that stops is recoverable.
 */

import type { SourcingTier } from '../derive/leaks.js';

/** What actually happened to a claim. `open` is the absence of a resolution. */
export type Outcome = 'confirmed' | 'refuted' | 'open';

export type LedgerClaim = {
  id: string;
  /** The sentence as it was written on the day it was written. */
  claim: string;
  tier: SourcingTier;
  /** The day it was recorded, YYYY-MM-DD. Never a clock read at build time. */
  recorded: string;
  /** The artifact it rests on, or null for an `unconfirmed` report. */
  artifact: string | null;
  outcome: Outcome;
  /** The day the outcome was recorded, or null while it is open. */
  resolved: string | null;
  /** The evidence the resolution rests on. */
  resolutionNote: string | null;
};

export type Scorecard = {
  total: number;
  confirmed: number;
  refuted: number;
  open: number;
  /**
   * Confirmed over resolved, as a percentage rounded to one decimal, or null
   * when nothing has resolved yet.
   *
   * Null rather than zero or 100. A ledger with no resolved claims has no
   * accuracy, and printing either number would be a score nobody earned. This
   * is the field the whole ledger exists to produce, so it is the one that most
   * has to refuse to be invented.
   */
  accuracyPct: number | null;
};

const TIERS: SourcingTier[] = ['confirmed-artifact', 'credible', 'unconfirmed'];
const OUTCOMES: Outcome[] = ['confirmed', 'refuted'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function fail(line: number, message: string): never {
  throw new Error(`meta/leaks-ledger.jsonl line ${line}: ${message}`);
}

function requiredString(row: Record<string, unknown>, field: string, line: number): string {
  const v = row[field];
  if (typeof v !== 'string' || v === '') fail(line, `${field} must be a non-empty string`);
  return v;
}

function optionalString(row: Record<string, unknown>, field: string, line: number): string | null {
  const v = row[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') fail(line, `${field} must be a string when present`);
  return v;
}

/**
 * The ledger's lines, folded into one row per claim.
 *
 * Claim order is preserved rather than sorted: the file is append-only, so file
 * order IS chronological order, and re-sorting by a date field would let a
 * mistyped date reorder history.
 *
 * THE LAST RESOLUTION WINS, not the first. A claim scored `refuted` and later
 * corrected to `confirmed` should read as the correction, which is what the
 * append-only shape leaves as the only way to change one's mind in public.
 */
export function parseLedger(text: string): LedgerClaim[] {
  const claims: LedgerClaim[] = [];
  const byId = new Map<string, LedgerClaim>();

  const rows = text.split('\n');
  for (let i = 0; i < rows.length; i++) {
    const raw = (rows[i] ?? '').trim();
    if (raw === '') continue;
    const line = i + 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail(line, 'not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      fail(line, 'must be a JSON object');
    }
    const row = parsed as Record<string, unknown>;
    const kind = row['kind'];

    if (kind === 'claim') {
      const id = requiredString(row, 'id', line);
      if (byId.has(id)) fail(line, `duplicate claim id ${id}`);
      const tier = requiredString(row, 'tier', line) as SourcingTier;
      if (!TIERS.includes(tier)) fail(line, `tier must be one of ${TIERS.join(', ')}`);
      const recorded = requiredString(row, 'recorded', line);
      if (!DAY.test(recorded)) fail(line, 'recorded must be a YYYY-MM-DD day');
      const artifact = optionalString(row, 'artifact', line);
      // The tier is a statement about the artifact, so a tier claiming one and
      // a row carrying none is the ledger contradicting itself in the field
      // whose whole purpose is to be checkable.
      if (tier === 'confirmed-artifact' && artifact === null) {
        fail(line, 'tier confirmed-artifact requires an artifact link');
      }
      const claim: LedgerClaim = {
        id,
        claim: requiredString(row, 'claim', line),
        tier,
        recorded,
        artifact,
        outcome: 'open',
        resolved: null,
        resolutionNote: null,
      };
      claims.push(claim);
      byId.set(id, claim);
      continue;
    }

    if (kind === 'resolution') {
      const claimId = requiredString(row, 'claim_id', line);
      const target = byId.get(claimId);
      // A resolution for a claim that is not above it names nothing, and a
      // ledger that skipped it would silently drop a score.
      if (target === undefined) fail(line, `resolution names unknown claim_id ${claimId}`);
      const outcome = requiredString(row, 'outcome', line) as Outcome;
      if (!OUTCOMES.includes(outcome)) fail(line, `outcome must be one of ${OUTCOMES.join(', ')}`);
      const resolved = requiredString(row, 'resolved', line);
      if (!DAY.test(resolved)) fail(line, 'resolved must be a YYYY-MM-DD day');
      target.outcome = outcome;
      target.resolved = resolved;
      target.resolutionNote = optionalString(row, 'note', line);
      continue;
    }

    fail(line, 'kind must be "claim" or "resolution"');
  }

  return claims;
}

/** The scorecard the desk publishes. */
export function scoreLedger(claims: LedgerClaim[]): Scorecard {
  const confirmed = claims.filter((c) => c.outcome === 'confirmed').length;
  const refuted = claims.filter((c) => c.outcome === 'refuted').length;
  const resolved = confirmed + refuted;
  return {
    total: claims.length,
    confirmed,
    refuted,
    open: claims.length - resolved,
    accuracyPct: resolved === 0 ? null : Math.round((confirmed / resolved) * 1000) / 10,
  };
}
