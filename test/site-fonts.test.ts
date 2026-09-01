import { describe, it, expect } from 'vitest';
import { STYLESHEET } from '../src/site/css.js';
import { fontVendorFiles, fontFilesDir, FONT_DIR } from '../src/site/vendor.js';
import { textContents } from '../src/site/build.js';

/**
 * The stylesheet used to open with `@import url('https://fonts.googleapis.com/...')`.
 * That is a third-party request on every page load, an undisclosed handover of
 * every reader's IP address, and a dependency outside the archive's control, on
 * a project that vendors three.js specifically to avoid all three.
 */
describe('the stylesheet is self-contained', () => {
  it('names no external host at all', () => {
    const hosts = [...STYLESHEET.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]);
    expect(hosts).toEqual([]);
  });

  it('does not @import anything', () => {
    expect(STYLESHEET).not.toContain('@import');
  });

  it('declares its faces locally instead', () => {
    expect(STYLESHEET).toContain('@font-face');
  });

  it('still asks for the three families the design language names', () => {
    for (const family of ['Space Grotesk', 'Inter', 'JetBrains Mono']) {
      expect(STYLESHEET).toContain(`font-family: '${family}'`);
    }
  });
});

describe('every typeface the stylesheet asks for is shipped', () => {
  const emitted = new Set(fontVendorFiles().map((f) => f.path));

  /** Every url() the stylesheet references, relative to the site root. */
  const referenced = [...STYLESHEET.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1] as string);

  it('references at least one font file, so this cannot pass by matching nothing', () => {
    expect(referenced.length).toBeGreaterThan(0);
  });

  it('emits a file for every url() in the stylesheet', () => {
    for (const ref of referenced) {
      expect(emitted.has(ref), `${ref} is referenced by style.css but not emitted`).toBe(true);
    }
  });

  it('emits nothing the stylesheet does not ask for', () => {
    for (const path of emitted) {
      expect(referenced.includes(path), `${path} is emitted but no rule references it`).toBe(true);
    }
  });

  it('ships them as bytes, not as text, so the woff2 is not corrupted', () => {
    for (const f of fontVendorFiles()) {
      expect(typeof f.contents, `${f.path} was read as a string`).not.toBe('string');
      expect(() => textContents(f)).toThrow();
    }
  });

  it('ships real woff2, checked by the file signature rather than the extension', () => {
    for (const f of fontVendorFiles()) {
      const bytes = f.contents as Uint8Array;
      // 'wOF2'
      expect([...bytes.slice(0, 4)], `${f.path} is not a woff2`).toEqual([0x77, 0x4f, 0x46, 0x32]);
    }
  });

  it('puts them all under the one directory the stylesheet points at', () => {
    for (const f of fontVendorFiles()) expect(f.path.startsWith(`${FONT_DIR}/`)).toBe(true);
  });
});

describe('a missing typeface package fails the build rather than the page', () => {
  it('refuses when the package cannot be resolved', () => {
    const explode = (): string => {
      throw new Error('not installed');
    };
    expect(() => fontFilesDir('@fontsource-variable/inter', explode)).toThrow(/is not installed/);
  });

  it('says which package, so the message is actionable', () => {
    const explode = (): string => {
      throw new Error('not installed');
    };
    expect(() => fontFilesDir('@fontsource-variable/space-grotesk', explode)).toThrow(/space-grotesk/);
  });
});
