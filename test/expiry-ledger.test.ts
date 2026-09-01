import { describe, it, expect } from 'vitest';
import {
  expiryLedgerLines,
  expiryClaimId,
  expiryClaimSentence,
  renderLedgerLines,
  type LedgerLine,
} from '../src/derive/expiry-ledger.js';
import { parseLedger, scoreLedger } from '../src/site/ledger.js';
import type { FeedItem } from '../src/derive/feed.js';

/**
 * THE LEDGER HAD NO PATH TO EVER HOLDING A LINE.
 *
 * A ledger claim is a PREDICTION, and the copy rule forbids the derivation from
 * predicting, so the scorecard the brief named as part of the leaks desk was a
 * promise with no mechanism behind it. The catalog's own `expiration_date` is
 * the one prediction already in the bytes: dated, falsifiable, and in the SAME
 * NAMESPACE as the catalogue, so it is checkable against a later capture with
 * no join. Retirement floors cannot be used this way, because joining
 * `anthropic/claude-opus-4.1` to `claude-opus-4-1-20250805` is the guess this
 * project refuses.
 */
const item = (catalogId: string, date: string, iso = '2026-08-30T21:14:08.000Z'): FeedItem =>
  ({
    id: `sha:expiration_scheduled:${catalogId}`,
    kind: 'event',
    type: 'expiration_scheduled',
    sentence: 'x',
    sha: 'a'.repeat(40),
    sourceId: 'openrouter-models',
    path: 'raw/openrouter-models/response.json',
    stamp: { iso, kind: 'origin_date', label: iso },
    entities: [],
    facts: [],
    tier: null,
    event: { type: 'expiration_set', modelId: catalogId, date },
    leak: null,
  }) as unknown as FeedItem;

const LINK = 'https://github.com/x/y/blob/abc/raw/openrouter-models/response.json';
const permalink = () => LINK;
const none = { claimIds: new Set<string>(), resolvedIds: new Set<string>() };
const catalogWith = (ids: string[], observedAt: string) => ({
  ids: new Set(ids),
  stamp: `${observedAt} (origin_date)`,
  observedAt,
});

describe('a claim is written once, from the bytes', () => {
  const lines = expiryLedgerLines(
    [item('moonshotai/kimi-k2.5', '2026-08-31')],
    catalogWith(['moonshotai/kimi-k2.5'], '2026-08-30T00:00:00.000Z'),
    '2026-08-30',
    none,
    permalink,
  );

  it('emits the claim', () => {
    expect(lines.filter((l) => l.kind === 'claim')).toHaveLength(1);
  });

  /**
   * The scoring rule is IN the sentence. A line recording only "the catalog
   * listed an expiration_date" is trivially true the day it is written and
   * would score 100% for ever, which is a scorecard measuring nothing.
   */
  it('states what would refute it, not merely what the field said', () => {
    expect(expiryClaimSentence('a/b', '2026-01-01')).toContain('Scored as:');
    expect(expiryClaimSentence('a/b', '2026-01-01')).toContain('absent from the catalog after that date');
  });

  it('quotes every value read out of the payload', () => {
    expect(expiryClaimSentence('a/b', '2026-01-01')).toContain('"a/b"');
    expect(expiryClaimSentence('a/b', '2026-01-01')).toContain('"2026-01-01"');
  });

  it('makes the artifact the capture the date was read out of', () => {
    const claim = lines.find((l) => l.kind === 'claim') as Extract<LedgerLine, { kind: 'claim' }>;
    expect(claim.artifact).toBe(LINK);
    expect(claim.tier).toBe('confirmed-artifact');
  });

  it('dates the claim by the capture, not by the run', () => {
    const claim = lines.find((l) => l.kind === 'claim') as Extract<LedgerLine, { kind: 'claim' }>;
    expect(claim.recorded).toBe('2026-08-30');
  });

  it('never writes a claim it already holds', () => {
    const again = expiryLedgerLines(
      [item('moonshotai/kimi-k2.5', '2026-08-31')],
      catalogWith(['moonshotai/kimi-k2.5'], '2026-08-30T00:00:00.000Z'),
      '2026-08-30',
      { claimIds: new Set([expiryClaimId('moonshotai/kimi-k2.5', '2026-08-31')]), resolvedIds: new Set() },
      permalink,
    );
    expect(again.filter((l) => l.kind === 'claim')).toHaveLength(0);
  });

  it('writes one claim for a model that appears in many captures', () => {
    const many = expiryLedgerLines(
      [item('a/b', '2026-09-04'), item('a/b', '2026-09-04'), item('a/b', '2026-09-04')],
      catalogWith(['a/b'], '2026-08-30T00:00:00.000Z'),
      '2026-08-30',
      none,
      permalink,
    );
    expect(many.filter((l) => l.kind === 'claim')).toHaveLength(1);
  });
});

describe('resolution waits for evidence, not for the clock', () => {
  const claimed = { claimIds: new Set([expiryClaimId('a/b', '2026-08-31')]), resolvedIds: new Set<string>() };

  it('does not resolve while the newest capture predates the expiry', () => {
    const lines = expiryLedgerLines(
      [item('a/b', '2026-08-31')],
      catalogWith(['a/b'], '2026-08-30T12:00:00.000Z'),
      '2026-09-05',
      claimed,
      permalink,
    );
    expect(lines.filter((l) => l.kind === 'resolution')).toHaveLength(0);
  });

  /**
   * A date is a DAY. An id removed during 2026-08-31 is not late, so the
   * deadline is the end of that day and not its start.
   */
  it('does not resolve on a capture taken during the expiry day itself', () => {
    const lines = expiryLedgerLines(
      [item('a/b', '2026-08-31')],
      catalogWith(['a/b'], '2026-08-31T23:00:00.000Z'),
      '2026-09-01',
      claimed,
      permalink,
    );
    expect(lines.filter((l) => l.kind === 'resolution')).toHaveLength(0);
  });

  it('REFUTES when the id is still listed after the expiry day', () => {
    const lines = expiryLedgerLines(
      [item('a/b', '2026-08-31')],
      catalogWith(['a/b'], '2026-09-01T10:00:00.000Z'),
      '2026-09-01',
      claimed,
      permalink,
    );
    const r = lines.find((l) => l.kind === 'resolution') as Extract<LedgerLine, { kind: 'resolution' }>;
    expect(r.outcome).toBe('refuted');
    expect(r.note).toContain('Still listed');
  });

  it('CONFIRMS when the id is gone after the expiry day', () => {
    const lines = expiryLedgerLines(
      [item('a/b', '2026-08-31')],
      catalogWith(['other/c'], '2026-09-01T10:00:00.000Z'),
      '2026-09-01',
      claimed,
      permalink,
    );
    const r = lines.find((l) => l.kind === 'resolution') as Extract<LedgerLine, { kind: 'resolution' }>;
    expect(r.outcome).toBe('confirmed');
    expect(r.note).toContain('Absent');
  });

  it('names the capture its verdict rests on', () => {
    const lines = expiryLedgerLines(
      [item('a/b', '2026-08-31')],
      catalogWith(['a/b'], '2026-09-01T10:00:00.000Z'),
      '2026-09-01',
      claimed,
      permalink,
    );
    const r = lines.find((l) => l.kind === 'resolution') as Extract<LedgerLine, { kind: 'resolution' }>;
    expect(r.note).toContain('2026-09-01T10:00:00.000Z (origin_date)');
  });

  it('never resolves the same claim twice', () => {
    const lines = expiryLedgerLines(
      [item('a/b', '2026-08-31')],
      catalogWith(['a/b'], '2026-09-01T10:00:00.000Z'),
      '2026-09-01',
      { claimIds: new Set([expiryClaimId('a/b', '2026-08-31')]), resolvedIds: new Set([expiryClaimId('a/b', '2026-08-31')]) },
      permalink,
    );
    expect(lines.filter((l) => l.kind === 'resolution')).toHaveLength(0);
  });
});

describe('what it refuses to touch', () => {
  it('ignores an event that is not an expiration', () => {
    const other = {
      ...item('a/b', '2026-08-31'),
      type: 'price_changed',
      event: { type: 'price_changed', modelId: 'a/b' },
    } as unknown as FeedItem;
    expect(expiryLedgerLines([other], catalogWith(['a/b'], '2026-09-05T00:00:00.000Z'), '2026-09-05', none, permalink)).toEqual([]);
  });

  it('ignores an expiration whose date is not a day', () => {
    const bad = {
      ...item('a/b', '2026-08-31'),
      event: { type: 'expiration_set', modelId: 'a/b', date: 'never' },
    } as unknown as FeedItem;
    expect(expiryLedgerLines([bad], catalogWith(['a/b'], '2026-09-05T00:00:00.000Z'), '2026-09-05', none, permalink)).toEqual([]);
  });

  it('emits nothing at all for an empty feed', () => {
    expect(expiryLedgerLines([], catalogWith([], '2026-09-05T00:00:00.000Z'), '2026-09-05', none, permalink)).toEqual([]);
  });
});

/**
 * THE ROUND TRIP. Lines this module writes must be lines the ledger parser
 * accepts, or the build stops on a malformed line, which is what the parser is
 * built to do.
 */
describe('the lines it writes are lines the ledger accepts', () => {
  const lines = [
    ...expiryLedgerLines([item('a/b', '2026-08-31')], catalogWith(['a/b'], '2026-08-30T00:00:00.000Z'), '2026-08-30', none, permalink),
    ...expiryLedgerLines(
      [item('a/b', '2026-08-31')],
      catalogWith(['a/b'], '2026-09-01T10:00:00.000Z'),
      '2026-09-01',
      { claimIds: new Set([expiryClaimId('a/b', '2026-08-31')]), resolvedIds: new Set() },
      permalink,
    ),
  ];
  const text = renderLedgerLines(lines);

  it('parses without throwing', () => {
    expect(() => parseLedger(text)).not.toThrow();
  });

  it('produces one claim carrying its resolution', () => {
    const claims = parseLedger(text);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.outcome).toBe('refuted');
    expect(claims[0]?.resolved).toBe('2026-09-01');
  });

  it('scores it, which is the number the ledger exists to produce', () => {
    const card = scoreLedger(parseLedger(text));
    expect(card.total).toBe(1);
    expect(card.refuted).toBe(1);
    expect(card.accuracyPct).toBe(0);
  });

  it('ends with a newline, so appending twice does not join two lines', () => {
    expect(text.endsWith('\n')).toBe(true);
  });

  it('renders nothing for nothing, so a quiet run appends no blank line', () => {
    expect(renderLedgerLines([])).toBe('');
  });
});
