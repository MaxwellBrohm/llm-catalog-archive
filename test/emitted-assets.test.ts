import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import postcss from 'postcss';
import { WALL_JS } from '../src/site/wall-js.js';
import { STYLESHEET } from '../src/site/css.js';

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
