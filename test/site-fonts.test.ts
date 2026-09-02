import { describe, it, expect } from 'vitest';
import { STYLESHEET } from '../src/site/css.js';
import { fontVendorFiles, fontFilesDir, FONT_DIR, iconFiles } from '../src/site/vendor.js';
import { textContents, buildSite, FAVICON_SVG } from '../src/site/build.js';

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

/**
 * THE SITE HAD NO FAVICON AT ALL. favicon.ico and favicon.svg both 404'd on the
 * live deployment, so every tab showed a browser default.
 */
describe('the favicon', () => {
  const files = buildSite([], undefined, { threads: [], held: [] }, [], [], []);
  const emitted = new Set(files.map((f) => f.path));

  it('ships the vector mark', () => {
    expect(emitted.has('favicon.svg')).toBe(true);
  });

  it('ships the raster fallbacks, which Safari and older browsers need', () => {
    const icons = iconFiles().map((f) => f.path);
    expect(icons).toContain('favicon.ico');
    expect(icons).toContain('apple-touch-icon.png');
  });

  it('ships them as bytes, so the ico is not corrupted by an encoding', () => {
    for (const f of iconFiles()) expect(typeof f.contents).not.toBe('string');
  });

  it('is a real ICO and a real PNG, checked by signature rather than extension', () => {
    const by = new Map(iconFiles().map((f) => [f.path, f.contents as Uint8Array]));
    expect([...(by.get('favicon.ico') as Uint8Array).slice(0, 4)]).toEqual([0, 0, 1, 0]);
    expect([...(by.get('apple-touch-icon.png') as Uint8Array).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('links all three from every page head', () => {
    const page = textContents(files.find((f) => f.path === 'index.html') as never);
    expect(page).toContain('rel="icon" href="favicon.svg"');
    expect(page).toContain('favicon.ico');
    expect(page).toContain('apple-touch-icon.png');
  });

  /** A page one directory down must not ask for /changelog/favicon.svg. */
  it('resolves the icon from a nested page too', () => {
    const nested = textContents(files.find((f) => f.path === 'about.html') as never);
    expect(nested).toContain('favicon.svg');
  });

  it('draws the mark in the design language and not in a default blue', () => {
    expect(FAVICON_SVG).toContain('#ff6a00');
    expect(FAVICON_SVG).toContain('#050505');
  });

  /** Three beads, not one: a single bead on a rail reads as a map pin. */
  it('carries the wire and more than one capture on it', () => {
    expect((FAVICON_SVG.match(/<circle/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });
});
