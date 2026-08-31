/**
 * The magnitude guard: the last gate before a write.
 *
 * Deliberately not part of the health check, and deliberately downstream of
 * the change predicate. Health catches KNOWN unhealthy shapes: the canary, the
 * interstitial markers, the size band, the root element. It cannot catch an
 * unknown one, and the next failure will not be a Cloudflare page. This
 * catches the case health can never see: a response that parses, carries its
 * canary, sits inside its size band, and has simply lost most of its content.
 *
 * Growth is not guarded, and the asymmetry is the point. A source doubling is
 * a story. A source losing three quarters of its entries is usually a bug, and
 * committing it into a history R7 forbids rewriting is not recoverable.
 *
 * A hold is NOT a source failure. It withholds one write, records itself in
 * status.json, and exits zero.
 *
 * Pure by construction. No filesystem, no network, no clock.
 */

import type { Source } from './config.js';

/**
 * Repeated record elements, by the name the format actually uses.
 *
 * `<url>` for sitemaps, `<entry>` for Atom, `<item>` for RSS. Namespace
 * prefixes are stripped, because `<atom:entry>` is an entry and a namespaced
 * feed that counted zero would make the guard unable to fire on the one source
 * whose collapse it most needs to catch.
 */
const XML_RECORD = /<(?:[A-Za-z_][\w.-]*:)?(url|entry|item)(?:\s[^>]*?)?(?:\/>|>)/g;

/**
 * How many units this snapshot has, in the unit its content type counts in.
 *
 * Entries for structured sources, lines for text. Null when the body does not
 * yield a count at all, which is not the same as zero: a JSON body that no
 * longer parses has an unknown size, and treating unknown as zero would hold
 * every subsequent snapshot of a source whose stored baseline is unreadable.
 */
export function countUnits(source: Source, bytes: Uint8Array): number | null {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

  if (source.contentType === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    const key = source.invariants.requiredKeyPath;
    if (key !== null) {
      const v = (parsed as Record<string, unknown> | null)?.[key];
      return Array.isArray(v) ? v.length : null;
    }
    if (Array.isArray(parsed)) return parsed.length;
    return parsed !== null && typeof parsed === 'object' ? Object.keys(parsed).length : null;
  }

  if (source.contentType === 'xml') {
    const n = [...text.matchAll(XML_RECORD)].length;
    return n === 0 ? null : n;
  }

  // text and html count lines. Not a fallback: for a `llms.txt` family file the
  // line IS the record, and the spec names lines as the unit for text sources.
  return text.split('\n').length;
}

export type ShrinkVerdict = { held: false } | { held: true; reason: string };

/**
 * Whether this snapshot removes more than `max_shrink_pct` of the units the
 * last accepted snapshot had.
 *
 * Held is strictly greater than the threshold, so a guard configured at 25
 * accepts a snapshot that loses exactly a quarter. A boundary has to sit
 * somewhere and the configured number reads as "this much is still fine".
 *
 * Never holds when there is no baseline, when the baseline itself has no
 * count, or when the baseline counted zero. All three are the seed case in
 * different clothes, and a percentage of nothing is not a number.
 */
export function shrinkVerdict(source: Source, next: Uint8Array, prev: Uint8Array | null): ShrinkVerdict {
  if (prev === null) return { held: false };

  const before = countUnits(source, prev);
  const after = countUnits(source, next);
  if (before === null || after === null || before === 0) return { held: false };
  if (after >= before) return { held: false };

  const shrinkPct = ((before - after) / before) * 100;
  if (shrinkPct <= source.magnitudeGuard.maxShrinkPct) return { held: false };

  return {
    held: true,
    reason:
      `magnitude guard: ${before} to ${after} units is a ${shrinkPct.toFixed(1)}% removal, ` +
      `over the ${source.magnitudeGuard.maxShrinkPct}% limit`,
  };
}
