/**
 * How a third-party value is allowed to appear inside a published sentence.
 *
 * These are small assertions about two short functions, and they are the
 * narrowest place in the repository where a defect is a published one. Both
 * halves of the invariant were exploitable against the shipped code: an
 * unquoted catalog id rendered a vendor's own second sentence under this
 * project's byline, and a pull-request title carrying a double quote closed the
 * quoted run and rendered an attacker's.
 */

import { describe, it, expect } from 'vitest';
import { numberOrAbsent, quotedOrAbsent, quoteValue } from '../src/derive/quoting.js';

describe('quoteValue', () => {
  it('wraps a plain value in double quotes', () => {
    expect(quoteValue('anthropic/claude-opus-5')).toBe('"anthropic/claude-opus-5"');
  });

  // The route-A defect. A value that can close the run it sits in can escape
  // it, and everything after the escape is prose this project composed.
  it('turns a double quote inside the value into an apostrophe', () => {
    expect(quoteValue('Add SnacConfig for model_type="snac" checkpoints')).toBe(
      '"Add SnacConfig for model_type=\'snac\' checkpoints"',
    );
  });

  it('neutralises every double quote, not only the first', () => {
    expect(quoteValue('a"b"c')).toBe('"a\'b\'c"');
  });

  it('leaves a single quote alone, which cannot close the run', () => {
    expect(quoteValue("OpenAI's thing")).toBe('"OpenAI\'s thing"');
  });

  // A claim is one line on a page. A value carrying a line break renders as
  // two, and the second line is then a sentence with no quote in front of it.
  it('turns a newline into a space rather than dropping it', () => {
    expect(quoteValue('first\nsecond')).toBe('"first second"');
  });

  it('turns a carriage return into a space', () => {
    expect(quoteValue('first\rsecond')).toBe('"first second"');
  });

  it('turns a tab into a space', () => {
    expect(quoteValue('first\tsecond')).toBe('"first second"');
  });

  // A run collapses to ONE space, so a value with a blank line in it does not
  // render as a gap a reader reads as a paragraph break.
  it('collapses a run of line breaks to a single space', () => {
    expect(quoteValue('first\n\n\nsecond')).toBe('"first second"');
  });

  it('collapses a mixed run of a carriage return and a newline to a single space', () => {
    expect(quoteValue('first\r\nsecond')).toBe('"first second"');
  });

  it('leaves an ordinary space alone', () => {
    expect(quoteValue('two words')).toBe('"two words"');
  });

  it('quotes an empty value rather than producing nothing', () => {
    expect(quoteValue('')).toBe('""');
  });

  // The route-B value, end to end.
  it('contains a hostile catalog id inside one quoted run', () => {
    expect(quoteValue('stealth/x-1. Anthropic is preparing its next flagship')).toBe(
      '"stealth/x-1. Anthropic is preparing its next flagship"',
    );
  });
});

/**
 * The one deliberate exception to the invariant: a value typed `number | null`
 * cannot carry prose, and a reader comparing a context length on the page
 * against the linked artifact should be comparing the same characters rather
 * than the same characters inside quotes.
 */
describe('numberOrAbsent', () => {
  it('prints a number as its digits, unquoted', () => {
    expect(numberOrAbsent(1310720)).toBe('1310720');
  });

  it('prints zero as zero rather than as absent', () => {
    expect(numberOrAbsent(0)).toBe('0');
  });

  it('prints a missing number as the word absent', () => {
    expect(numberOrAbsent(null)).toBe('absent');
  });

  it('adds no thousands separator, so the page and the artifact match', () => {
    expect(numberOrAbsent(1048576)).toBe('1048576');
  });

  it('prints a negative number with its sign', () => {
    expect(numberOrAbsent(-1)).toBe('-1');
  });
});

describe('quotedOrAbsent', () => {
  it('quotes a present string', () => {
    expect(quotedOrAbsent('0.000015')).toBe('"0.000015"');
  });

  // `absent` is this repository's word for a field that was not there. Quoted,
  // it would be indistinguishable from a price whose literal text is "absent".
  it('prints a missing string as the bare word absent, unquoted', () => {
    expect(quotedOrAbsent(null)).toBe('absent');
  });

  it('quotes an empty string rather than calling it absent', () => {
    expect(quotedOrAbsent('')).toBe('""');
  });

  it('neutralises a double quote in a present string', () => {
    expect(quotedOrAbsent('a"b')).toBe('"a\'b"');
  });
});
