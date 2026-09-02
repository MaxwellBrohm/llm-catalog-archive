import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import postcss from 'postcss';
import { WALL_JS } from '../src/site/wall-js.js';
import { STYLESHEET } from '../src/site/css.js';
import { FILTER_JS, FILTER_JS_PATH } from '../src/site/filter-js.js';
import { buildSite, textContents, type SiteFile } from '../src/site/build.js';
import { artifact, record } from './site-fixtures.js';
import { buildThreads } from '../src/derive/threads.js';
import { buildFeed } from '../src/derive/feed.js';
import { deriveEvents } from '../src/derive/events.js';
import { catalog, change } from './derive-fixtures.js';

const THREADS_FIXTURE = buildThreads(
  buildFeed(
    deriveEvents([
      change({
        before: catalog([{ id: 'vendor/a' }]),
        after: catalog([{ id: 'vendor/a' }, { id: 'vendor/b' }, { id: 'other/c' }]),
      }),
    ]),
    [],
  ),
);

/**
 * THE TWO PROGRAMS THIS GENERATOR EMITS THAT NOTHING EVER PARSED.
 *
 * wall.js and style.css are both built as TEMPLATE LITERALS inside TypeScript,
 * so `tsc --noEmit` sees two well-formed strings and the test suite renders
 * them into pages and greps them. Neither guard can see a syntax error in the
 * program the browser is handed. Measured:
 *
 *   `const COLS = 4;` -> `const COLS = ;` in wall-js.ts:
 *       2,345 tests green, tsc exit 0, node --check "SyntaxError: Unexpected token"
 *   one closing brace dropped in css.ts:
 *       2,345 tests green, postcss "Unclosed block", and 90 of 185 rules become
 *       nested inside another rule
 *
 * pages.yml has no test step and triggers on the collectors finishing, so a
 * broken stylesheet or a dead front door would publish on the next capture.
 */

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * `node --check` on a real file, not `new Function(src)`, because the wall is an
 * ES module: it uses `import()` and top-level module syntax that a Function
 * body neither accepts nor rejects the same way.
 */
function nodeCheck(source: string, ext: string): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-js-'));
  temps.push(dir);
  const file = path.join(dir, `emitted.${ext}`);
  fs.writeFileSync(file, source);
  execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

describe('the emitted browser module is a program a browser can parse', () => {
  it('is not empty, so this cannot pass by checking nothing', () => {
    expect(WALL_JS.length).toBeGreaterThan(1000);
  });

  it('parses as an ES module', () => {
    expect(() => nodeCheck(WALL_JS, 'mjs')).not.toThrow();
  });

  /** The check is only evidence if it rejects a broken program. */
  it('the checker rejects a broken program', () => {
    expect(() => nodeCheck('const COLS = ;', 'mjs')).toThrow();
  });

  it('the checker rejects an unclosed function', () => {
    expect(() => nodeCheck('function f() {', 'mjs')).toThrow();
  });

  it('fetches nothing from another origin', () => {
    expect(WALL_JS).not.toContain('://');
  });
});

describe('the emitted stylesheet is a stylesheet a browser can parse', () => {
  const parsed = () => postcss.parse(STYLESHEET, { from: 'style.css' });

  it('is not empty, so this cannot pass by checking nothing', () => {
    expect(STYLESHEET.length).toBeGreaterThan(1000);
  });

  it('parses', () => {
    expect(() => parsed()).not.toThrow();
  });

  it('the parser rejects an unclosed block', () => {
    expect(() => postcss.parse('a { color: red;', { from: 'x.css' })).toThrow();
  });

  /**
   * The failure a dropped brace actually produces. postcss will happily parse
   * `a { b { ... } }` as nesting, so "it parsed" is not enough on its own: a
   * missing brace swallows every following rule into the one above it, and 90
   * of 185 rules moved that way in the measured mutation.
   */
  it('nests no rule inside another rule, which is what a dropped brace produces', () => {
    const nested: string[] = [];
    parsed().walkRules((rule) => {
      if (rule.parent !== undefined && rule.parent.type === 'rule') nested.push(rule.selector);
    });
    expect(nested).toEqual([]);
  });

  it('has the rule count a whole stylesheet has, not the handful a swallowed one leaves', () => {
    let rules = 0;
    parsed().walkRules(() => {
      rules += 1;
    });
    expect(rules).toBeGreaterThan(100);
  });

  it('declares the design language colours it is supposed to', () => {
    expect(STYLESHEET).toContain('#050505');
    expect(STYLESHEET).toContain('#ff6a00');
  });
});

/**
 * THE FILTER IS DRAWN OVER A LIST THAT IS COMPLETE WITHOUT IT.
 *
 * The brief asked for a publication that is browsable AND queryable, and 494
 * pages carried no search box, no filter and no form of any kind. Queryability
 * existed only through the CLI and the JSON API, which is a different audience
 * from a person reading a page.
 *
 * The same rule as the 3D wall governs it: HTML first, the enhancement drawn
 * over it, never the reverse. The input is created BY THE SCRIPT, so a reader
 * with JavaScript off never sees a control that does nothing.
 */
describe('the emitted filter is a program a browser can parse', () => {
  it('is not empty', () => {
    expect(FILTER_JS.length).toBeGreaterThan(500);
  });

  it('parses', () => {
    expect(() => nodeCheck(FILTER_JS, 'js')).not.toThrow();
  });

  it('fetches nothing from anywhere', () => {
    expect(FILTER_JS).not.toContain('://');
    expect(FILTER_JS).not.toMatch(/\bfetch\s*\(/);
    expect(FILTER_JS).not.toContain('XMLHttpRequest');
  });

  it('creates its own input rather than expecting one in the markup', () => {
    expect(FILTER_JS).toContain("createElement('input')");
  });

  it('does nothing at all when no table asks for it', () => {
    expect(FILTER_JS).toContain("querySelectorAll('table[data-filter]')");
    expect(FILTER_JS).toContain('if (tables.length === 0) return;');
  });

  it('announces the count to a screen reader', () => {
    expect(FILTER_JS).toContain("setAttribute('aria-live', 'polite')");
    expect(FILTER_JS).toContain("setAttribute('aria-label'");
  });
});

describe('the pages that offer a filter', () => {
  const files = buildSite([record({ artifacts: [artifact()] })], undefined, THREADS_FIXTURE);
  const get = (p: string) => textContents(files.find((f) => f.path === p) as SiteFile);

  it('emits the script beside the stylesheet, under a fixed name', () => {
    expect(files.some((f) => f.path === FILTER_JS_PATH)).toBe(true);
  });

  it.each(['threads/index.html', 'changelog/index.html'])('%s marks its table and loads the script', (page) => {
    const html = get(page);
    expect(html).toContain('data-filter=');
    expect(html).toContain(FILTER_JS_PATH);
  });

  /**
   * THE NO-JS CONTRACT. The rows are in the HTML and the control is not, so
   * turning JavaScript off costs a reader the filter and nothing else.
   */
  it.each(['threads/index.html', 'changelog/index.html'])('%s ships no filter control in its markup', (page) => {
    expect(get(page)).not.toContain('class="filter-input"');
  });

  it('leaves the rows in the served HTML, so the list stands without the script', () => {
    const html = get('threads/index.html');
    const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/g, '');
    expect((withoutScripts.match(/<tr>/g) ?? []).length).toBeGreaterThan(1);
  });

  it('does not load the script on a page with nothing long to filter', () => {
    expect(get('about.html')).not.toContain(FILTER_JS_PATH);
  });

  /**
   * BOTH HALVES. Asserting only that the stylesheet has a .filter-input rule
   * let a mutation that stopped the script SETTING that class survive: the rule
   * existed, nothing wore it, and the control rendered as a bare browser input
   * in the middle of a MaxOS page.
   */
  it('styles the control it creates, so it is not an unstyled box', () => {
    expect(FILTER_JS).toContain("input.className = 'filter-input'");
    expect(STYLESHEET).toContain('.filter-input');
  });

  it('styles the count it announces', () => {
    expect(FILTER_JS).toContain("count.className = 'filter-count'");
    expect(STYLESHEET).toContain('.filter-count');
  });
});

/**
 * THE RAIL FOLLOWS THE READER.
 *
 * The split grid sets align-items: start, so the 320px column sat at the top of
 * a 27,000px stream and then stopped, leaving roughly 5,000px of dead column
 * beside the content. That emptiness is a fifth of the page's width doing
 * nothing for most of its height, and it is part of why the lower page read as
 * unconsidered.
 */
describe('the side rail', () => {
  const rule = /\.split-side \{([^}]*)\}/.exec(STYLESHEET)?.[1] ?? '';

  it('travels with the reader instead of stopping at the top', () => {
    expect(rule).toContain('position: sticky');
    expect(rule).toContain('top:');
  });

  /** A sticky element taller than the screen strands its own bottom. */
  it('caps at the viewport and scrolls internally when it is the longer column', () => {
    expect(rule).toContain('max-height: calc(100vh');
    expect(rule).toContain('overflow-y: auto');
  });

  it('does not travel for a reader who asked for less motion', () => {
    expect(STYLESHEET).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.split-side \{ position: static/);
  });

  /** Below the breakpoint sticky would pin a tall index over the article. */
  it('does not travel in the single-column layout', () => {
    expect(STYLESHEET).toMatch(/max-width: 900px\)\s*\{\s*\.split-side \{ position: static/);
  });
});
