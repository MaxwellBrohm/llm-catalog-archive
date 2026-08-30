import { describe, it, expect } from 'vitest';
import { parseRetractions, retractionFor } from '../src/site/retractions.js';
import { OTHER_SHA, SHA } from './site-fixtures.js';

describe('parseRetractions', () => {
  it('reads no retractions from the empty ledger the archive launched with', () => {
    expect(parseRetractions('')).toEqual([]);
  });

  it('reads a sha-only line as a whole-commit retraction', () => {
    expect(parseRetractions(`{"sha":"${SHA}"}\n`)).toEqual([{ sha: SHA, path: null, reason: null }]);
  });

  it('reads an optional path as the scope of the retraction', () => {
    expect(parseRetractions(`{"sha":"${SHA}","path":"raw/openai-llms-txt/response.txt"}\n`)).toEqual([
      { sha: SHA, path: 'raw/openai-llms-txt/response.txt', reason: null },
    ]);
  });

  it('reads an optional reason', () => {
    expect(parseRetractions(`{"sha":"${SHA}","reason":"wrong source url"}\n`)).toEqual([
      { sha: SHA, path: null, reason: 'wrong source url' },
    ]);
  });

  it('reads every line of a multi-line ledger', () => {
    const text = `{"sha":"${SHA}"}\n{"sha":"${OTHER_SHA}"}\n`;
    expect(parseRetractions(text).map((r) => r.sha)).toEqual([SHA, OTHER_SHA]);
  });

  it('ignores blank lines, which a text editor adds at the end', () => {
    expect(parseRetractions(`\n{"sha":"${SHA}"}\n\n`)).toHaveLength(1);
  });

  it('keeps unknown keys from breaking the build, because the record schema belongs to D', () => {
    expect(parseRetractions(`{"sha":"${SHA}","retracted_at":"2026-09-01","by":"max"}\n`)).toEqual([
      { sha: SHA, path: null, reason: null },
    ]);
  });

  // Every rejection below is the same decision: a retraction that fails to
  // parse would publish an unretracted page, and R7 makes that commit permanent.
  it('throws on a line that is not JSON', () => {
    expect(() => parseRetractions('not json\n')).toThrow('line 1: not valid JSON');
  });

  it('throws on a JSON array, which carries no sha', () => {
    expect(() => parseRetractions('[]\n')).toThrow('line 1: must be a JSON object');
  });

  it('throws when sha is missing', () => {
    expect(() => parseRetractions('{"path":"raw/x/response.txt"}\n')).toThrow('line 1: sha must be a full 40 character commit sha');
  });

  it('throws on an abbreviated sha, which does not pin a commit', () => {
    expect(() => parseRetractions('{"sha":"a0a9e12"}\n')).toThrow('sha must be a full 40 character commit sha');
  });

  it('reports the line number of the offending row', () => {
    expect(() => parseRetractions(`{"sha":"${SHA}"}\nbroken\n`)).toThrow('line 2: not valid JSON');
  });

  it('throws when path is present but not a string', () => {
    expect(() => parseRetractions(`{"sha":"${SHA}","path":7}\n`)).toThrow('line 1: path must be a string');
  });

  it('throws when reason is present but not a string', () => {
    expect(() => parseRetractions(`{"sha":"${SHA}","reason":false}\n`)).toThrow('line 1: reason must be a string');
  });

  // The sha pattern is anchored at both ends. Each of these three is rejected
  // by exactly one anchor or one character class, so they are not one claim
  // written three ways.
  it('throws on a sha with an extra character after it', () => {
    expect(() => parseRetractions(`{"sha":"${SHA}f"}\n`)).toThrow('sha must be a full 40 character commit sha');
  });

  it('throws on a sha with an extra character before it', () => {
    expect(() => parseRetractions(`{"sha":"f${SHA}"}\n`)).toThrow('sha must be a full 40 character commit sha');
  });

  it('throws on an uppercase sha, which git never prints', () => {
    expect(() => parseRetractions(`{"sha":"${SHA.toUpperCase()}"}\n`)).toThrow('sha must be a full 40 character commit sha');
  });

  it('throws on a JSON string, which carries no sha', () => {
    expect(() => parseRetractions('"just a string"\n')).toThrow('line 1: must be a JSON object');
  });

  it('throws on JSON null, which carries no sha', () => {
    expect(() => parseRetractions('null\n')).toThrow('line 1: must be a JSON object');
  });

  it('reads an explicit null path as no path', () => {
    expect(parseRetractions(`{"sha":"${SHA}","path":null}\n`)[0]?.path).toBeNull();
  });

  it('reads a last line with no trailing newline', () => {
    expect(parseRetractions(`{"sha":"${SHA}"}`)).toHaveLength(1);
  });

  // A ledger is appended to by hand as well as by tooling, and a stray space is
  // not a reason to leave a change unmarked.
  it('reads a line padded with whitespace', () => {
    expect(parseRetractions(`   {"sha":"${SHA}"}   \n`)).toEqual([{ sha: SHA, path: null, reason: null }]);
  });

  it('reads a line ending in a carriage return', () => {
    expect(parseRetractions(`{"sha":"${SHA}"}\r\n`)).toHaveLength(1);
  });

  // Not the same claim as the blank-line case: a whitespace-only line is not
  // the empty string, so without the trim it reaches JSON.parse and throws.
  it('ignores a whitespace-only line', () => {
    expect(parseRetractions('   \n')).toEqual([]);
  });
});

describe('retractionFor', () => {
  it('finds the retraction naming a commit', () => {
    const rows = parseRetractions(`{"sha":"${OTHER_SHA}"}\n{"sha":"${SHA}","reason":"x"}\n`);
    expect(retractionFor(rows, SHA)).toEqual({ sha: SHA, path: null, reason: 'x' });
  });

  it('is null for a commit the ledger does not name', () => {
    expect(retractionFor(parseRetractions(`{"sha":"${OTHER_SHA}"}\n`), SHA)).toBeNull();
  });

  it('is null against the empty ledger', () => {
    expect(retractionFor([], SHA)).toBeNull();
  });
});
