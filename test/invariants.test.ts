import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DEFAULT_API } from '../bin/llmcat.js';
import { SITE_URL } from '../src/site/record.js';

/**
 * The residue of the plan's Task 13, which was frozen. Four of its five
 * assertions already exist under other filenames in test/config.test.ts and
 * test/predicate.test.ts, two of them stronger than the plan asked for. What
 * was genuinely missing is here.
 */

const readSrc = (p: string) => fs.readFileSync(p, 'utf8');

/**
 * PURITY. A module that reads the filesystem, starts a process or fetches is a
 * module that cannot be tested without one, and every one of these is a pure
 * function of its arguments by design. The same assertion already guards
 * predicate, magnitude, secrets and status; these three were missed.
 */
describe.each(['src/config.ts', 'src/health.ts', 'src/headers.ts'])('%s is pure', (file) => {
  const source = readSrc(file);

  it.each(['node:fs', 'node:child_process', 'node:https', 'node:http', './fetch.js', './git.js'])(
    'does not import %s',
    (mod) => {
      expect(source).not.toContain(`'${mod}'`);
      expect(source).not.toContain(`"${mod}"`);
    },
  );

  it('does not read a clock of its own', () => {
    // Every one of these takes its instant as an argument, so a bare Date.now
    // or new Date() would make its output depend on when the test ran.
    expect(source).not.toMatch(/\bDate\.now\(\)/);
    expect(source).not.toMatch(/new Date\(\s*\)/);
  });

  it('does not call fetch', () => {
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
});

/**
 * THE PUBLISHED ORIGIN IS WRITTEN TWICE, DELIBERATELY, SO IT IS PINNED HERE.
 *
 * bin/llmcat.ts repeats the site origin rather than importing src/site/record.ts,
 * because its whole distribution claim is ONE FILE with ZERO dependencies: it is
 * packed by npm and run under npx with nothing else resolved. Importing a src
 * module to save a string would trade the property the CLI is sold on for a
 * line of tidiness.
 *
 * The cost of duplication is drift, and this is what pays it: change one and
 * this fails. The rest of the generator is already parameterised, so a domain
 * move is LCA_SITE_URL plus this constant.
 */
describe('the CLI and the site agree on where the archive is published', () => {
  it('derives the API base from the same origin the site renders', () => {
    expect(DEFAULT_API).toBe(`${SITE_URL}/api/v1`);
  });

  it('keeps the CLI free of any src import, which is what the duplication buys', () => {
    const cli = readSrc('bin/llmcat.ts');
    expect(cli).not.toMatch(/from '\.\.\/src\//);
  });

  it('imports nothing but node builtins', () => {
    const specifiers = [...readSrc('bin/llmcat.ts').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) expect(spec, spec).toMatch(/^node:/);
  });
});

/**
 * EVERY STORED BODY HAS ITS SIDECAR IN THE SAME COMMIT.
 *
 * The sidecar carries the response headers, the observation instant and the
 * origin date, and precision_seconds is computed from those. A body committed
 * without one is a capture whose timing cannot be reconstructed, in a history
 * R7 forbids rewriting, so it can never be repaired.
 */
describe('a stored body is never committed without its headers', () => {
  const commits = execFileSync('git', ['log', '--format=%H', '-n', '200'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((l) => l !== '');
  const shallow =
    execFileSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() === 'true';

  /*
   * A SHALLOW CLONE MAKES THIS TEST A LIE, NOT A SKIP. With one commit reachable
   * the walk below finds no offender and reports success, which is the vacuous
   * pass this whole suite exists to refuse. CI therefore checks out with a
   * depth, and this asserts it got one, so the guard fails LOUDLY rather than
   * passing quietly if that is ever removed.
   */
  it('was given enough history to be evidence, rather than one grafted commit', () => {
    expect(
      commits.length,
      shallow
        ? `only ${commits.length} commit(s) reachable in a shallow clone; the workflow needs fetch-depth`
        : 'the repository has too little history for this check',
    ).toBeGreaterThan(20);
  });

  it('pairs every raw/<id>/response.* with raw/<id>/headers.json in the same commit', () => {
    const offenders: string[] = [];
    for (const sha of commits) {
      const files = execFileSync('git', ['show', '--name-only', '--format=', sha], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter((f) => f.startsWith('raw/'));
      if (files.length === 0) continue;
      const bodies = files.filter((f) => /^raw\/[^/]+\/response\./.test(f));
      for (const body of bodies) {
        const dir = body.slice(0, body.lastIndexOf('/'));
        if (!files.includes(`${dir}/headers.json`)) offenders.push(`${sha.slice(0, 7)}: ${body}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
