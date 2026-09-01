/**
 * The 3D front door: a locked-camera wall of billboarded tabs over the index.
 *
 * Pure. No git, no fs, no clock. It emits two things: the markup and the JSON
 * island that the browser module reads, and the browser module itself as a
 * string, the same way css.ts carries the stylesheet.
 *
 * THE ORDER OF CONSTRUCTION IS THE WHOLE POINT, and it is the opposite of the
 * usual one. The HTML index is built first and is complete on its own; the 3D
 * mounts over it and can be removed at any moment without taking a link with
 * it. Three separate reasons, and none of them is taste:
 *
 *   - the archive is only worth anything if it is linkable and indexable, and
 *     a crawler sees nothing at all inside a WebGL canvas;
 *   - most shared links open on a phone, where this never mounts;
 *   - a WebGL context can be lost at runtime, and when it is, this restores the
 *     text index rather than leaving a black rectangle.
 *
 * So `wallHtml` renders a real <ul> of real <a>s. The browser module hides it
 * only after a canvas is on screen, and un-hides it if the context goes away.
 * With scripting off, that list IS the front door, and it is a legible one.
 *
 * WHAT A TAB IS. One entity thread, which is what this publication calls a
 * story. A tab's link is the thread's own permalinked HTML page, never a
 * fragment, never a query string, never a route the 3D layer invents: the 3D
 * layer knows no addresses of its own.
 *
 * EVERY SENTENCE ON A TAB IS THE ARTIFACT'S, not ours. A tab prints the
 * entity's catalogue-namespaced label, its kind, how many items in the archive
 * attach to it, and the timestamp of the newest one, LABELLED origin or
 * observed exactly as every other surface labels it. Nothing on a tab
 * characterises, ranks by importance, or explains.
 */


import type { ThreadSet } from '../derive/threads.js';
import { escapeHtml, formatUtc, threadPagePath, THREADS_INDEX_PATH, type Stamp } from './record.js';

/**
 * How many tabs the wall carries.
 *
 * TWELVE BECAUSE OF LEGIBILITY, not because of frame rate. A tab has to print a
 * 30-character catalogue id at a size a person can read; on a 1440px hero that
 * is about 320px of tab, which is four columns. Three rows of four is the most
 * the frame holds before the type stops being type and starts being texture. A
 * wall of a hundred unreadable slabs would be a picture of an index rather than
 * an index, and this project does not ship pictures of things.
 *
 * The cap is stated on the page, in the DOM, next to the wall. Every thread
 * that is not on it is one scroll down, uncapped.
 */
export const WALL_TABS = 12;

/** Where the browser module is written. Root, so index.html links it flat. */
export const WALL_JS_PATH = 'wall.js';

/** Where three.js is copied to. The module import below is relative to this. */
export const VENDOR_DIR = 'vendor';
export const THREE_MODULE_PATH = `${VENDOR_DIR}/three.module.min.js`;
export const THREE_CORE_PATH = `${VENDOR_DIR}/three.core.min.js`;

export type WallTab = {
  /** Relative to the site root, which is where index.html sits. */
  href: string;
  /** The entity's catalogue-namespaced label. Never a title we composed. */
  label: string;
  kind: string;
  /** How many feed items attach to this thread. */
  items: number;
  /** The newest item's timestamp, already formatted, or null. */
  when: string | null;
  /** 'origin' or 'observed', so the tab can label it. Null when `when` is. */
  whenKind: string | null;
};

function tabOf(thread: ThreadSet['threads'][number]): WallTab {
  const stamp: Stamp | null = thread.lastActivity;
  return {
    href: threadPagePath(thread.slug),
    label: thread.entity.label,
    kind: thread.entity.kind,
    items: thread.events.length,
    when: stamp === null ? null : formatUtc(stamp.iso),
    whenKind: stamp === null ? null : stamp.kind,
  };
}

/**
 * The tabs, in the order buildThreads already put them: most recently active
 * first. Read off that ordering rather than off a clock, for the same reason
 * the thread rail is: this module has no clock, and "recent" measured against a
 * build time would make one archive render two different ways on two runs.
 */
export function wallTabs(threads: ThreadSet, limit: number = WALL_TABS): WallTab[] {
  return threads.threads.slice(0, limit).map(tabOf);
}

/**
 * JSON safe to drop inside a <script type="application/json"> element.
 *
 * `<` is escaped to `<` rather than the whole string being HTML-escaped,
 * because the contents of a script element are not HTML-parsed: an `&amp;` in
 * there arrives at JSON.parse as the literal five characters. Escaping `<`
 * alone is what makes a `</script>` inside a label impossible while leaving the
 * bytes JSON.parse reads identical to the bytes we meant.
 */
export function jsonIsland(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function tabListItem(tab: WallTab): string {
  const when =
    tab.when === null
      ? '<span class="badge badge-observed">no sidecar</span>'
      : `${escapeHtml(tab.when)} <span class="badge badge-${escapeHtml(tab.whenKind ?? '')}">${escapeHtml(tab.whenKind ?? '')}</span>`;
  return `<li><a href="${escapeHtml(tab.href)}">
<span class="wall-kind">${escapeHtml(tab.kind)}</span>
<code class="wall-label">${escapeHtml(tab.label)}</code>
<span class="wall-meta">${tab.items} item${tab.items === 1 ? '' : 's'} &middot; ${when}</span>
</a></li>`;
}

/**
 * The front door's markup: the list first, the mount point around it.
 *
 * `.wall-stage` is empty and `display:none` until a canvas exists. Nothing here
 * reserves space for a thing that may never arrive, so a reader whose browser
 * refuses WebGL gets no gap where a wall would have been.
 */
export function wallHtml(threads: ThreadSet, total: number, limit: number = WALL_TABS): string {
  const tabs = wallTabs(threads, limit);
  if (tabs.length === 0) return '';
  const rest =
    total > tabs.length
      ? ` The other ${total - tabs.length} are in <a href="${THREADS_INDEX_PATH}">the threads index</a>, uncapped.`
      : '';
  return `<div class="wall" data-wall>
<div class="wall-frame">
<div class="wall-stage" data-wall-stage></div>
<ul class="wall-list" data-wall-list>
${tabs.map(tabListItem).join('\n')}
</ul>
</div>
<p class="note wall-note">The ${tabs.length} most recently active threads, as tabs.${rest} Where this browser can draw it, the same ${tabs.length} tabs are a wall in three dimensions; the list is what they link, and the list is what is here when they are not.</p>
</div>
<script type="application/json" data-wall-tabs>${jsonIsland(tabs)}</script>
<script type="module" src="${WALL_JS_PATH}"></script>`;
}
