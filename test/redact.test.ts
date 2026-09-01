import { describe, expect, it } from 'vitest';
import { countEmails, redactLine, EMAIL_PLACEHOLDER } from '../src/site/redact.js';

/**
 * The fixture is a real line shape from `modelsdev-commits`: an Atom commit
 * entry carries an <email> per author and per Co-authored-by trailer. The
 * addresses below are the ones that actually reached the built site.
 */
const ATOM_LINE =
  '  <author><name>P Kreil</name><email>pkreil3@gmail.com</email></author>';
const TRAILER_LINE =
  'Co-authored-by: someone &lt;mickalchen@tencent.com&gt; and claude@jperla.com';

describe('redactLine', () => {
  it('masks a personal address in an Atom author element', () => {
    const out = redactLine(ATOM_LINE);
    expect(out).not.toContain('pkreil3@gmail.com');
    expect(out).toContain(EMAIL_PLACEHOLDER);
    // the surrounding markup survives: this is a mask, not a line drop
    expect(out).toContain('<name>P Kreil</name>');
  });

  it('masks every address on a line, not just the first', () => {
    const out = redactLine(TRAILER_LINE);
    expect(out).not.toContain('mickalchen@tencent.com');
    expect(out).not.toContain('claude@jperla.com');
    expect(out.match(/\[email redacted\]/g)).toHaveLength(2);
  });

  it('masks role and noreply addresses too, because the rule has no exceptions', () => {
    // A heuristic that spared these would have to judge which addresses are
    // personal, and would publish a private one every time it judged wrong.
    expect(redactLine('noreply@anthropic.com')).toBe(EMAIL_PLACEHOLDER);
    expect(redactLine('rekram1-node@users.noreply.github.com')).toBe(EMAIL_PLACEHOLDER);
  });

  it('leaves a line with no address exactly alone', () => {
    const plain = '  <title>fix: bump context window to 262144</title>';
    expect(redactLine(plain)).toBe(plain);
    expect(countEmails(plain)).toBe(0);
  });

  it('does not treat a bare @mention or a version string as an address', () => {
    expect(redactLine('@openrouter bumped @types/node to 26.1.2')).toBe(
      '@openrouter bumped @types/node to 26.1.2',
    );
  });

  it('counts what it would mask', () => {
    expect(countEmails(ATOM_LINE)).toBe(1);
    expect(countEmails(TRAILER_LINE)).toBe(2);
  });
});
