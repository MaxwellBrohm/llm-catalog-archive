/**
 * The accuracy ledger, filled by a prediction the archive can make honestly.
 *
 * THE PROBLEM THIS SOLVES. The brief asked for a graded leaks desk with a
 * public accuracy ledger. The ledger was built, tested and append-only from day
 * one, and it held zero lines, because a ledger claim is a PREDICTION and the
 * copy rule forbids the derivation from predicting anything. Nothing automated
 * could ever write to it, so the scorecard was a promise with no path to being
 * kept.
 *
 * THE ONE PREDICTION THAT IS ALREADY IN THE BYTES. OpenRouter's catalog carries
 * an `expiration_date` per model. That is a dated, falsifiable statement, it is
 * in the SAME NAMESPACE as the catalog itself, and it can therefore be checked
 * against a later capture of that same catalogue with no join and no guess.
 * `retirement_floor` cannot be used this way: those dates are in a provider's
 * own API namespace, and joining `anthropic/claude-opus-4.1` to
 * `claude-opus-4-1-20250805` is exactly the guess this project refuses.
 *
 * SO THE LEDGER SCORES A FIELD, NOT A COMPANY. The question is whether the
 * catalog's own expiration_date predicts the catalog's own behaviour, which is
 * a self-contained question about one artifact, useful to anyone deciding
 * whether to trust that field, and answerable entirely from stored bytes.
 *
 * WHY THIS IS STILL INSIDE THE PUBLISHING GATE. The gate's line is who composed
 * the sentence: templated-from-fields auto-publishes, anything a language model
 * wrote goes to review. Every sentence here is a fixed template filled from two
 * values read out of stored payloads, both quoted, and the scoring rule is
 * printed in the claim itself rather than left implicit.
 *
 * Pure: no fs, no git, no clock, no network.
 */

import type { FeedItem } from './feed.js';
import { quoteValue } from './quoting.js';

/** A `claim` line, exactly as meta/leaks-ledger.jsonl spells it. */
export type ClaimLine = {
  kind: 'claim';
  id: string;
  claim: string;
  tier: 'confirmed-artifact';
  recorded: string;
  artifact: string;
};

/** A `resolution` line, appended later, naming a claim above it. */
export type ResolutionLine = {
  kind: 'resolution';
  claim_id: string;
  outcome: 'confirmed' | 'refuted';
  resolved: string;
  note: string;
};

export type LedgerLine = ClaimLine | ResolutionLine;

export type CatalogState = {
  /** Every id present in the newest accepted capture. */
  ids: ReadonlySet<string>;
  /** That capture's rendered stamp, printed in the resolution note. */
  stamp: string;
  /** That capture's instant, ISO. A capture at or before the expiry proves nothing. */
  observedAt: string;
};

/** `expiry:<catalog id>:<date>`. Stable, so a claim is written exactly once. */
export function expiryClaimId(catalogId: string, date: string): string {
  return `expiry:${catalogId}:${date}`;
}

/**
 * The claim sentence.
 *
 * The scoring rule is stated IN the sentence. A ledger line that recorded only
 * "the catalog listed an expiration_date" would be trivially true on the day it
 * was written and would score 100% forever, which is a scorecard measuring
 * nothing. Saying what would refute it is what makes the line a prediction.
 */
export function expiryClaimSentence(catalogId: string, date: string): string {
  return (
    `OpenRouter's catalog listed an expiration_date of ${quoteValue(date)} for ${quoteValue(catalogId)}. ` +
    `Scored as: ${quoteValue(catalogId)} is absent from the catalog after that date.`
  );
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The `expiration_date` and catalog id an expiration event carries, or null.
 *
 * READ OFF THE EVENT, NOT OFF `item.facts`. A FeedItem's `facts` are the rows a
 * PAGE prints and are empty on these items; the typed event underneath is where
 * the values live, and reading the wrong one produced a deriver that found
 * three expirations and recorded nothing, silently.
 */
function expiryOf(item: FeedItem): { catalogId: string; date: string } | null {
  const event = item.event;
  if (event === null || event.type !== 'expiration_set') return null;
  if (!DAY.test(event.date)) return null;
  return { catalogId: event.modelId, date: event.date };
}

/**
 * The lines to APPEND, given what the ledger already holds.
 *
 * Append-only is not a property of the file, it is a property of this function:
 * it never rewrites and never emits a line whose id is already recorded. A
 * claim is written once, and its resolution is written once, later.
 *
 * `today` and the catalogue's own observation instant are separate arguments on
 * purpose. A claim is only resolvable once the archive holds a capture taken
 * AFTER the expiry date, and the run's wall clock is not evidence of that: a
 * collector that has not fetched for a week would otherwise resolve claims
 * against a stale catalogue and score them wrong.
 */
export function expiryLedgerLines(
  feed: readonly FeedItem[],
  catalog: CatalogState,
  today: string,
  existing: { claimIds: ReadonlySet<string>; resolvedIds: ReadonlySet<string> },
  artifactPermalink: (item: FeedItem) => string,
): LedgerLine[] {
  const out: LedgerLine[] = [];
  const seen = new Set<string>();
  const capturedMs = Date.parse(catalog.observedAt);

  // Oldest first, so the file reads in the order the archive learned things.
  const items = [...feed].filter((i) => expiryOf(i) !== null).reverse();

  for (const item of items) {
    const expiry = expiryOf(item);
    if (expiry === null) continue;
    const id = expiryClaimId(expiry.catalogId, expiry.date);
    if (seen.has(id)) continue;
    seen.add(id);

    if (!existing.claimIds.has(id)) {
      out.push({
        kind: 'claim',
        id,
        claim: expiryClaimSentence(expiry.catalogId, expiry.date),
        // The artifact is the stored capture the date was read out of, so the
        // tier is the only one that promises a publicly observable artifact.
        tier: 'confirmed-artifact',
        recorded: (item.stamp?.iso ?? today).slice(0, 10),
        artifact: artifactPermalink(item),
      });
    }

    if (existing.resolvedIds.has(id)) continue;

    // END OF THE EXPIRY DAY, not the start. A date is a day, and an id removed
    // during 2026-08-31 is not late.
    const dueMs = Date.parse(`${expiry.date}T23:59:59.999Z`);
    if (Number.isNaN(dueMs) || Number.isNaN(capturedMs) || capturedMs <= dueMs) continue;

    const present = catalog.ids.has(expiry.catalogId);
    out.push({
      kind: 'resolution',
      claim_id: id,
      outcome: present ? 'refuted' : 'confirmed',
      resolved: today,
      note: present
        ? `Still listed in the catalog captured at ${catalog.stamp}, after an expiration_date of ${quoteValue(expiry.date)}.`
        : `Absent from the catalog captured at ${catalog.stamp}.`,
    });
  }

  return out;
}

/** The lines as JSONL, ready to append. Empty string when there is nothing to add. */
export function renderLedgerLines(lines: readonly LedgerLine[]): string {
  return lines.length === 0 ? '' : `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}
