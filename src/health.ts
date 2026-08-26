/**
 * The health predicate: the gate between a fetched response and the archive.
 *
 * Pure by construction. No filesystem, no network, no git, no clock: the time
 * arrives as `nowMs` and the response arrives as `Observed`, so every verdict
 * in here is reproducible from its arguments alone.
 *
 * The premise is that a 200 is not a yes. A bot-challenge page, a soft 404, an
 * 81-byte redirect stub and a site's own homepage are all served at 200, and
 * every one of them would otherwise be written over a good snapshot and
 * committed into a history that R7 forbids rewriting.
 */

import type { Source } from './config.js';
import type { Observed } from './types.js';

export type HealthState = 'ok' | 'relocated' | 'failed' | 'stale';

export type HealthVerdict = {
  state: HealthState;
  /** `ok` and `relocated` write. `failed` and `stale` do not. */
  writeAllowed: boolean;
  /** Only `failed` advances the consecutive-failure counter. */
  countsAsFailure: boolean;
  reason: string | null;
};

/**
 * Strings that appear in bot-challenge and block pages.
 *
 * A module constant, deliberately not a per-source field. The config schema
 * rejects unknown keys, so a per-source copy would be a per-source opportunity
 * to omit a marker, and the one source that omitted it is the one that gets
 * challenged.
 *
 * Checked independently of the canary rather than folded into it, because a
 * challenge page can carry a source's canary by accident: the canary is often
 * a word from the site's own chrome, and the challenge is served from the same
 * host. Measured on the captured fixture, which contains both `__CF$cv$params`
 * and the word the neuron feed's canary would have been.
 */
const INTERSTITIAL_MARKERS = [
  '__CF$cv$params',
  'cf-mitigated',
  'Just a moment',
  'Enable JavaScript and cookies to continue',
  'Attention Required!',
];

const fail = (reason: string): HealthVerdict => ({
  state: 'failed',
  writeAllowed: false,
  countsAsFailure: true,
  reason,
});

/**
 * The name of the document's root element, or null if there is not one.
 *
 * Deliberately not a full parser, and deliberately not a check that the body
 * "parses". The cohere trap is 1 MB of markup that `ET.parse()` ACCEPTS at a
 * root of `<html>`, so a parser would have said yes to a blog homepage served
 * from a feed URL. The root element is the discriminating check.
 *
 * An XML declaration is skipped where present and NOT required: the same trap
 * opens with `<!DOCTYPE html>` and no declaration at all, and requiring one
 * would reject it with "no root element" instead of naming the `<html>` it
 * actually found, which is a right answer for a wrong reason.
 */
export function xmlRootElement(text: string): string | null {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text[i] !== '<') return null;

    const second = text[i + 1];

    // Processing instruction, including the `<?xml ... ?>` declaration.
    if (second === '?') {
      const end = text.indexOf('?>', i);
      if (end === -1) return null;
      i = end + 2;
      continue;
    }

    if (second === '!') {
      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i);
        if (end === -1) return null;
        i = end + 3;
        continue;
      }
      // A doctype. Its internal subset may itself contain `>`, so a bracket is
      // closed before the terminator is looked for.
      let from = i;
      const bracket = text.indexOf('[', i);
      const close = text.indexOf('>', i);
      if (bracket !== -1 && close !== -1 && bracket < close) {
        const endSubset = text.indexOf(']', bracket);
        if (endSubset === -1) return null;
        from = endSubset;
      }
      const end = text.indexOf('>', from);
      if (end === -1) return null;
      i = end + 1;
      continue;
    }

    const m = /^<([A-Za-z_][\w.:-]*)/.exec(text.slice(i, i + 256));
    if (m === null) return null;
    // Namespace prefixes are stripped: `<atom:feed>` is a feed.
    return m[1]!.replace(/^.*:/, '');
  }
}

/**
 * One `<entry>` or `<item>` element, with its inner text in group 2.
 *
 * Namespace prefixes are stripped the same way `xmlRootElement` strips them,
 * and for the same reason: `<atom:entry>` is an entry. Without that, a
 * namespaced Atom feed with a hundred entries counted as ZERO items, which
 * routed it to the quiet branch instead of the loud one. Self-closing
 * `<entry/>` counts too, for the same reason.
 *
 * What separates `<entry>` from `<entryPoint>` is the requirement that the
 * name be followed by whitespace, `>` or `/>`, not a `\b` after the name. A
 * `\b` was there and was dead: removing it changed no behaviour and killed no
 * test, so it went rather than staying as decoration.
 */
const FEED_ITEM =
  /<(?:[A-Za-z_][\w.-]*:)?(entry|item)(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?\1\s*>)/g;

/** How many `<entry>` or `<item>` elements the document carries. */
export function countFeedItems(text: string): number {
  return [...text.matchAll(FEED_ITEM)].length;
}

/**
 * The newest item date in a feed, or null when no item carries one.
 *
 * Scoped to `<entry>` and `<item>` elements, which is not a detail: the
 * feed-level `<updated>` advances while no entry does. Measured in this
 * repository's own history, commits 3a80c22 and 690dd60, 49 minutes apart:
 * the entire delta between the two 33,787-byte claude-status captures is that
 * one line moving 19:04:25Z to 20:55:09Z, with every entry byte-identical.
 *
 * A document-wide scan reads that line, so the staleness check on every Atom
 * status feed could never fire: claude-status could go two years without an
 * incident and still look fresh every single day.
 */
export function newestFeedDate(text: string): number | null {
  let newest: number | null = null;
  for (const item of text.matchAll(FEED_ITEM)) {
    for (const d of (item[2] ?? '').matchAll(/<(?:published|updated|pubDate|dc:date)>([^<]+)<\//g)) {
      const t = Date.parse(d[1]!.trim());
      if (!Number.isNaN(t) && (newest === null || t > newest)) newest = t;
    }
  }
  return newest;
}

export function checkHealth(
  source: Source,
  obs: Observed,
  prev: { bytes: number | null },
  nowMs: number,
): HealthVerdict {
  if (obs.status < 200 || obs.status >= 300) return fail(`status ${obs.status}`);
  if (obs.redirectCount > source.maxRedirects) {
    return fail(`redirect budget exhausted (${obs.redirectCount} > ${source.maxRedirects})`);
  }

  const text = new TextDecoder('utf-8', { fatal: false }).decode(obs.body);
  const inv = source.invariants;

  /**
   * Quiet, not broken: `stale` withholds the write and does NOT count as a
   * failure, which is the whole reason the state exists. A provider having a
   * genuinely silent quarter must not send a daily failure email, because that
   * is how an alerting channel gets muted.
   *
   * But withholding the write is also what keeps `prev.bytes` null, and on a
   * source that has never archived anything that closes a loop: stale, so no
   * write, so still no previous size, so stale again, for ever, and silently.
   * `openai-status`, the source this branch was written for, is exactly the
   * one it would have silenced. A source that has never once produced a
   * usable body is not quiet, it is broken, and broken is loud.
   */
  const quiet = (reason: string): HealthVerdict =>
    prev.bytes === null
      ? fail(`${reason}, and no previous snapshot exists to be quiet against`)
      : { state: 'stale', writeAllowed: false, countsAsFailure: false, reason };

  // First among the content checks on purpose. A challenge page can sit inside
  // the size band and carry the canary, and when it does not, "size ratio 58"
  // is a true statement that sends an operator to the wrong problem.
  for (const marker of INTERSTITIAL_MARKERS) {
    if (text.includes(marker)) return fail(`interstitial marker present: ${marker}`);
  }

  if (obs.body.byteLength < inv.minBytes) {
    return fail(`below min_bytes (${obs.body.byteLength} < ${inv.minBytes})`);
  }

  // The band is a ratio against the last accepted snapshot, so it cannot apply
  // to the first fetch. There is nothing to be a ratio of.
  if (prev.bytes !== null && prev.bytes > 0) {
    const [lo, hi] = inv.sizeBand;
    const ratio = obs.body.byteLength / prev.bytes;
    if (ratio < lo || ratio > hi) {
      return fail(`size ratio ${ratio.toFixed(3)} outside band [${lo}, ${hi}]`);
    }
  }

  if (inv.canary !== null && !text.includes(inv.canary)) {
    return fail(`canary absent: ${JSON.stringify(inv.canary)}`);
  }

  if (source.contentType === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return fail(`json parse failed: ${String(e instanceof Error ? e.message : e)}`);
    }
    if (inv.requiredKeyPath !== null) {
      const v = (parsed as Record<string, unknown> | null)?.[inv.requiredKeyPath];
      if (v === undefined) return fail(`required key path absent: ${inv.requiredKeyPath}`);
      if (inv.minRecords !== null && (!Array.isArray(v) || v.length < inv.minRecords)) {
        const got = Array.isArray(v) ? String(v.length) : 'not an array';
        return fail(`records below floor (${got} < ${inv.minRecords})`);
      }
    }
  }

  if (source.contentType === 'xml') {
    const root = xmlRootElement(text);
    if (root === null) return fail('no xml root element found');
    if (source.expectedRoot !== null && root !== source.expectedRoot) {
      return fail(`root element is <${root}>, expected <${source.expectedRoot}>`);
    }
  }

  if (source.freshness.kind === 'feed' && source.freshness.maxQuietDays !== null) {
    const newest = newestFeedDate(text);
    if (newest === null) {
      // Two different things reach here and only one of them is a defect. A
      // feed with no items at all is a provider that has published nothing,
      // which is the quiet case this whole four-state design exists to spare
      // from a failure email. A feed WITH items but no parseable date on any
      // of them is malformed.
      if (countFeedItems(text) === 0) return quiet('feed carries no items at all');
      return fail('feed carries no parseable item date');
    }
    const days = (nowMs - newest) / 86_400_000;
    if (days > source.freshness.maxQuietDays) {
      return quiet(`newest item ${Math.round(days)} days old, limit ${source.freshness.maxQuietDays}`);
    }
  }

  if (obs.finalUrl !== source.url) {
    // Writable. The bytes are good; it is the URL in the config that is stale,
    // and refusing the write would lose real content over a bookkeeping fact.
    return {
      state: 'relocated',
      writeAllowed: true,
      countsAsFailure: false,
      reason: `final url is ${obs.finalUrl}, declared ${source.url}`,
    };
  }

  return { state: 'ok', writeAllowed: true, countsAsFailure: false, reason: null };
}
