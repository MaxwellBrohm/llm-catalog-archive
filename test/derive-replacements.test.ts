import { describe, it, expect } from 'vitest';
import { parseReplacementTable, parseDeprecationTable } from '../src/derive/events.js';
import { deprecationsDoc, replacementTable } from './derive-fixtures.js';

/**
 * The third column of the deprecation-history tables is the only place in the
 * whole archive where a provider names a successor to one of its own models,
 * and it is the field the retirement query needs to be worth running. These
 * tests are about transcription: nothing here decides that a replacement is
 * equivalent to what it replaces.
 */
describe('parseReplacementTable', () => {
  it('reads the deprecated model and its recommended replacement out of one row', () => {
    expect([
      ...parseReplacementTable(
        replacementTable([['August 5, 2026', 'claude-opus-4-1-20250805', 'claude-opus-4-8']]),
      ),
    ]).toEqual([['claude-opus-4-1-20250805', 'claude-opus-4-8']]);
  });

  it('reads every row of a table that retires two models at once', () => {
    expect([
      ...parseReplacementTable(
        replacementTable([
          ['June 15, 2026', 'claude-sonnet-4-20250514', 'claude-sonnet-4-6'],
          ['June 15, 2026', 'claude-opus-4-20250514', 'claude-opus-4-8'],
        ]),
      ),
    ]).toEqual([
      ['claude-sonnet-4-20250514', 'claude-sonnet-4-6'],
      ['claude-opus-4-20250514', 'claude-opus-4-8'],
    ]);
  });

  it('reads a second table further down the same document', () => {
    const doc = [
      replacementTable([['August 5, 2026', 'claude-opus-4-1-20250805', 'claude-opus-4-8']]),
      '',
      '### 2026-04-14: Claude Sonnet 4',
      '',
      replacementTable([['June 15, 2026', 'claude-sonnet-4-20250514', 'claude-sonnet-4-6']]),
    ].join('\n');
    expect(parseReplacementTable(doc).get('claude-sonnet-4-20250514')).toBe('claude-sonnet-4-6');
  });

  // The document lists its history newest first, so the first row for a model
  // is its most recent recommendation. A last-wins rule would publish a
  // superseded successor as the current one.
  it('keeps the first recommendation when one model appears in two history entries', () => {
    const doc = [
      replacementTable([['August 5, 2026', 'claude-opus-4-1-20250805', 'claude-opus-4-8']]),
      '',
      replacementTable([['August 5, 2026', 'claude-opus-4-1-20250805', 'claude-opus-4-5']]),
    ].join('\n');
    expect(parseReplacementTable(doc).get('claude-opus-4-1-20250805')).toBe('claude-opus-4-8');
  });

  // The lifecycle table in the same document is four columns of the same shape,
  // and its column 1 holds `Active`. A width-only parser would file every live
  // model under a replacement named "Active".
  it('reads nothing out of the four-column lifecycle table in the same document', () => {
    expect([
      ...parseReplacementTable(
        deprecationsDoc([['claude-opus-5', 'Active', 'N/A', 'Not sooner than July 24, 2027']]),
      ),
    ]).toEqual([]);
  });

  it('reads nothing out of a three-column table with a different header', () => {
    const doc = ['| Model | Deprecated model | Recommended replacement |', '| - | - | - |', '| a | b | c |'].join('\n');
    expect([...parseReplacementTable(doc)]).toEqual([]);
  });

  it('skips the dashed separator row rather than filing it as a model', () => {
    const map = parseReplacementTable(
      replacementTable([['August 5, 2026', 'claude-opus-4-1-20250805', 'claude-opus-4-8']]),
    );
    expect(map.has('----------------')).toBe(false);
  });

  it('stops at the first line that is not a three-column row', () => {
    const doc = [
      replacementTable([['August 5, 2026', 'claude-opus-4-1-20250805', 'claude-opus-4-8']]),
      '',
      '| June 15, 2026 | `claude-sonnet-4-20250514` | `claude-sonnet-4-6` |',
    ].join('\n');
    expect(parseReplacementTable(doc).has('claude-sonnet-4-20250514')).toBe(false);
  });

  it('leaves the lifecycle table parser reading the same document unchanged', () => {
    const doc = [
      deprecationsDoc([['claude-opus-5', 'Active', 'N/A', 'Not sooner than July 24, 2027']]),
      replacementTable([['August 5, 2026', 'claude-opus-4-1-20250805', 'claude-opus-4-8']]),
    ].join('\n');
    expect([...parseDeprecationTable(doc)]).toEqual([['claude-opus-5', 'Not sooner than July 24, 2027']]);
  });

  it('reads the live artifact: claude-opus-4-1-20250805 is recorded against claude-opus-4-8', async () => {
    const fs = await import('node:fs');
    const text = fs.readFileSync('raw/anthropic-deprecations/response.md', 'utf8');
    expect(parseReplacementTable(text).get('claude-opus-4-1-20250805')).toBe('claude-opus-4-8');
  });
});

/**
 * The header is matched on all three cells. Each of these tables differs from
 * the real header in exactly one column, so a parser that stopped checking that
 * column would read them and publish a replacement out of a table that is not
 * a replacement table.
 */
describe('parseReplacementTable: the header, cell by cell', () => {
  const rows = ['| - | - | - |', '| August 5, 2026 | `claude-x` | `claude-y` |'];

  it('reads nothing when the first column is not the retirement date', () => {
    const doc = ['| Removed on | Deprecated model | Recommended replacement |', ...rows].join('\n');
    expect([...parseReplacementTable(doc)]).toEqual([]);
  });

  it('reads nothing when the second column is not the deprecated model', () => {
    const doc = ['| Retirement date | Model | Recommended replacement |', ...rows].join('\n');
    expect([...parseReplacementTable(doc)]).toEqual([]);
  });

  it('reads nothing when the third column is not the recommended replacement', () => {
    const doc = ['| Retirement date | Deprecated model | Successor |', ...rows].join('\n');
    expect([...parseReplacementTable(doc)]).toEqual([]);
  });
});

describe('parseReplacementTable: the rows it declines to record', () => {
  const withRows = (body: string[]): string =>
    ['| Retirement date | Deprecated model | Recommended replacement |', '| --- | --- | --- |', ...body].join('\n');

  // The separator test is anchored at both ends. A name that merely starts or
  // ends with a dash is a name, not a rule, and dropping it would silently lose
  // a real row.
  it('records a model name that starts and ends with a dash', () => {
    expect(parseReplacementTable(withRows(['| August 5, 2026 | `-legacy-` | `claude-opus-4-8` |'])).get('-legacy-')).toBe(
      'claude-opus-4-8',
    );
  });

  it('records nothing under an empty model cell', () => {
    expect(parseReplacementTable(withRows(['| August 5, 2026 |  | `claude-opus-4-8` |'])).has('')).toBe(false);
  });

  it('records no empty replacement for a model whose replacement cell is blank', () => {
    expect(parseReplacementTable(withRows(['| August 5, 2026 | `claude-x` |  |'])).has('claude-x')).toBe(false);
  });

  it('keeps reading the table after a row it declined to record', () => {
    const map = parseReplacementTable(
      withRows(['| August 5, 2026 |  | `claude-opus-4-8` |', '| August 5, 2026 | `claude-x` | `claude-y` |']),
    );
    expect(map.get('claude-x')).toBe('claude-y');
  });
});
