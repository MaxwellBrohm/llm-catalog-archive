import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { isArtifactLink, parseLedger, scoreLedger } from '../src/site/ledger.js';

const CLAIM = {
  kind: 'claim',
  id: 'k2-2026-08-31',
  claim: 'A model named "k2" appears in arena.ai\'s leaderboard payload.',
  tier: 'confirmed-artifact',
  recorded: '2026-08-31',
  artifact: 'https://github.com/MaxwellBrohm/llm-catalog-archive/blob/abc/raw/arena-leaderboard/response.html',
};

const line = (o: Record<string, unknown>): string => JSON.stringify(o);

describe('parseLedger, the empty file', () => {
  it('reads the empty string as no claims', () => {
    expect(parseLedger('')).toEqual([]);
  });

  it('reads a file of blank lines as no claims', () => {
    expect(parseLedger('\n\n  \n')).toEqual([]);
  });

  /**
   * The shipped ledger is no longer empty, so this asserts the property that
   * matters instead: every line in it parses, and every claim carries the
   * artifact its tier promises.
   */
  it('reads the shipped ledger without throwing', () => {
    expect(() => parseLedger(fs.readFileSync('meta/leaks-ledger.jsonl', 'utf8'))).not.toThrow();
  });

  it('gives every shipped confirmed-artifact claim a real artifact link', () => {
    for (const c of parseLedger(fs.readFileSync('meta/leaks-ledger.jsonl', 'utf8'))) {
      if (c.tier === 'confirmed-artifact') expect(c.artifact, c.id).toMatch(/^https:\/\//);
    }
  });
});

describe('parseLedger, a claim line', () => {
  it('reads the claim sentence verbatim', () => {
    expect(parseLedger(line(CLAIM))[0]!.claim).toBe(
      'A model named "k2" appears in arena.ai\'s leaderboard payload.',
    );
  });

  it('reads the day it was recorded', () => {
    expect(parseLedger(line(CLAIM))[0]!.recorded).toBe('2026-08-31');
  });

  it('reads the sourcing tier', () => {
    expect(parseLedger(line(CLAIM))[0]!.tier).toBe('confirmed-artifact');
  });

  // A claim with no resolution line under it is open, and open is the ABSENCE
  // of a resolution rather than a value anybody writes.
  it('leaves an unresolved claim open', () => {
    expect(parseLedger(line(CLAIM))[0]!.outcome).toBe('open');
  });

  it('leaves an unresolved claim with no resolution date', () => {
    expect(parseLedger(line(CLAIM))[0]!.resolved).toBeNull();
  });

  it('keeps a credible claim that carries no artifact', () => {
    const row = { ...CLAIM, tier: 'credible', artifact: null };
    expect(parseLedger(line(row))[0]!.artifact).toBeNull();
  });

  it('keeps file order rather than sorting by the recorded day', () => {
    const later = { ...CLAIM, id: 'a', recorded: '2026-09-09' };
    const earlier = { ...CLAIM, id: 'b', recorded: '2026-01-01' };
    expect(parseLedger([line(later), line(earlier)].join('\n')).map((c) => c.id)).toEqual(['a', 'b']);
  });
});

describe('parseLedger, a resolution line', () => {
  const resolve = (o: Record<string, unknown> = {}) =>
    line({ kind: 'resolution', claim_id: CLAIM.id, outcome: 'confirmed', resolved: '2026-09-15', ...o });

  it('scores the claim it names', () => {
    expect(parseLedger([line(CLAIM), resolve()].join('\n'))[0]!.outcome).toBe('confirmed');
  });

  it('records the day the outcome was reached', () => {
    expect(parseLedger([line(CLAIM), resolve()].join('\n'))[0]!.resolved).toBe('2026-09-15');
  });

  it('records the note the resolution carried', () => {
    const text = [line(CLAIM), resolve({ note: 'the model shipped under that name' })].join('\n');
    expect(parseLedger(text)[0]!.resolutionNote).toBe('the model shipped under that name');
  });

  it('adds no row of its own', () => {
    expect(parseLedger([line(CLAIM), resolve()].join('\n'))).toHaveLength(1);
  });

  // The append-only shape leaves this as the only way to change one's mind in
  // public, so the later line has to be the one that counts.
  it('lets a later resolution overwrite an earlier one', () => {
    const text = [line(CLAIM), resolve({ outcome: 'refuted' }), resolve({ outcome: 'confirmed' })].join('\n');
    expect(parseLedger(text)[0]!.outcome).toBe('confirmed');
  });
});

describe('parseLedger, the refusals', () => {
  it('throws on a line that is not JSON', () => {
    expect(() => parseLedger('not json')).toThrow(/line 1: not valid JSON/);
  });

  it('throws on a JSON array rather than an object', () => {
    expect(() => parseLedger('[1,2]')).toThrow(/line 1: must be a JSON object/);
  });

  it('throws on an unknown kind', () => {
    expect(() => parseLedger(line({ kind: 'correction' }))).toThrow(/kind must be "claim" or "resolution"/);
  });

  it('names the line number of the offending row', () => {
    expect(() => parseLedger([line(CLAIM), 'oops'].join('\n'))).toThrow(/line 2: not valid JSON/);
  });

  it('throws on a claim with no id', () => {
    const { id: _drop, ...rest } = CLAIM;
    expect(() => parseLedger(line(rest))).toThrow(/id must be a non-empty string/);
  });

  it('throws on two claims sharing one id', () => {
    expect(() => parseLedger([line(CLAIM), line(CLAIM)].join('\n'))).toThrow(/duplicate claim id/);
  });

  it('throws on a tier outside the three the spec names', () => {
    expect(() => parseLedger(line({ ...CLAIM, tier: 'probably' }))).toThrow(/tier must be one of/);
  });

  it('throws on a recorded value that is not a day', () => {
    expect(() => parseLedger(line({ ...CLAIM, recorded: 'August 2026' }))).toThrow(/recorded must be a YYYY-MM-DD day/);
  });

  // Both anchors of the day pattern, separately. Mutation testing found each
  // one surviving on its own: without `^` a claim recorded "on 2026-08-31"
  // passes, and without `$` "2026-08-31 or thereabouts" does, and either turns
  // the one date column the ledger is scored on into free text.
  it('throws on a recorded day with text in front of it', () => {
    expect(() => parseLedger(line({ ...CLAIM, recorded: 'on 2026-08-31' }))).toThrow(/recorded must be a YYYY-MM-DD day/);
  });

  it('throws on a recorded day with text after it', () => {
    expect(() => parseLedger(line({ ...CLAIM, recorded: '2026-08-31 or thereabouts' }))).toThrow(
      /recorded must be a YYYY-MM-DD day/,
    );
  });

  // The tier is a statement ABOUT THE ARTIFACT, so a row claiming one and
  // carrying none is the ledger contradicting itself in the one field whose
  // purpose is to be checkable.
  it('throws on a confirmed-artifact claim with no artifact link', () => {
    expect(() => parseLedger(line({ ...CLAIM, artifact: null }))).toThrow(
      /tier confirmed-artifact requires an artifact link/,
    );
  });

  /*
   * The check used to run one way only: `confirmed-artifact` with no artifact
   * was refused, while `unconfirmed` WITH one was accepted and a
   * `confirmed-artifact` whose artifact read "not a url at all" was accepted
   * verbatim and rendered as a live anchor. Both directions are the same
   * promise, which is that the tier and the evidence column agree.
   */
  it('throws on an unconfirmed claim that carries an artifact anyway', () => {
    expect(() =>
      parseLedger(line({ ...CLAIM, tier: 'unconfirmed', artifact: 'https://example.test/x' })),
    ).toThrow(/tier unconfirmed records no artifact/);
  });

  it('accepts an unconfirmed claim with no artifact', () => {
    expect(parseLedger(line({ ...CLAIM, tier: 'unconfirmed', artifact: null }))[0]!.artifact).toBe(null);
  });

  it('throws on an artifact that is not a URL at all', () => {
    expect(() => parseLedger(line({ ...CLAIM, artifact: 'not a url at all' }))).toThrow(
      /artifact must be an absolute http or https URL/,
    );
  });

  it('throws on a relative artifact path', () => {
    expect(() => parseLedger(line({ ...CLAIM, artifact: '/raw/arena-leaderboard/response.html' }))).toThrow(
      /artifact must be an absolute http or https URL/,
    );
  });

  it('throws on an artifact with a non-http scheme', () => {
    expect(() => parseLedger(line({ ...CLAIM, artifact: 'javascript:alert(1)' }))).toThrow(
      /artifact must be an absolute http or https URL/,
    );
  });

  it('accepts a credible claim carrying an http artifact', () => {
    expect(parseLedger(line({ ...CLAIM, tier: 'credible', artifact: 'http://example.test/x' }))[0]!.tier).toBe(
      'credible',
    );
  });
});

describe('isArtifactLink', () => {
  it('accepts an https URL', () => {
    expect(isArtifactLink('https://github.com/MaxwellBrohm/llm-catalog-archive/blob/abc/raw/x.json')).toBe(true);
  });

  it('accepts an http URL', () => {
    expect(isArtifactLink('http://example.test/x')).toBe(true);
  });

  it('rejects a bare sentence', () => {
    expect(isArtifactLink('not a url at all')).toBe(false);
  });

  it('rejects a site-relative path', () => {
    expect(isArtifactLink('/raw/arena-leaderboard/response.html')).toBe(false);
  });

  // A URL by every parser's reckoning, and not a link a reader can go and look
  // at, which is the whole promise of the column.
  it('rejects a data URL', () => {
    expect(isArtifactLink('data:text/html,<b>x</b>')).toBe(false);
  });

  it('rejects a javascript URL', () => {
    expect(isArtifactLink('javascript:alert(1)')).toBe(false);
  });

  // Skipping it would silently drop a score, which inflates the accuracy rate
  // in the flattering direction.
  it('throws on a resolution naming a claim that is not in the file', () => {
    const orphan = line({ kind: 'resolution', claim_id: 'nobody', outcome: 'confirmed', resolved: '2026-09-15' });
    expect(() => parseLedger(orphan)).toThrow(/resolution names unknown claim_id nobody/);
  });

  it('throws on a resolution naming a claim that appears only below it', () => {
    const resolution = line({ kind: 'resolution', claim_id: CLAIM.id, outcome: 'confirmed', resolved: '2026-09-15' });
    expect(() => parseLedger([resolution, line(CLAIM)].join('\n'))).toThrow(/unknown claim_id/);
  });

  it('throws on an outcome that is not confirmed or refuted', () => {
    const row = line({ kind: 'resolution', claim_id: CLAIM.id, outcome: 'open', resolved: '2026-09-15' });
    expect(() => parseLedger([line(CLAIM), row].join('\n'))).toThrow(/outcome must be one of confirmed, refuted/);
  });

  it('throws on a resolution with no resolved day', () => {
    const row = line({ kind: 'resolution', claim_id: CLAIM.id, outcome: 'confirmed' });
    expect(() => parseLedger([line(CLAIM), row].join('\n'))).toThrow(/resolved must be a non-empty string/);
  });

  // The resolved day gets the same check as the recorded one, and it had none
  // until mutation testing found the whole branch surviving deletion. It is the
  // date that says WHEN the desk was scored, which is the half of the ledger a
  // reader checks against what was knowable at the time.
  it('throws on a resolved value that is not a day', () => {
    const row = line({ kind: 'resolution', claim_id: CLAIM.id, outcome: 'confirmed', resolved: 'last September' });
    expect(() => parseLedger([line(CLAIM), row].join('\n'))).toThrow(/resolved must be a YYYY-MM-DD day/);
  });

  it('throws on a resolved day with text after it', () => {
    const row = line({ kind: 'resolution', claim_id: CLAIM.id, outcome: 'confirmed', resolved: '2026-09-15 ish' });
    expect(() => parseLedger([line(CLAIM), row].join('\n'))).toThrow(/resolved must be a YYYY-MM-DD day/);
  });
});

describe('scoreLedger', () => {
  const claims = (outcomes: ('confirmed' | 'refuted' | 'open')[]) => {
    const lines: string[] = [];
    outcomes.forEach((o, i) => {
      lines.push(line({ ...CLAIM, id: `c${i}` }));
      if (o !== 'open') lines.push(line({ kind: 'resolution', claim_id: `c${i}`, outcome: o, resolved: '2026-09-15' }));
    });
    return parseLedger(lines.join('\n'));
  };

  it('counts every claim as the total', () => {
    expect(scoreLedger(claims(['confirmed', 'refuted', 'open'])).total).toBe(3);
  });

  it('counts the confirmed claims', () => {
    expect(scoreLedger(claims(['confirmed', 'confirmed', 'refuted'])).confirmed).toBe(2);
  });

  it('counts the refuted claims', () => {
    expect(scoreLedger(claims(['confirmed', 'refuted', 'refuted'])).refuted).toBe(2);
  });

  it('counts the claims that have not resolved', () => {
    expect(scoreLedger(claims(['confirmed', 'open', 'open'])).open).toBe(2);
  });

  it('divides confirmed by resolved rather than by total', () => {
    // Three confirmed, one refuted, two still open. 75%, not 50%.
    expect(scoreLedger(claims(['confirmed', 'confirmed', 'confirmed', 'refuted', 'open', 'open'])).accuracyPct).toBe(75);
  });

  it('rounds the rate to one decimal', () => {
    expect(scoreLedger(claims(['confirmed', 'confirmed', 'refuted'])).accuracyPct).toBe(66.7);
  });

  // An empty ledger has no accuracy, and both 0 and 100 would be a score
  // nobody earned. This is the number the whole ledger exists to produce, so
  // it is the one that most has to refuse to be invented.
  it('reports no rate at all when nothing has resolved', () => {
    expect(scoreLedger(claims(['open', 'open'])).accuracyPct).toBeNull();
  });

  it('reports no rate at all for an empty ledger', () => {
    expect(scoreLedger([]).accuracyPct).toBeNull();
  });
});
