/**
 * three.js, copied out of node_modules into the deployed site.
 *
 * THE ONE IMPURE PIECE OF THE SITE GENERATOR, and it is deliberately quarantined
 * in its own file rather than smuggled into build.ts. src/site/build.ts and
 * src/site/render.ts are pure functions of their arguments, which is what lets
 * every page be tested without a filesystem; a 350 KiB library read off disk
 * cannot be either of those things, so it is read here and handed to writeSite
 * as ordinary bytes.
 *
 * COPIED RATHER THAN LINKED TO A CDN. The site is static files on Pages and it
 * is meant to keep working when nothing else does: a CDN is a third party that
 * can rewrite, rate-limit or lose the file, and this repository's whole claim is
 * that what it serves is what it stored.
 *
 * COPIED RATHER THAN COMMITTED. R7 forbids rewriting history, so a build asset
 * committed once is committed forever, and 720 KiB of vendored minified library
 * would sit in the archive's pack for the life of the project next to the
 * artifacts that are the point of it. `three` is a devDependency and the deploy
 * workflow already runs `npm ci`.
 *
 * ABSENT IS NOT TOLERATED, for the reason section 11 of the design gives about
 * the ledgers: a generator that shrugged at a missing library would emit an
 * index.html asking for a module that 404s, on every deploy, silently, and the
 * only symptom would be a front door that never appears for anyone.
 *
 * RESOLVED FROM THIS FILE, NOT FROM THE WORKING DIRECTORY. three is a
 * dependency of the GENERATOR, not of the archive the generator is pointed at.
 * An earlier version joined `node_modules` onto `process.cwd()`, which is the
 * repository being built: it happened to work for the deploy, where those are
 * the same directory, and threw for every caller that builds a checkout from
 * somewhere else, which includes every test in test/site-cli.test.ts. Resolving
 * from `import.meta.url` asks the same question Node's own `import` asks, from
 * the same place, so the answer does not depend on where the process started.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { THREE_CORE_PATH, THREE_MODULE_PATH } from './wall.js';
import type { SiteFile } from './build.js';

/**
 * The two files three ships as its ES module build. `three.module.min.js` has
 * exactly one import and it is `./three.core.min.js`, so both go to the same
 * directory and the relative specifier resolves without a rewrite. Nothing else
 * is copied: three has no other runtime dependency.
 */
const THREE_FILES: ReadonlyArray<readonly [string, string]> = [
  ['three.module.min.js', THREE_MODULE_PATH],
  ['three.core.min.js', THREE_CORE_PATH],
];

/**
 * Node's own resolver, anchored at this file. `threeBuildDir` takes it as a
 * parameter only so its refusal can be exercised: `three` is installed in every
 * tree the suite runs in, so the alternative to injecting a resolver that
 * throws is a comment claiming what would happen if it were not.
 */
const defaultResolve = (id: string): string => createRequire(import.meta.url).resolve(id);

/**
 * The directory three's build products sit in, found by resolving the package
 * the way an `import 'three'` in this very file would resolve it.
 *
 * The package entry is asked for rather than the minified file, because three's
 * `exports` map publishes `.` and refuses a deep `three/build/...` specifier
 * outright. Both files this module wants are siblings of that entry, so the
 * entry's directory IS the directory, and the per-file check below is what
 * turns a three that ever moves them into a loud build failure rather than a
 * front door that silently 404s.
 */
export function threeBuildDir(resolve: (id: string) => string = defaultResolve): string {
  try {
    return path.dirname(resolve('three'));
  } catch {
    throw new Error(
      'the `three` package is not installed; refusing to build a site whose front door asks for a module that is not there (npm ci installs it)',
    );
  }
}

/**
 * The vendored files, read out of `dir`. The default is the only value the
 * deploy ever passes; the parameter exists so the refusal below can be tested
 * against a directory that really is missing the file, rather than by trusting
 * a comment about what would happen.
 */
export function vendorFiles(dir: string = threeBuildDir()): SiteFile[] {
  return THREE_FILES.map(([from, to]) => {
    const abs = path.join(dir, from);
    if (!fs.existsSync(abs)) {
      throw new Error(
        `${from} is missing from ${dir}; refusing to build a site whose front door asks for a module that is not there (npm ci installs it)`,
      );
    }
    return { path: to, contents: fs.readFileSync(abs, 'utf8') };
  });
}
