/**
 * The 3D front door, asserted from the two places it can actually break.
 *
 * The wall is decoration in the sense that nothing depends on it, and it is NOT
 * decoration in the sense that nothing needs to be true about it. Two things do:
 *
 *   - every tab addresses a page this same build writes. A tab is a permalink
 *     rendered as a slab, and a slab that 404s is worse than no slab, because a
 *     reader who clicks a wall and lands on nothing learns that the archive is
 *     broken rather than that the wall is;
 *   - the page underneath is a whole index with the scripts deleted. The 3D
 *     layer is allowed to exist only because it adds a surface rather than
 *     becoming one, and the way that stops being true is gradual: a sentence
 *     moves into the canvas, then a link, then the list is a stub. The floors
 *     below are what makes that move loud.
 *
 * Everything here is pure over a literal feed. No git, no fs except the one
 * vendored-library read, which is the single impure step in the generator.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSite, type SiteFile } from '../src/site/build.js';
import { WALL_JS } from '../src/site/wall-js.js';
import { STYLESHEET } from '../src/site/css.js';
import {
  jsonIsland,
  wallHtml,
  wallTabs,
  WALL_TABS,
  WALL_JS_PATH,
  THREE_CORE_PATH,
  THREE_MODULE_PATH,
} from '../src/site/wall.js';
import { threeBuildDir, vendorFiles } from '../src/site/vendor.js';
import { buildThreads, type ThreadSet } from '../src/derive/threads.js';
import { buildFeed, type FeedItem } from '../src/derive/feed.js';
import type { DerivedEvent } from '../src/derive/events.js';
import type { Entity } from '../src/derive/entities.js';
import type { Stamp } from '../src/site/record.js';

const stamp = (iso: string): Stamp => ({ iso, kind: 'origin' });

const LAB: Entity = { kind: 'lab', id: 'lab/anthropic', label: 'anthropic' };

/** A distinct 40-hex sha per event, so a per-item link is a per-item claim. */
const shaFor = (n: number): string => `a69a068319de9dc9a7ab1049b411a562a026e7${String(n).padStart(2, '0')}`;

function modelEvent(n: number): DerivedEvent {
  const id = `anthropic/claude-model-${String(n).padStart(2, '0')}`;
  const SHA = shaFor(n);
  return {
    id: `${SHA}:model_added:${id}`,
    type: 'model_added',
    sha: SHA,
    sourceId: 'openrouter-models',
    path: 'raw/openrouter-models/response.json',
    // Distinct minutes, descending with n, so buildThreads' "most recently
    // active first" ordering is a real ordering here and the twelve tabs the
    // wall takes are a decidable twelve rather than whatever the sort left.
    stamp: stamp(`2026-08-28T08:${String(59 - n).padStart(2, '0')}:00.000Z`),
    entities: [{ kind: 'model', id: `model/openrouter:${id}`, label: id }, LAB],
    held: false,
    modelId: id,
    created: 1787752741,
    precisionSeconds: 4500,
  } as DerivedEvent;
}

/**
 * Twenty models and the lab they all belong to: twenty-one threads, which is
 * more than the wall's twelve and more than the front page rail's eight. The
 * gap is the point. Four of the wall's tabs address thread pages nothing else
 * on the index links, so "the tab's page exists" is a claim about the wall
 * rather than a claim it inherits from the rail.
 *
 * BUILT INSIDE EACH TEST, NOT ONCE AT MODULE SCOPE, and that is a measurement
 * rather than a style: Stryker activates a mutant per test run, and anything a
 * test file computes while it is being imported is computed BEFORE the switch
 * is thrown. A first pass of this file held the rendered index in a const and
 * eight guards in wall.ts reported SURVIVED that this same suite kills once the
 * render happens inside the `it`. A fixture built at import time cannot be
 * evidence about the code that built it.
 */
function site(): { feed: FeedItem[]; threads: ThreadSet; files: SiteFile[]; index: string } {
  const feed = buildFeed(
    Array.from({ length: 20 }, (_, i) => modelEvent(i)),
    [],
  );
  const threads = buildThreads(feed);
  const files = buildSite([], undefined, threads, [], [], feed, []);
  return { feed, threads, files, index: (files.find((f) => f.path === 'index.html')?.contents as string | undefined) ?? '' };
}

/**
 * A capturing match, or a thrown error rather than an empty result.
 *
 * Most assertions below are of the form "the ones that fail this are none", and
 * an extractor that returned nothing when the wall was absent would make every
 * one of them pass on a build with no wall at all. The whole file's evidence
 * rests on this, so it refuses rather than returns.
 */
function section(html: string, re: RegExp, what: string): string {
  const found = re.exec(html);
  if (found === null || found[1] === undefined) throw new Error(`no ${what} in the rendered index`);
  return found[1];
}

function hrefsIn(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
}

/** Every href in the wall's own <ul>, which is what a reader without WebGL clicks. */
function wallListHrefs(html: string): string[] {
  return hrefsIn(section(html, /<ul class="wall-list"[^>]*>([\s\S]*?)<\/ul>/, 'wall list'));
}

/** The JSON island, which is what the 3D layer draws instead of the list. */
function island(html: string): Array<{ href: string; label: string }> {
  return JSON.parse(
    section(html, /<script type="application\/json" data-wall-tabs>([\s\S]*?)<\/script>/, 'tab island'),
  );
}

/**
 * The page as a reader with scripting off receives it: every script ELEMENT
 * gone, contents and all, not merely the tags. Deleting the tags alone would
 * leave the island's JSON in the text and quietly inflate every count below.
 */
function withoutScripts(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
}

function hrefCount(html: string): number {
  return [...html.matchAll(/href="/g)].length;
}

/** The visible text, tags and entities gone, as a word count. */
function wordCount(html: string): number {
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/g, ' ')
    .trim();
  return text === '' ? 0 : text.split(/\s+/).length;
}

// ---------------------------------------------------------------------------
// every tab is a permalink to a page this build writes
// ---------------------------------------------------------------------------

describe('the wall’s tabs', () => {
  // Stated as an assertion rather than left to the extractors below, which
  // refuse rather than return when the markup is absent. A refusal is a loud
  // failure and a correct one, but it is an Error and not a claim, and a page
  // that stopped mounting the front door at all should fail as a claim.
  it('is mounted on the index at all', () => {
    expect(site().index).toContain('<div class="wall" data-wall>');
  });

  it('addresses only pages the same build emits', () => {
    const { files, index } = site();
    const emitted = new Set(files.map((f) => f.path));
    expect(wallListHrefs(index).filter((h) => !emitted.has(h))).toEqual([]);
  });

  it('draws the 3D layer from the same addresses the list carries', () => {
    const { index } = site();
    expect(island(index).map((t) => t.href)).toEqual(wallListHrefs(index));
  });

  // The front page rail carries eight threads and the wall carries twelve, so
  // four of the wall's tabs are the only link to their page on the whole index.
  // Without this the assertion above would be inherited from the rail rather
  // than being a claim about the wall.
  it('reaches thread pages the front page rail does not link', () => {
    const index = site().index;
    const railed = new Set(hrefsIn(section(index, /<ul class="rail">([\s\S]*?)<\/ul>/, 'thread rail')));
    expect(wallListHrefs(index).filter((h) => !railed.has(h))).toHaveLength(WALL_TABS - railed.size);
  });

  it('addresses a thread page rather than a fragment of the index', () => {
    expect(wallListHrefs(site().index).filter((h) => h.includes('#') || h.includes('?'))).toEqual([]);
  });

  it('stops at the stated cap rather than at the thread count', () => {
    expect(wallListHrefs(site().index)).toHaveLength(WALL_TABS);
  });

  it('sends the threads it left off to the uncapped index', () => {
    const { threads, index } = site();
    expect(index).toContain(
      `The other ${threads.threads.length - WALL_TABS} are in <a href="threads/index.html">the threads index</a>`,
    );
  });

  it('takes the tabs in the order buildThreads put the threads', () => {
    const { threads } = site();
    expect(wallTabs(threads).map((t) => t.label)).toEqual(
      threads.threads.slice(0, WALL_TABS).map((t) => t.entity.label),
    );
  });
});

// ---------------------------------------------------------------------------
// the index with scripting off
// ---------------------------------------------------------------------------

describe('the index with every script element deleted', () => {
  /*
   * BOTH OF THESE READ THE ISLAND AND CHECK THE LIST, which is the only order
   * that says anything. Reading the list and checking the list passes on a page
   * whose list is empty, and checking the labels against the whole page passes
   * on one that moved them into the canvas, because the thread rail and the
   * stream print eight of the same twelve labels lower down. The island is the
   * 3D layer's own copy of the tabs, so "everything the canvas would draw is
   * also in the list" is the property, and it is the property that fails the
   * moment a tab exists only in three dimensions.
   */
  it('still carries every address the wall deep-links, in the list itself', () => {
    const index = site().index;
    const list = section(withoutScripts(index), /<ul class="wall-list"[^>]*>([\s\S]*?)<\/ul>/, 'wall list');
    expect(island(index).filter((t) => !list.includes(`href="${t.href}"`))).toEqual([]);
  });

  it('still prints every tab’s catalogue label in the list itself', () => {
    const index = site().index;
    const list = section(withoutScripts(index), /<ul class="wall-list"[^>]*>([\s\S]*?)<\/ul>/, 'wall list');
    expect(island(index).filter((t) => !list.includes(`>${t.label}</code>`))).toEqual([]);
  });

  // The list is rendered VISIBLE and wall.js hides it, rather than the other
  // way round. That order is the whole no-JavaScript story: a list shipped
  // hidden is a list nobody without scripting ever sees, and it would satisfy
  // every markup assertion above while being invisible on the page.
  it('ships the list with nothing on it that would hide it', () => {
    const tag = section(site().index, /<ul class="wall-list"([^>]*)>/, 'wall list tag');
    expect(tag).toBe(' data-wall-list');
  });

  it('still links every item in the stream to the commit it was read out of', () => {
    const { feed, index } = site();
    const bare = withoutScripts(index);
    expect(feed.filter((i) => !bare.includes(`href="changes/${i.sha}.html"`))).toEqual([]);
  });

  // A derived floor beside the exact claims above: every card in the stream
  // carries four links, its type, its source, its commit and the raw artifact
  // at that commit, and the front page renders one card per feed item. A build
  // that moved the stream behind WebGL cannot clear this.
  it('links at least four pages per item in the stream', () => {
    const { feed, index } = site();
    expect(hrefCount(withoutScripts(index))).toBeGreaterThanOrEqual(feed.length * 4);
  });

  // A blunt floor beside the derived one, and deliberately blunt: it exists to
  // catch a rewrite that hollowed the page out wholesale rather than to police
  // copy edits. This fixture measures 1,489 words with every script deleted, so
  // the page can lose a third of its prose before this fires, and cannot lose
  // the stream, the rail or the masthead without firing.
  it('keeps at least a thousand words of readable prose', () => {
    expect(wordCount(withoutScripts(site().index))).toBeGreaterThanOrEqual(1000);
  });
});

// ---------------------------------------------------------------------------
// what one tab prints
// ---------------------------------------------------------------------------

/**
 * A small archive with the three shapes a tab has to render: a thread with one
 * item, a thread with two, and a thread whose only item carries no timestamp at
 * all. The last one is the shape the publication refuses to fake a date for,
 * and it is the one a fixture built from happy-path events never produces.
 */
function tabEvent(over: Partial<DerivedEvent>): DerivedEvent {
  return { ...modelEvent(0), ...over } as DerivedEvent;
}

const SOLO: Entity = { kind: 'model', id: 'model/openrouter:solo', label: 'solo' };
const PAIR: Entity = { kind: 'model', id: 'model/openrouter:pair', label: 'pair' };
const UNDATED: Entity = { kind: 'model', id: 'model/openrouter:undated', label: 'undated' };

function small(): ThreadSet {
  return buildThreads(
    buildFeed(
      [
        tabEvent({ id: 'a', entities: [SOLO], stamp: stamp('2026-08-28T08:00:00.000Z') }),
        tabEvent({ id: 'b', entities: [PAIR], stamp: stamp('2026-08-27T08:00:00.000Z') }),
        tabEvent({ id: 'c', entities: [PAIR], stamp: stamp('2026-08-26T08:00:00.000Z') }),
        tabEvent({ id: 'd', entities: [UNDATED], stamp: null }),
      ],
      [],
    ),
  );
}

/** The wall over `small()`, carrying every thread it has. Rendered per test. */
function smallHtml(): string {
  const threads = small();
  return wallHtml(threads, threads.threads.length);
}

/**
 * The one `<li>` whose label is `label`, and nothing after its `</li>`. The
 * trailing cut matters: without it the last tab's slice runs on into the JSON
 * island, which repeats every other tab's timestamp, and an assertion that a
 * tab prints no date would read one off a neighbour.
 */
function tabFor(html: string, label: string): string {
  const found = html.split('<li>').find((li) => li.includes(`>${label}<`));
  if (found === undefined) throw new Error(`no tab for ${label}`);
  const end = found.indexOf('</li>');
  if (end === -1) throw new Error(`unterminated tab for ${label}`);
  return found.slice(0, end);
}

describe('what a tab prints', () => {
  it('prints the entity’s own catalogue label', () => {
    expect(tabFor(smallHtml(), 'solo')).toContain('<code class="wall-label">solo</code>');
  });

  it('prints the entity’s kind', () => {
    expect(tabFor(smallHtml(), 'solo')).toContain('<span class="wall-kind">model</span>');
  });

  it('counts one item in the singular', () => {
    expect(tabFor(smallHtml(), 'solo')).toContain('1 item &middot;');
  });

  it('counts two items in the plural', () => {
    expect(tabFor(smallHtml(), 'pair')).toContain('2 items &middot;');
  });

  it('prints the newest item’s timestamp rather than the oldest', () => {
    expect(tabFor(smallHtml(), 'pair')).toContain('27 August 2026 08:00 UTC');
  });

  // Labelled origin or observed exactly as every other surface labels it. A tab
  // that printed a bare date would be claiming a precision the archive has not
  // earned, which is the one thing this publication is not allowed to do.
  it('labels that timestamp with the kind of stamp it is', () => {
    expect(tabFor(smallHtml(), 'pair')).toContain('<span class="badge badge-origin">origin</span>');
  });

  it('says a thread with no timestamp has no sidecar rather than dating it', () => {
    expect(tabFor(smallHtml(), 'undated')).toContain('<span class="badge badge-observed">no sidecar</span>');
  });

  it('prints no timestamp at all on that tab', () => {
    expect(tabFor(smallHtml(), 'undated')).not.toContain('UTC');
  });
});

/**
 * The escaping in jsonIsland, which is the one place on this page where a value
 * out of a stored artifact is written somewhere that is not HTML-parsed.
 *
 * A catalogue id is a provider's string, not ours. escapeHtml is the wrong tool
 * inside a script element, because the parser does not decode entities there and
 * `&amp;` would arrive at JSON.parse as five literal characters; escaping `<`
 * alone is what makes `</script>` unwritable while leaving the bytes identical
 * to the bytes we meant.
 */
const HOSTILE = '</script><img src=x onerror=alert(1)>';

describe('the JSON island the 3D layer reads', () => {
  it('writes no bare < at all, so no value in it can close the element', () => {
    expect(jsonIsland({ label: HOSTILE })).not.toContain('<');
  });

  it('hands JSON.parse back the exact string it was given', () => {
    expect(JSON.parse(jsonIsland({ label: HOSTILE })).label).toBe(HOSTILE);
  });

  // The reason escapeHtml is the wrong tool here, stated as bytes: a script
  // element's contents are not HTML-parsed, so an ampersand written as `&amp;`
  // reaches JSON.parse as five characters and the label a reader sees on a slab
  // is not the label the provider published.
  it('writes an ampersand as itself rather than as an entity', () => {
    expect(jsonIsland({ label: 'gpt & friends' })).toContain('gpt & friends');
  });

  it('carries a hostile catalogue label through the wall unchanged', () => {
    const threads = buildThreads(
      buildFeed(
        [
          tabEvent({
            id: 'h',
            entities: [{ kind: 'model', id: 'model/openrouter:hostile', label: HOSTILE }],
            stamp: stamp('2026-08-28T08:00:00.000Z'),
          }),
        ],
        [],
      ),
    );
    expect(island(wallHtml(threads, 1))[0]?.label).toBe(HOSTILE);
  });
});

describe('the wall on an archive it fits entirely', () => {
  it('sends nobody to the threads index when it is carrying every thread', () => {
    expect(smallHtml()).toContain('as tabs. Where this browser can draw it');
  });

  it('counts the threads it left off when it is not', () => {
    const threads = small();
    expect(wallHtml(threads, threads.threads.length + 5)).toContain(
      'The other 5 are in <a href="threads/index.html">the threads index</a>, uncapped.',
    );
  });

  // Not an empty frame, not a heading over nothing: no wall at all. The stage
  // reserves no space for a thing that may never arrive, and neither does this.
  it('renders nothing whatsoever for an archive with no threads', () => {
    expect(wallHtml({ threads: [], held: [] }, 0)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// nothing is fetched from anywhere but this deployment
// ---------------------------------------------------------------------------

/** Every dynamic import specifier the browser module asks for. */
function imports(): string[] {
  return [...WALL_JS.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );
}

describe('the browser module’s dependencies', () => {
  it('is emitted exactly once, at the path index.html asks for it by', () => {
    expect(site().files.filter((f) => f.path === WALL_JS_PATH)).toHaveLength(1);
  });

  it('is asked for by index.html as a module rather than a classic script', () => {
    expect(site().index).toContain(`<script type="module" src="${WALL_JS_PATH}"></script>`);
  });

  // The whole point of vendoring. GitHub Pages serves static files and this
  // archive's claim is that what it serves is what it stored, so a front door
  // that reached a third party at read time would make that claim false for
  // every reader whose request that third party dropped, rewrote or throttled.
  it('names no scheme-qualified host anywhere in its source', () => {
    expect(WALL_JS.match(/[a-z][a-z0-9+.-]*:\/\//gi) ?? []).toEqual([]);
  });

  it('names no protocol-relative host either', () => {
    expect(WALL_JS.match(/(?:^|[\s(=,'"`])\/\/[a-z0-9-]+\.[a-z]{2,}/gi) ?? []).toEqual([]);
  });

  it('asks for exactly one module at runtime', () => {
    expect(imports()).toHaveLength(1);
  });

  // wall.js sits at the site root, so a specifier of './x/y' is the file 'x/y'.
  // This is the join between two files that do not import each other: wall-js.ts
  // writes the specifier as text, and vendor.ts decides where the bytes land.
  it('asks only for paths the deploy writes beside it', () => {
    const vendored = new Set(vendorFiles().map((f) => f.path));
    expect(imports().filter((s) => !vendored.has(s.replace(/^\.\//, '')))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the vendored library
// ---------------------------------------------------------------------------

describe('vendoring three', () => {
  it('copies it to the two paths the wall names', () => {
    expect(vendorFiles().map((f) => f.path)).toEqual([THREE_MODULE_PATH, THREE_CORE_PATH]);
  });

  // three's minified module build is 200 KiB and its core is 500 KiB, so a
  // hundred thousand characters is a floor neither can fall under while still
  // being the library. A vendor step that emitted an empty file, or the wrong
  // file, would otherwise satisfy every other assertion here.
  it('copies the bytes on disk rather than an empty placeholder', () => {
    expect(vendorFiles().filter((f) => f.contents.length < 100_000)).toEqual([]);
  });

  // The module three ships imports its core by a bare relative specifier, which
  // only resolves because both files are copied into the SAME directory. A
  // vendor step that put them in two places would 404 the core at runtime and
  // nothing else in this suite would notice.
  it('puts the module and its core in one directory', () => {
    expect(path.dirname(THREE_CORE_PATH)).toBe(path.dirname(THREE_MODULE_PATH));
  });

  // The claim vendor.ts makes in prose about why nothing else has to be copied,
  // read off the bytes instead. Also the only assertion here that would notice
  // the file being handed on as a Buffer rather than as text.
  it('copies a module whose every import is the core it copies beside it', () => {
    const mod = (vendorFiles().find((f) => f.path === THREE_MODULE_PATH)?.contents as string | undefined) ?? '';
    const specifiers = new Set([...mod.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]));
    expect([...specifiers]).toEqual([`./${path.basename(THREE_CORE_PATH)}`]);
  });

  it('reads them from a directory it resolved, not one it composed from the cwd', () => {
    expect(path.isAbsolute(threeBuildDir())).toBe(true);
  });

  it('resolves the build directory as a sibling of the package entry', () => {
    expect(threeBuildDir(() => '/somewhere/node_modules/three/build/three.cjs')).toBe(
      '/somewhere/node_modules/three/build',
    );
  });

  // The other half of "absent is not tolerated": the library missing outright,
  // as opposed to the directory being there without the files in it.
  it('refuses to build when the package cannot be resolved at all', () => {
    expect(() =>
      threeBuildDir(() => {
        throw new Error('MODULE_NOT_FOUND');
      }),
    ).toThrow(/the `three` package is not installed/);
  });

  it('refuses to build when the library is not in the directory it was given', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-vendor-'));
    try {
      expect(() => vendorFiles(empty)).toThrow(/three\.module\.min\.js is missing/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('says a build is what it is refusing, not just that a file is absent', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-vendor-'));
    try {
      expect(() => vendorFiles(empty)).toThrow(/refusing to build/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

/**
 * THE GATE HAS TO DESCRIBE WHAT ACTUALLY HAPPENS AT THAT SIZE.
 *
 * It used to read `(min-width: 880px) and (min-height: 560px)`, and the camera
 * comment above the fit claimed all twelve tabs were in frame at any window the
 * wall mounts at. Measured in a browser at exactly 880x560: about 253px of
 * header and hero sit above the stage, the stylesheet's clamp(420px, 62vh,
 * 640px) resolved to its 420px FLOOR because 62vh is only 347px there, and the
 * stage ended 113px below the fold. The camera is locked with no orbit, dolly
 * or scroll, so the bottom row of four tabs was simply unreachable.
 */
describe('the wall only claims sizes where a complete wall fits', () => {
  it('gates on a height that leaves room for the stage, not on the old 560', () => {
    expect(WALL_JS).toContain('(min-width: 880px) and (min-height: 600px)');
    expect(WALL_JS).not.toContain('min-height: 560px');
  });

  it('sizes the stage from the space left below its own top, which CSS cannot know', () => {
    expect(WALL_JS).toContain('getBoundingClientRect().top');
    expect(WALL_JS).toContain('window.innerHeight - documentTop');
  });

  /**
   * Measured from the DOCUMENT, not the viewport. Scrolled 5,000px down,
   * getBoundingClientRect().top is about -5,000, the available height came out
   * enormous, and any resize while scrolled snapped the stage to its maximum
   * whatever the window was doing.
   */
  it('adds the scroll offset back, so resizing while scrolled is not measured from nowhere', () => {
    expect(WALL_JS).toContain('const documentTop = stage.getBoundingClientRect().top + scrollY;');
  });

  it('unmounts rather than cropping when that space is too small', () => {
    // fit() returns false on a zero size, and its caller unmounts, so the list
    // stands. A truncated wall is strictly worse than the list it is drawn over.
    expect(WALL_JS).toContain('if (sizeStage() === 0) return false;');
  });

  it('caps the stage so a tall window does not stretch it without limit', () => {
    expect(WALL_JS).toContain('Math.min(STAGE_MAX, available)');
  });
});

describe('the stylesheet no longer sets a floor the viewport cannot honour', () => {
  it('does not clamp the mounted stage to a 420px minimum', () => {
    expect(STYLESHEET).not.toContain('clamp(420px, 62vh, 640px)');
  });
});

/**
 * THE WIRE IN THREE DIMENSIONS.
 *
 * The stream's conductor was CSS gradients arranged to imply depth. This is
 * real geometry in the scene the wall already loads, so it costs no extra
 * download: three.js is vendored and imported once. An earlier commit justified
 * NOT building this on a 700 KB figure that was simply wrong.
 */
describe('the 3D wire shares the wall’s three.js rather than fetching its own', () => {
  it('adds no second import of the library', () => {
    const imports = [...WALL_JS.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    expect(imports).toEqual(['./vendor/three.module.min.js']);
  });

  it('mounts the wire from the module the wall already resolved', () => {
    expect(WALL_JS).toContain('mountWire(parts[0])');
  });

  it('fetches nothing from another origin', () => {
    expect(WALL_JS).not.toContain('://');
  });
});

describe('the conductor is measured in pixels, not implied', () => {
  /**
   * A capsule's total height is its length PLUS two radii, so scaling one by a
   * pixel length gives 6.2x that at radius 2.6. The first build did exactly
   * that and every conductor overshot its wire by 300px at each end, drawing
   * through the lab filter above the stream. A cylinder of height 1 scales
   * exactly.
   */
  it('uses a unit-height cylinder so a pixel length scales one to one', () => {
    expect(WALL_JS).toContain('CylinderGeometry(2.6, 2.6, 1');
    expect(WALL_JS).not.toContain('CapsuleGeometry');
  });

  it('uses an orthographic camera, so a stud lands on its capture by construction', () => {
    expect(WALL_JS).toContain('OrthographicCamera');
  });

  /** 27,000px of document would exceed texture limits as one tall canvas. */
  it('pins a viewport-sized canvas and moves the scene by the scroll offset', () => {
    expect(WALL_JS).toContain('window.innerHeight');
    expect(WALL_JS).toContain('window.scrollY');
  });

  it('puts the CSS conductor back if the context is lost', () => {
    expect(WALL_JS).toContain('webglcontextlost');
    expect(WALL_JS).toContain("classList.remove('wire-3d-on')");
  });

  it('stands the CSS conductor down only after a frame is on screen', () => {
    const relayout = WALL_JS.indexOf('relayout();\n  /* Only after a frame');
    const addClass = WALL_JS.indexOf("classList.add('wire-3d-on')");
    expect(relayout).toBeGreaterThan(-1);
    expect(addClass).toBeGreaterThan(relayout);
  });
});

describe('the wire canvas sits behind the page', () => {
  it('is painted under the content, so it cannot occlude text', () => {
    expect(STYLESHEET).toContain('z-index: -1;');
  });

  it('takes no pointer events, because it is an object and not a control', () => {
    expect(STYLESHEET).toContain('pointer-events: none;');
  });

  it('hides the CSS conductor and studs only under the mounted class', () => {
    expect(STYLESHEET).toContain('.wire-3d-on .wire::before');
    expect(STYLESHEET).toContain('.wire-3d-on .capture::before');
  });
});
