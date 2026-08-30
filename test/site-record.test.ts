import { describe, it, expect } from 'vitest';
import {
  artifactPermalink,
  changePagePath,
  commitPermalink,
  escapeHtml,
  formatInt,
  formatUtc,
  isArtifactRetracted,
  recordStamp,
  sortByStampDesc,
  sourceIdFromPath,
  sourcePagePath,
  stampFor,
  utcDay,
} from '../src/site/record.js';
import { artifact, record, sidecar, OTHER_SHA, SHA } from './site-fixtures.js';

describe('escapeHtml', () => {
  it('turns a less-than into its entity', () => {
    expect(escapeHtml('<')).toBe('&lt;');
  });

  it('turns a greater-than into its entity', () => {
    expect(escapeHtml('>')).toBe('&gt;');
  });

  it('turns a double quote into its entity', () => {
    expect(escapeHtml('"')).toBe('&quot;');
  });

  it('turns a single quote into its numeric entity', () => {
    expect(escapeHtml("'")).toBe('&#39;');
  });

  // Not a duplicate of the less-than case. A chained-replace implementation
  // that escapes '<' before '&' produces '&amp;lt;' here and '&lt;' above, so
  // only this input distinguishes the two.
  it('escapes an ampersand that is already part of an entity exactly once', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('escapes a script tag carried inside provider bytes', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
  });

  it('leaves text with nothing to escape byte-identical', () => {
    expect(escapeHtml('- [Assistants migration guide](https://x/migration.md)')).toBe(
      '- [Assistants migration guide](https://x/migration.md)',
    );
  });
});

describe('artifactPermalink', () => {
  it('builds the blob url from the commit sha and the path', () => {
    expect(artifactPermalink(SHA, 'raw/openai-llms-txt/response.txt')).toBe(
      'https://github.com/MaxwellBrohm/llm-catalog-archive/blob/a0a9e12e5287b8ce564e6de63a280498413484cf/raw/openai-llms-txt/response.txt',
    );
  });

  // The whole evidence claim rests on this: R5 overwrites one path in place, so
  // a HEAD or branch link would show whatever the artifact became.
  it('never points at HEAD', () => {
    expect(artifactPermalink(SHA, 'raw/openai-llms-txt/response.txt')).not.toContain('/blob/HEAD/');
  });

  it('gives two different commits two different urls for the same path', () => {
    const a = artifactPermalink(SHA, 'raw/openai-llms-txt/response.txt');
    const b = artifactPermalink(OTHER_SHA, 'raw/openai-llms-txt/response.txt');
    expect(a).not.toBe(b);
  });
});

describe('commitPermalink', () => {
  it('builds the commit url from the sha', () => {
    expect(commitPermalink(SHA)).toBe(
      'https://github.com/MaxwellBrohm/llm-catalog-archive/commit/a0a9e12e5287b8ce564e6de63a280498413484cf',
    );
  });
});

describe('stampFor', () => {
  it('prefers origin_date when the provider sent an Age header', () => {
    expect(stampFor(sidecar())).toEqual({ iso: '2026-08-28T08:08:22.000Z', kind: 'origin' });
  });

  it('falls back to observed_at when origin_date is null', () => {
    expect(stampFor(sidecar({ originDate: null }))).toEqual({
      iso: '2026-08-28T11:23:40.960Z',
      kind: 'observed',
    });
  });

  it('labels the fallback observed rather than origin', () => {
    expect(stampFor(sidecar({ originDate: null }))?.kind).toBe('observed');
  });

  it('is null when no sidecar was stored at the commit', () => {
    expect(stampFor(null)).toBeNull();
  });

  it('is null when the sidecar carries neither timestamp', () => {
    expect(stampFor(sidecar({ originDate: null, observedAt: null }))).toBeNull();
  });
});

describe('recordStamp', () => {
  it('takes the first artifact that carries a timestamp', () => {
    const r = record({
      artifacts: [artifact({ sidecar: null }), artifact({ sidecar: sidecar({ originDate: '2026-01-02T03:04:05.000Z' }) })],
    });
    expect(recordStamp(r)).toEqual({ iso: '2026-01-02T03:04:05.000Z', kind: 'origin' });
  });

  it('is null when no artifact in the commit has a sidecar', () => {
    expect(recordStamp(record({ artifacts: [artifact({ sidecar: null })] }))).toBeNull();
  });
});

describe('sortByStampDesc', () => {
  it('puts the newest origin_date first regardless of the order given', () => {
    const older = record({ sha: OTHER_SHA, artifacts: [artifact({ sidecar: sidecar({ originDate: '2026-08-26T20:25:00.000Z' }) })] });
    const newer = record({ sha: SHA, artifacts: [artifact({ sidecar: sidecar({ originDate: '2026-08-28T08:08:22.000Z' }) })] });
    expect(sortByStampDesc([older, newer]).map((r) => r.sha)).toEqual([SHA, OTHER_SHA]);
  });

  it('sorts records with no timestamp last', () => {
    const stamped = record({ sha: SHA });
    const unstamped = record({ sha: OTHER_SHA, artifacts: [artifact({ sidecar: null })] });
    expect(sortByStampDesc([unstamped, stamped]).map((r) => r.sha)).toEqual([SHA, OTHER_SHA]);
  });

  it('keeps a stamped record ahead of an unstamped one already in that order', () => {
    const stamped = record({ sha: SHA });
    const unstamped = record({ sha: OTHER_SHA, artifacts: [artifact({ sidecar: null })] });
    expect(sortByStampDesc([stamped, unstamped]).map((r) => r.sha)).toEqual([SHA, OTHER_SHA]);
  });

  // Three, because a two-element array is sorted correctly by a comparator that
  // gets ties wrong: there is only one pair, and swapping it back is the same
  // as not swapping it.
  it('keeps three unstamped records in the order they arrived', () => {
    const u = (sha: string) => record({ sha, artifacts: [artifact({ sidecar: null })] });
    const input = [u('1'.repeat(40)), u('2'.repeat(40)), u('3'.repeat(40))];
    expect(sortByStampDesc(input).map((r) => r.sha)).toEqual(['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)]);
  });

  it('keeps three records sharing one timestamp in the order they arrived', () => {
    const same = (sha: string) =>
      record({ sha, artifacts: [artifact({ sidecar: sidecar({ originDate: '2026-08-28T08:08:22.000Z' }) })] });
    const input = [same('1'.repeat(40)), same('2'.repeat(40)), same('3'.repeat(40))];
    expect(sortByStampDesc(input).map((r) => r.sha)).toEqual(['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)]);
  });

  it('keeps two unstamped records in the order they arrived', () => {
    const a = record({ sha: SHA, artifacts: [artifact({ sidecar: null })] });
    const b = record({ sha: OTHER_SHA, artifacts: [artifact({ sidecar: null })] });
    expect(sortByStampDesc([a, b]).map((r) => r.sha)).toEqual([SHA, OTHER_SHA]);
  });

  // Three, not two. A comparator that returns the same answer for every pair
  // still reverses a two-element array correctly, so a pairwise test cannot
  // tell a sort from a reversal.
  it('orders three stamped records by their timestamps', () => {
    const at = (iso: string, sha: string) =>
      record({ sha, artifacts: [artifact({ sidecar: sidecar({ originDate: iso }) })] });
    const oldest = at('2026-08-26T20:25:00.000Z', '1'.repeat(40));
    const newest = at('2026-08-30T05:24:49.000Z', '2'.repeat(40));
    const middle = at('2026-08-28T08:08:22.000Z', '3'.repeat(40));
    expect(sortByStampDesc([oldest, newest, middle]).map((r) => r.sha)).toEqual([
      '2'.repeat(40),
      '3'.repeat(40),
      '1'.repeat(40),
    ]);
  });

  it('keeps an unstamped record last among three', () => {
    const at = (iso: string, sha: string) =>
      record({ sha, artifacts: [artifact({ sidecar: sidecar({ originDate: iso }) })] });
    const none = record({ sha: '0'.repeat(40), artifacts: [artifact({ sidecar: null })] });
    const oldest = at('2026-08-26T20:25:00.000Z', '1'.repeat(40));
    const newest = at('2026-08-30T05:24:49.000Z', '2'.repeat(40));
    expect(sortByStampDesc([none, oldest, newest]).map((r) => r.sha)).toEqual([
      '2'.repeat(40),
      '1'.repeat(40),
      '0'.repeat(40),
    ]);
  });

  // Five, interleaved. Two elements let a comparator be called in only one
  // direction, so the branch that fires when the FIRST argument is the
  // unstamped one is never reached and a wrong answer there survives.
  it('orders a mixture of stamped and unstamped records', () => {
    const at = (iso: string, sha: string) =>
      record({ sha, artifacts: [artifact({ sidecar: sidecar({ originDate: iso }) })] });
    const none = (sha: string) => record({ sha, artifacts: [artifact({ sidecar: null })] });
    const input = [
      none('a'.repeat(40)),
      at('2026-08-26T20:25:00.000Z', 'b'.repeat(40)),
      none('c'.repeat(40)),
      at('2026-08-30T05:24:49.000Z', 'd'.repeat(40)),
      at('2026-08-28T08:08:22.000Z', 'e'.repeat(40)),
    ];
    expect(sortByStampDesc(input).map((r) => r.sha)).toEqual([
      'd'.repeat(40),
      'e'.repeat(40),
      'b'.repeat(40),
      'a'.repeat(40),
      'c'.repeat(40),
    ]);
  });

  it('sorts a record whose timestamp cannot be parsed last', () => {
    const bad = record({ sha: OTHER_SHA, artifacts: [artifact({ sidecar: sidecar({ originDate: 'not a date' }) })] });
    const good = record({ sha: SHA });
    expect(sortByStampDesc([bad, good]).map((r) => r.sha)).toEqual([SHA, OTHER_SHA]);
  });

  it('leaves the input array untouched', () => {
    const older = record({ sha: OTHER_SHA, artifacts: [artifact({ sidecar: sidecar({ originDate: '2026-08-26T20:25:00.000Z' }) })] });
    const newer = record({ sha: SHA });
    const input = [older, newer];
    sortByStampDesc(input);
    expect(input.map((r) => r.sha)).toEqual([OTHER_SHA, SHA]);
  });
});

describe('isArtifactRetracted', () => {
  it('is false when the commit carries no retraction', () => {
    expect(isArtifactRetracted(record(), 'raw/openai-llms-txt/response.txt')).toBe(false);
  });

  it('covers every artifact when the retraction names no path', () => {
    const r = record({ retraction: { sha: SHA, path: null, reason: null } });
    expect(isArtifactRetracted(r, 'raw/anything-else/response.txt')).toBe(true);
  });

  it('covers only the named path when the retraction names one', () => {
    const r = record({ retraction: { sha: SHA, path: 'raw/openai-llms-txt/response.txt', reason: null } });
    expect(isArtifactRetracted(r, 'raw/claude-status/response.atom')).toBe(false);
  });

  it('covers the named path itself', () => {
    const r = record({ retraction: { sha: SHA, path: 'raw/openai-llms-txt/response.txt', reason: null } });
    expect(isArtifactRetracted(r, 'raw/openai-llms-txt/response.txt')).toBe(true);
  });
});

describe('formatUtc', () => {
  it('renders an ISO instant as a fixed UTC string', () => {
    expect(formatUtc('2026-08-28T08:08:22.000Z')).toBe('28 August 2026 08:08 UTC');
  });

  it('zero-pads a single-digit hour and minute', () => {
    expect(formatUtc('2026-01-05T04:07:00.000Z')).toBe('5 January 2026 04:07 UTC');
  });

  it('does not shift the instant into local time', () => {
    expect(formatUtc('2026-12-31T23:59:00.000Z')).toBe('31 December 2026 23:59 UTC');
  });

  it('returns an unparseable value unchanged rather than rendering Invalid Date', () => {
    expect(formatUtc('not a date')).toBe('not a date');
  });

  // Hardcoded, all twelve. A month table is exactly the kind of thing that is
  // right in January and wrong in September, and one sample cannot see that.
  it('names every month', () => {
    const names = Array.from({ length: 12 }, (_, i) =>
      formatUtc(`2026-${String(i + 1).padStart(2, '0')}-15T00:00:00.000Z`),
    );
    expect(names).toEqual([
      '15 January 2026 00:00 UTC',
      '15 February 2026 00:00 UTC',
      '15 March 2026 00:00 UTC',
      '15 April 2026 00:00 UTC',
      '15 May 2026 00:00 UTC',
      '15 June 2026 00:00 UTC',
      '15 July 2026 00:00 UTC',
      '15 August 2026 00:00 UTC',
      '15 September 2026 00:00 UTC',
      '15 October 2026 00:00 UTC',
      '15 November 2026 00:00 UTC',
      '15 December 2026 00:00 UTC',
    ]);
  });
});

describe('utcDay', () => {
  it('takes the UTC calendar day of an instant', () => {
    expect(utcDay('2026-08-28T23:59:59.000Z')).toBe('2026-08-28');
  });

  it('returns an unparseable value unchanged', () => {
    expect(utcDay('nope')).toBe('nope');
  });
});

describe('formatInt', () => {
  it('groups thousands', () => {
    expect(formatInt(33743)).toBe('33,743');
  });

  it('leaves a three digit number ungrouped', () => {
    expect(formatInt(223)).toBe('223');
  });

  it('groups a six figure number twice', () => {
    expect(formatInt(685300)).toBe('685,300');
  });

  it('renders zero as a bare zero', () => {
    expect(formatInt(0)).toBe('0');
  });

  it('keeps the sign on a negative number', () => {
    expect(formatInt(-1234)).toBe('-1,234');
  });

  it('groups a seven figure number twice', () => {
    expect(formatInt(1234567)).toBe('1,234,567');
  });
});

describe('sourceIdFromPath', () => {
  it('reads the source id out of a stored artifact path', () => {
    expect(sourceIdFromPath('raw/openai-llms-txt/response.txt')).toBe('openai-llms-txt');
  });

  it('rejects a path outside raw/', () => {
    expect(sourceIdFromPath('meta/status.json')).toBeNull();
  });

  it('rejects a nested path, which R5 does not produce', () => {
    expect(sourceIdFromPath('raw/openai-llms-txt/sub/response.txt')).toBeNull();
  });

  // The pattern is anchored at both ends. Unanchored at the front it would
  // accept a backfill path that merely contains raw/, and R6 keeps those trees
  // apart precisely because a backfill artifact is not a verbatim capture.
  it('rejects a path that merely contains raw/ further along', () => {
    expect(sourceIdFromPath('backfill/raw/kj-9/models.json')).toBeNull();
  });

  it('rejects a source id carrying characters the collector never generates', () => {
    expect(sourceIdFromPath('raw/OpenAI_LLMS/response.txt')).toBeNull();
  });
});

describe('page paths', () => {
  it('files a change page under its full sha', () => {
    expect(changePagePath(SHA)).toBe('changes/a0a9e12e5287b8ce564e6de63a280498413484cf.html');
  });

  it('files a source page under its source id', () => {
    expect(sourcePagePath('openai-llms-txt')).toBe('sources/openai-llms-txt.html');
  });
});
