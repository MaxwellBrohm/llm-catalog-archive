/**
 * The publication: the front page, the micro-category pages, the lab pages, the
 * about page and the everything feed.
 *
 * Pure over a FeedItem list and a ThreadSet, so every guard is asserted from a
 * literal rather than from a fixture repository.
 */

import { describe, it, expect } from 'vitest';
import {
  ABOUT_PATH,
  CHANGELOG_INDEX_PATH,
  EVERYTHING_FEED_PATH,
  EVERYTHING_LIMIT,
  labPagePath,
  renderAboutPage,
  renderEverythingFeed,
  feedItemAnchor,
  changeMagnitude,
  capPerCommit,
  PER_COMMIT_LIMIT,
  headlines,
  capturesOf,
  tapeDelta,
  claimHtml,
  renderEverythingPage,
  renderLabPage,
  renderTypePage,
  typePagePath,
  TYPE_LABEL,
} from '../src/site/render.js';
import { buildSite, textContents } from '../src/site/build.js';
import { buildThreads } from '../src/derive/threads.js';
import { ALL_TYPES, buildFeed, type FeedItem } from '../src/derive/feed.js';
import type { DerivedEvent } from '../src/derive/events.js';
import type { LeakItem } from '../src/derive/leaks.js';
import type { Entity } from '../src/derive/entities.js';
import type { Stamp } from '../src/site/record.js';

const SHA = 'a69a068319de9dc9a7ab1049b411a562a026e7d5';
const stamp = (iso: string): Stamp => ({ iso, kind: 'origin' });

const MODEL: Entity = {
  kind: 'model',
  id: 'model/openrouter:anthropic/claude-opus-5',
  label: 'anthropic/claude-opus-5',
};
const LAB: Entity = { kind: 'lab', id: 'lab/anthropic', label: 'anthropic' };

function event(over: Partial<DerivedEvent> = {}): DerivedEvent {
  return {
    id: `${SHA}:model_added:anthropic/claude-opus-5`,
    type: 'model_added',
    sha: SHA,
    sourceId: 'openrouter-models',
    path: 'raw/openrouter-models/response.json',
    stamp: stamp('2026-08-28T08:00:00.000Z'),
    entities: [MODEL, LAB],
    held: false,
    modelId: 'anthropic/claude-opus-5',
    created: 1787752741,
    precisionSeconds: 4500,
    ...over,
  } as DerivedEvent;
}

function leak(over: Partial<LeakItem> = {}): LeakItem {
  return {
    id: `${SHA}:codename_entered:cold_brew`,
    type: 'codename_entered',
    tier: 'confirmed-artifact',
    sha: SHA,
    sourceId: 'arena-leaderboard',
    path: 'raw/arena-leaderboard/response.html',
    stamp: stamp('2026-08-26T09:00:00.000Z'),
    subject: 'cold_brew',
    facts: [['publicName', 'cold_brew']],
    ...over,
  } as LeakItem;
}

const FEED = buildFeed([event()], [leak()]);
const THREADS = buildThreads(FEED);

/**
 * A page as a reader with scripting off receives it: every script ELEMENT gone,
 * contents and all. Deleting only the tags would leave the front door's JSON
 * island sitting in the text, which is exactly the content that is not supposed
 * to count towards the page being readable.
 */
function withoutScripts(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
}

// ---------------------------------------------------------------------------
// the front page
// ---------------------------------------------------------------------------

describe('renderEverythingPage', () => {
  it('prints the sentence of an event alongside the sentence of a leak item', () => {
    const html = renderEverythingPage(FEED, THREADS);
    expect(html).toContain('The catalog id &quot;anthropic/claude-opus-5&quot; entered OpenRouter&#39;s catalog.');
  });

  it('prints the leak item on the same page', () => {
    expect(renderEverythingPage(FEED, THREADS)).toContain(
      'A model named &quot;cold_brew&quot; appears in arena.ai&#39;s leaderboard payload.',
    );
  });

  it('files each item under the UTC day of the timestamp it shows', () => {
    expect(renderEverythingPage(FEED, THREADS)).toContain('<h2 class="day-mark"><span>2026-08-28</span></h2>');
  });

  it('gives an older day its own heading', () => {
    expect(renderEverythingPage(FEED, THREADS)).toContain('<h2 class="day-mark"><span>2026-08-26</span></h2>');
  });

  it('puts the newer day above the older one', () => {
    const html = renderEverythingPage(FEED, THREADS);
    expect(html.indexOf('2026-08-28')).toBeLessThan(html.indexOf('2026-08-26'));
  });

  it('files an item with no timestamp under its own heading rather than a wrong day', () => {
    const feed = buildFeed([event({ stamp: null })], []);
    expect(renderEverythingPage(feed)).toContain('<h2 class="day-mark"><span>no timestamp recorded</span></h2>');
  });

  it('counts the items it derived from', () => {
    expect(renderEverythingPage(FEED, THREADS)).toContain('2 items derived by replay');
  });

  it('links each item to its micro-category page', () => {
    expect(renderEverythingPage(FEED, THREADS)).toContain('href="type/model-added.html"');
  });

  it('links each item to the entity thread it attaches to', () => {
    expect(renderEverythingPage(FEED, THREADS)).toContain(
      'href="threads/model-openrouter-anthropic-claude-opus-5.html"',
    );
  });

  it('links each item to the raw artifact at its own commit', () => {
    expect(renderEverythingPage(FEED, THREADS)).toContain(
      `https://github.com/MaxwellBrohm/llm-catalog-archive/blob/${SHA}/raw/openrouter-models/response.json`,
    );
  });

  it('links no artifact at HEAD', () => {
    expect(renderEverythingPage(FEED, THREADS)).not.toContain('/blob/HEAD/');
  });

  it('links no artifact at a branch name', () => {
    expect(renderEverythingPage(FEED, THREADS)).not.toContain('/blob/main/');
  });

  it('labels a leak item with its sourcing tier', () => {
    expect(renderEverythingPage(FEED, THREADS)).toContain('badge-tier badge-confirmed-artifact');
  });

  // An event carries no tier, so stamping one on it would be inventing a grade
  // the derivation never assigned.
  it('labels an event with no sourcing tier at all', () => {
    expect(renderEverythingPage(buildFeed([event()], []))).not.toContain('badge-tier');
  });

  it('says so on the card when an item attached to no entity', () => {
    expect(renderEverythingPage(buildFeed([event({ entities: [] })], []))).toContain(
      'held: no entity was mechanically extractable',
    );
  });

  /**
   * This used to read `not.toContain('<script')`, and the front door made that
   * form of the check wrong without making the property it stood for wrong.
   * The property is "nothing a reader needs is inside a script element", and
   * the index now carries two: the JSON island the 3D layer reads, and the
   * module tag that loads it. Neither holds a sentence or a link that is not
   * already in the DOM beside it.
   *
   * So it is asserted by deleting every script element, contents and all, and
   * reading what is left. That is the stronger of the two statements: a page
   * could always have passed the old one while burying its content somewhere
   * else, and this one fails the moment a sentence moves into the canvas.
   * test/site-wall.test.ts carries the link and word floors over the same
   * deletion; these two are the claims this page's own fixture can make.
   */
  it('still names the archived claim when every script element is deleted', () => {
    expect(withoutScripts(renderEverythingPage(FEED, THREADS))).toContain(
      'A model named &quot;cold_brew&quot; appears in arena.ai&#39;s leaderboard payload.',
    );
  });

  it('still links every thread when every script element is deleted', () => {
    const bare = withoutScripts(renderEverythingPage(FEED, THREADS));
    expect(THREADS.threads.filter((t) => !bare.includes(`href="threads/${t.slug}.html"`))).toEqual([]);
  });

  it('escapes a hostile catalog id rather than rendering it as markup', () => {
    const feed = buildFeed([event({ modelId: '"><script>x</script>', entities: [] })], []);
    expect(renderEverythingPage(feed)).not.toContain('<script>x</script>');
  });
});

/**
 * QUIET DAYS ARE THE POINT, and the rail is what makes one readable. It is on
 * the page unconditionally rather than appearing when the feed is thin: a rail
 * that showed up only on a quiet day would be a rail that announces one.
 */
describe('the front page on a quiet archive', () => {
  it('says nothing is derivable rather than rendering an empty stream', () => {
    expect(renderEverythingPage([], THREADS)).toContain('Nothing is derivable yet');
  });

  it('still carries the live threads on a front page with no items at all', () => {
    expect(renderEverythingPage([], THREADS)).toContain('Live threads');
  });

  it('still lists a thread by name on a front page with no items at all', () => {
    expect(renderEverythingPage([], THREADS)).toContain('anthropic/claude-opus-5');
  });

  it('carries the rail on a busy front page too', () => {
    expect(renderEverythingPage(FEED, THREADS)).toContain('Live threads');
  });

  it('says so when there is no thread either, rather than printing an empty list', () => {
    expect(renderEverythingPage([], { threads: [], held: [] })).toContain('No thread exists yet');
  });

  it('points at the changelog, which lists commits nothing knows how to read', () => {
    expect(renderEverythingPage([], THREADS)).toContain(CHANGELOG_INDEX_PATH);
  });
});

/**
 * The cap is only honest if the page says so and if nothing is reachable ONLY
 * through the page that was capped.
 */
describe('the front page cap', () => {
  const many = buildFeed(
    Array.from({ length: 5 }, (_, i) => event({ id: `e${i}`, stamp: stamp(`2026-08-2${i}T00:00:00.000Z`) })),
    [],
  );

  it('stops at the limit it was given', () => {
    // These are model_added events, so on the new stream they are dispatches.
    expect(renderEverythingPage(many, THREADS, 2).match(/class="dispatch-claim"/g)).toHaveLength(2);
  });

  /**
   * The wording lost "most recent" when the page gained a per-capture cap: the
   * items shown are no longer simply the newest N, because surplus from one
   * busy commit is set aside so a single capture cannot fill the page. Claiming
   * "the 2 most recent" would then be false.
   */
  it('says how many it is showing and how many there are', () => {
    expect(renderEverythingPage(many, THREADS, 2)).toContain('Showing 2 items of 5');
  });

  it('says nothing is dropped and names where the rest is', () => {
    expect(renderEverythingPage(many, THREADS, 2)).toContain('Nothing is dropped');
  });

  it('prints no cap note when everything fits', () => {
    expect(renderEverythingPage(many, THREADS, 50)).not.toContain('Showing the');
  });

  it('defaults to a limit of 150', () => {
    expect(EVERYTHING_LIMIT).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// micro-categories
// ---------------------------------------------------------------------------

describe('renderTypePage', () => {
  it('carries the items of the type it is for', () => {
    expect(renderTypePage('model_added', FEED)).toContain('entered OpenRouter&#39;s catalog.');
  });

  it('carries no item of another type', () => {
    expect(renderTypePage('model_added', FEED)).not.toContain('appears in arena.ai');
  });

  it('counts the items of its own type rather than the whole feed', () => {
    expect(renderTypePage('model_added', FEED)).toContain('1 item in the archive');
  });

  it('titles itself with the category label rather than the discriminant', () => {
    expect(renderTypePage('model_added', FEED)).toContain('<h1>A model id entered the catalog</h1>');
  });

  it('still prints the discriminant, which is what the item carries', () => {
    expect(renderTypePage('model_added', FEED)).toContain('model_added');
  });

  // A category page that vanished when it was empty would make a quiet week and
  // a broken extractor render as the same missing link.
  it('says so in words when the archive holds none of its type', () => {
    expect(renderTypePage('price_changed', FEED)).toContain('No item of this kind is derivable');
  });

  it('marks its own chip as the current one', () => {
    expect(renderTypePage('model_added', FEED)).toContain('chip chip-on');
  });

  it('links every other category from every category page', () => {
    const html = renderTypePage('model_added', FEED);
    expect(ALL_TYPES.filter((t) => !html.includes(typePagePath(t)))).toEqual([]);
  });

  it('has a label for every type the publication emits a page for', () => {
    expect(ALL_TYPES.filter((t) => TYPE_LABEL[t] === undefined)).toEqual([]);
  });

  // The subject of a heading a reader sees before any evidence at all.
  it('names an artifact rather than a company in every category label', () => {
    const companies = ['OpenAI', 'Anthropic', 'Google', 'Moonshot', 'DeepSeek'];
    const offenders = ALL_TYPES.filter((t) => companies.some((c) => TYPE_LABEL[t].includes(c)));
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// labs
// ---------------------------------------------------------------------------

describe('renderLabPage', () => {
  it('carries an item whose vendor prefix maps to the lab', () => {
    expect(renderLabPage('anthropic', FEED)).toContain('entered OpenRouter&#39;s catalog.');
  });

  it('carries no item that attaches to no lab', () => {
    expect(renderLabPage('anthropic', FEED)).not.toContain('appears in arena.ai');
  });

  it('counts only the items of that lab', () => {
    expect(renderLabPage('anthropic', FEED)).toContain('1 item whose catalogue id');
  });

  it('links across to the same entity in the entity model', () => {
    expect(renderLabPage('anthropic', FEED)).toContain('href="../threads/lab-anthropic.html"');
  });

  it('marks its own chip as the current one', () => {
    expect(renderLabPage('anthropic', FEED)).toContain('chip chip-on');
  });

  it('says the mapping is a written table rather than an inference', () => {
    expect(renderLabPage('anthropic', FEED)).toContain('never inferred');
  });

  it('says so when a feed carries no lab at all rather than printing an empty chip row', () => {
    expect(renderLabPage('anthropic', buildFeed([], [leak()]))).toContain('nothing to filter by');
  });
});

// ---------------------------------------------------------------------------
// the file set the publication adds
// ---------------------------------------------------------------------------

describe('buildSite emits the publication', () => {
  const files = buildSite([], undefined, THREADS, [], [], FEED);
  const paths = files.map((f) => f.path);
  const at = (p: string): string => {
    const hit = files.find((f) => f.path === p);
    if (hit === undefined) throw new Error(`no file at ${p}`);
    return textContents(hit);
  };

  it('makes the front page the everything stream rather than the changelog', () => {
    expect(at('index.html')).toContain('<h1>Everything</h1>');
  });

  it('keeps the changelog, one directory down', () => {
    expect(at(CHANGELOG_INDEX_PATH)).toContain('<h1>The narrated diff</h1>');
  });

  it('emits one page per micro-category, empty ones included', () => {
    expect(ALL_TYPES.filter((t) => !paths.includes(typePagePath(t)))).toEqual([]);
  });

  it('emits a page for a lab the feed carries', () => {
    expect(paths).toContain(labPagePath('anthropic'));
  });

  // An empty lab page is a claim to be watching a lab we hold nothing on.
  it('emits no page for a lab the feed carries nothing of', () => {
    expect(paths).not.toContain(labPagePath('groq'));
  });

  it('emits the about page', () => {
    expect(paths).toContain(ABOUT_PATH);
  });

  it('emits the everything feed', () => {
    expect(paths).toContain(EVERYTHING_FEED_PATH);
  });

  it('mirrors the new front page at its legacy address', () => {
    expect(paths).toContain('site/index.html');
  });

  it('mirrors a micro-category page at its legacy address', () => {
    expect(paths).toContain('site/type/model-added.html');
  });

  // A meta refresh inside an RSS document is malformed RSS, not a redirect.
  it('mirrors no feed at a legacy address', () => {
    expect(paths).not.toContain(`site/${EVERYTHING_FEED_PATH}`);
  });
});

// ---------------------------------------------------------------------------
// the everything feed
// ---------------------------------------------------------------------------

describe('renderEverythingFeed', () => {
  it('titles each item with the sentence the derivation wrote', () => {
    expect(renderEverythingFeed(FEED)).toContain(
      '<title>The catalog id &quot;anthropic/claude-opus-5&quot; entered OpenRouter&#39;s catalog.</title>',
    );
  });

  /**
   * THE DEFECT THIS REPLACED. Every item used to link to
   * `changes/<sha>.html#<sourceId>`, which is one address per commit-and-source
   * rather than per story. On the live feed that was 50 items sharing 3 links,
   * so a subscriber clicking a headline landed on a page of truncated JSON that
   * did not contain the sentence they clicked. The previous version of this
   * test asserted that address, and the comment above it acknowledged that two
   * claims share a link, which is the defect written down as an intention.
   */
  it('gives every item its own link, not one link per commit', () => {
    const xml = renderEverythingFeed(FEED);
    const links = [...xml.matchAll(/<item>[\s\S]*?<link>([^<]+)<\/link>/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(1);
    expect(new Set(links).size).toBe(links.length);
  });

  it('links each item to its micro-category page, anchored at the item', () => {
    expect(renderEverythingFeed(FEED)).toContain(
      '<link>https://maxwellbrohm.github.io/llm-catalog-archive/type/model-added.html#item-',
    );
  });

  it('marks the guid as a permalink, because it now is one', () => {
    const xml = renderEverythingFeed(FEED);
    expect(xml).toContain('<guid isPermaLink="true">');
    expect(xml).not.toContain('isPermaLink="false"');
  });

  it('categorises each item by its micro-category', () => {
    expect(renderEverythingFeed(FEED)).toContain('<category>model_added</category>');
  });

  it('uses a caller-supplied base instead of the default when one is given', () => {
    expect(renderEverythingFeed(FEED, 'https://example.test/archive')).toContain(
      '<atom:link href="https://example.test/archive/everything.xml"',
    );
  });

  it('carries the raw artifact permalink in the description', () => {
    expect(renderEverythingFeed(FEED)).toContain(`/blob/${SHA}/raw/openrouter-models/response.json`);
  });

  it('emits a well-formed channel for an empty archive', () => {
    expect(renderEverythingFeed([])).toContain('</channel>');
  });

  it('leaves feed.xml alone: the changelog feed is still one item per change', () => {
    const files = buildSite([], undefined, THREADS, [], [], FEED);
    const changelogFeed = files.find((f) => f.path === 'feed.xml')!.contents;
    expect(changelogFeed).toContain('<description>One item per commit that changed a stored artifact under raw/.</description>');
  });
});

// ---------------------------------------------------------------------------
// about
// ---------------------------------------------------------------------------

/**
 * The exposure statement, asserted rather than trusted to survive an edit.
 *
 * Two of the collected sources are GitHub pull-request searches, and a search
 * payload carries each pull request's description text and its author's login,
 * id, avatar URL and profile URL. Those are named private individuals, they are
 * recommitted daily, and R7 forbids rewriting the history that holds them, so
 * an erasure request cannot be satisfied by construction. That is a real cost
 * and the honest half of a tradeoff whose other half has not been paid, so the
 * page has to say it in words a reader will find.
 */
describe('renderAboutPage states what the archive stores', () => {
  it('names the two sources that mirror user-generated content', () => {
    const html = renderAboutPage();
    expect(html.includes('transformers-pulls') && html.includes('vllm-pulls')).toBe(true);
  });

  it('says the payload carries the author identity fields', () => {
    expect(renderAboutPage()).toContain('avatar URL and profile URL');
  });

  it('says an erasure request cannot be satisfied', () => {
    expect(renderAboutPage()).toContain('cannot be satisfied');
  });

  it('says the pull-request description and author fields are never rendered', () => {
    expect(renderAboutPage()).toContain('stored but never rendered');
  });

  /**
   * The disclosure used to name transformers-pulls and vllm-pulls, whose author
   * fields never reach a page, and NOT modelsdev-commits, whose author emails
   * did. Naming the wrong source is the exact failure a disclosure prevents, so
   * the page must name this one.
   */
  it('names modelsdev-commits, the source whose personal data actually reached a page', () => {
    expect(renderAboutPage()).toContain('modelsdev-commits');
  });

  it('says every address in a displayed diff is masked, with no exception', () => {
    const html = renderAboutPage();
    expect(html).toContain('masked');
    expect(html).toContain('no exception for role or noreply addresses');
  });

  it('says masking is a property of the publication and not of the archive', () => {
    expect(renderAboutPage()).toContain('The stored bytes still contain the addresses');
  });

  it('says no language model writes anything in the generator', () => {
    expect(renderAboutPage()).toContain('There is no language model anywhere in the generator');
  });

  it('gives the worked example of why a company is never the subject', () => {
    expect(renderAboutPage()).toContain('1048576 to 262144');
  });

  it('needs no client JavaScript to read', () => {
    expect(renderAboutPage()).not.toContain('<script');
  });
});

// ---------------------------------------------------------------------------
// the navigation, which is what makes it one publication
// ---------------------------------------------------------------------------

describe('every section is reachable from every page', () => {
  const pages = [
    renderEverythingPage(FEED, THREADS),
    renderTypePage('model_added', FEED),
    renderLabPage('anthropic', FEED),
    renderAboutPage(),
  ];

  it('links Everything from every page', () => {
    expect(pages.filter((p) => !p.includes('>Everything</a>'))).toEqual([]);
  });

  it('links the leaks desk from every page', () => {
    expect(pages.filter((p) => !p.includes('>Rumors and leaks</a>'))).toEqual([]);
  });

  it('links the changelog from every page', () => {
    expect(pages.filter((p) => !p.includes('>Changelog</a>'))).toEqual([]);
  });

  it('links the threads index from every page', () => {
    expect(pages.filter((p) => !p.includes('>Threads</a>'))).toEqual([]);
  });

  it('marks exactly one section as current on each page', () => {
    expect(pages.map((p) => (p.match(/aria-current="page"/g) ?? []).length)).toEqual([1, 1, 1, 1]);
  });

  it('marks Everything as current on the front page', () => {
    expect(renderEverythingPage(FEED, THREADS)).toContain('<a class="on" aria-current="page" href="index.html">');
  });

  it('marks About as current on the about page', () => {
    expect(renderAboutPage()).toContain('<a class="on" aria-current="page" href="about.html">');
  });
});

// ---------------------------------------------------------------------------
// the card, the chips and the rail, at the resolution mutation testing needs
// ---------------------------------------------------------------------------

/**
 * These assert the SHAPE of what the card and the chip rows emit rather than
 * that a substring is somewhere on the page.
 *
 * The distinction is not pedantry. "The front page contains a threads/ link"
 * passed with the entity chips removed entirely, because the live-thread rail
 * links threads too, and mutation testing is what surfaced it: the assertion
 * was true of the page and false of the thing it was supposed to be about. So
 * the card assertions below run over a page with no rail on it.
 */
describe('the item card', () => {
  it('links the entity chip at the thread the entity resolves to', () => {
    expect(renderTypePage('model_added', FEED)).toContain(
      '<a class="chip" href="../threads/model-openrouter-anthropic-claude-opus-5.html">' +
        '<span class="chip-kind">model</span><code>anthropic/claude-opus-5</code></a>',
    );
  });

  it('emits one chip per entity the item carries', () => {
    expect(renderTypePage('model_added', FEED).match(/<a class="chip" href="\.\.\/threads\//g)).toHaveLength(2);
  });

  it('emits the held chip instead, and only it, when the item carries no entity', () => {
    const held = renderTypePage('model_added', buildFeed([event({ entities: [] })], []));
    expect(held).not.toContain('<a class="chip" href="../threads/');
  });

  it('prints an event card with the fact rows its own type carries', () => {
    expect(renderTypePage('model_added', FEED)).toContain('<th>catalog created</th>');
  });

  it('prints a leak card with the fact rows the desk recorded, marked as archive values', () => {
    expect(renderTypePage('codename_entered', FEED)).toContain(
      '<tr><th>publicName</th><td class="quoted">cold_brew</td></tr>',
    );
  });

  it('prints no event fact rows on a leak card', () => {
    expect(renderTypePage('codename_entered', FEED)).not.toContain('catalog created');
  });
});

describe('the day buckets on the front page', () => {
  const sameDay = buildFeed(
    [
      event({ id: 'first', stamp: stamp('2026-08-28T08:00:00.000Z') }),
      event({ id: 'second', modelId: 'openai/gpt-5', stamp: stamp('2026-08-28T09:00:00.000Z') }),
    ],
    [],
  );

  it('gives two items of one day a single heading', () => {
    expect(renderEverythingPage(sameDay).match(/<span>2026-08-28<\/span>/g)).toHaveLength(1);
  });

  // A bucket that was replaced rather than appended to would print only the
  // last item of every day, which reads as a quiet day rather than as a bug.
  it('keeps both items of that day on the page', () => {
    const html = renderEverythingPage(sameDay);
    expect([html.includes('&quot;anthropic/claude-opus-5&quot;'), html.includes('&quot;openai/gpt-5&quot;')]).toEqual([
      true,
      true,
    ]);
  });
});

describe('the micro-category chips', () => {
  // On the category pages, where the chips are: the front page carries the
  // categories as a rail list instead, asserted in the block below.
  it('prints the count of each category beside its key', () => {
    expect(renderTypePage('model_added', FEED)).toContain(
      '<span class="chip-kind">model_added</span>1</a>',
    );
  });

  it('prints zero for a category the archive holds none of', () => {
    expect(renderTypePage('model_added', FEED)).toContain(
      '<span class="chip-kind">price_changed</span>0</a>',
    );
  });

  it('prints the count of each lab beside its key on the front page', () => {
    expect(renderEverythingPage(FEED, THREADS)).toContain(
      '<span class="chip-kind">anthropic</span>1</a>',
    );
  });

  it('marks a category the archive holds none of as empty', () => {
    expect(renderTypePage('model_added', FEED)).toContain('class="chip chip-empty" href="../type/price-changed.html"');
  });

  it('marks a category the archive holds items of as not empty', () => {
    expect(renderTypePage('price_changed', FEED)).toContain('class="chip" href="../type/model-added.html"');
  });

  it('marks no chip as current on the front page, which filters nothing', () => {
    expect(renderEverythingPage(FEED, THREADS)).not.toContain('chip-on');
  });

  it('marks exactly one chip as current on a category page', () => {
    expect(renderTypePage('model_added', FEED).match(/chip-on/g)).toHaveLength(1);
  });

  it('marks exactly one chip as current on a lab page', () => {
    expect(renderLabPage('anthropic', FEED).match(/chip-on/g)).toHaveLength(1);
  });
});

describe('the micro-category rail on the front page', () => {
  it('prints the count of each category beside its link', () => {
    expect(renderEverythingPage(FEED, THREADS)).toContain(
      '<a href="type/model-added.html">model_added</a><span class="rail-n">1</span>',
    );
  });

  it('marks an empty category as off rather than dropping its row', () => {
    expect(renderEverythingPage(FEED, THREADS)).toContain('<li class="off"><a href="type/price-changed.html">');
  });

  it('does not mark a category with items as off', () => {
    expect(renderEverythingPage(FEED, THREADS)).toContain('<li><a href="type/model-added.html">');
  });

  it('lists every category in the rail, empty ones included', () => {
    const html = renderEverythingPage(FEED, THREADS);
    expect(ALL_TYPES.filter((t) => !html.includes(`<a href="${typePagePath(t)}">${t}</a>`))).toEqual([]);
  });
});

describe('the live-thread rail', () => {
  // Ten distinct model entities, so the rail has more threads than it shows.
  const many = buildThreads(
    buildFeed(
      Array.from({ length: 10 }, (_, i) =>
        event({
          id: `e${i}`,
          modelId: `vendor${i}/model`,
          entities: [{ kind: 'model', id: `model/openrouter:vendor${i}/model`, label: `vendor${i}/model` }],
          stamp: stamp(`2026-08-${20 + i}T00:00:00.000Z`),
        }),
      ),
      [],
    ),
  );

  it('shows eight threads, not all of them', () => {
    const rail = renderEverythingPage([], many).split('<ul class="rail">')[1]!.split('</ul>')[0]!;
    expect(rail.match(/<li>/g)).toHaveLength(8);
  });

  it('counts every thread in words even while showing eight', () => {
    expect(renderEverythingPage([], many)).toContain('10 threads in all');
  });

  it('shows the most recently active thread first', () => {
    const rail = renderEverythingPage([], many).split('<ul class="rail">')[1]!;
    expect(rail.indexOf('vendor9/model')).toBeLessThan(rail.indexOf('vendor8/model'));
  });
});

describe('the everything feed at item resolution', () => {
  it('stops at fifty items', () => {
    const many = buildFeed(
      Array.from({ length: 60 }, (_, i) => event({ id: `e${String(i).padStart(3, '0')}` })),
      [],
    );
    expect(renderEverythingFeed(many).match(/<item>/g)).toHaveLength(50);
  });

  it('names the sourcing tier in the description of a leak item', () => {
    expect(renderEverythingFeed(buildFeed([], [leak()]))).toContain('Sourcing tier confirmed-artifact.');
  });

  it('names no sourcing tier in the description of an event', () => {
    expect(renderEverythingFeed(buildFeed([event()], []))).not.toContain('Sourcing tier');
  });

  it('carries a pubDate for a stamped item', () => {
    expect(renderEverythingFeed(FEED)).toContain('<pubDate>Fri, 28 Aug 2026 08:00:00 GMT</pubDate>');
  });

  it('carries no pubDate for an item with no stamp', () => {
    expect(renderEverythingFeed(buildFeed([event({ stamp: null })], []))).not.toContain('<pubDate>');
  });

  it('says so in the description when an item has no timestamp', () => {
    expect(renderEverythingFeed(buildFeed([event({ stamp: null })], []))).toContain(
      'Timestamp no timestamp recorded.',
    );
  });

  it('names the timestamp kind for a stamped item', () => {
    expect(renderEverythingFeed(FEED)).toContain('Timestamp 28 August 2026 08:00 UTC (origin).');
  });
});

/**
 * The per-type fact rows, asserted BOTH ways round.
 *
 * Each row is a value a reader is invited to check against the linked artifact,
 * so a row printed under the wrong event type is a fact table that does not
 * describe the thing above it. Mutation testing found the gap: assertions that
 * a card contained its own rows all passed with the type guards removed,
 * because nothing asserted that a card did NOT carry another type's rows.
 */
describe('the fact rows under an event card', () => {
  const cardOf = (e: DerivedEvent): string => renderTypePage(e.type, buildFeed([e], []));

  const removed = event({
    id: `${SHA}:model_removed:anthropic/claude-opus-5`,
    type: 'model_removed',
    modelId: 'anthropic/claude-opus-5',
    lastSeen: stamp('2026-08-27T08:00:00.000Z'),
  } as Partial<DerivedEvent>);

  const floor = event({
    id: `${SHA}:retirement_floor:claude-opus-4`,
    type: 'retirement_floor',
    sourceId: 'anthropic-deprecations',
    path: 'raw/anthropic-deprecations/response.md',
    provider: 'anthropic',
    model: 'claude-opus-4',
    floorDate: '2027-06-09',
    floorText: 'Not sooner than June 9, 2027',
    entities: [],
  } as Partial<DerivedEvent>);

  const context = event({
    id: `${SHA}:context_changed:anthropic/claude-opus-5`,
    type: 'context_changed',
    modelId: 'anthropic/claude-opus-5',
    from: 1048576,
    to: 1310720,
    topProviderFrom: 1048576,
    topProviderTo: 262144,
  } as Partial<DerivedEvent>);

  it('gives a model_added card its catalog created row', () => {
    expect(cardOf(event())).toContain('<th>catalog created</th>');
  });

  it('gives a model_added card no top_provider rows', () => {
    expect(cardOf(event())).not.toContain('top_provider.context_length');
  });

  it('gives a model_added card no retirement row', () => {
    expect(cardOf(event())).not.toContain('parsed floor date');
  });

  // The worked case the whole copy rule exists for: the headline number rose a
  // quarter while what the routed provider serves fell three quarters.
  it('gives a context_changed card both top_provider values', () => {
    const html = cardOf(context);
    expect([
      html.includes('<th>top_provider.context_length before</th><td>1048576</td>'),
      html.includes('<th>top_provider.context_length after</th><td>262144</td>'),
    ]).toEqual([true, true]);
  });

  it('gives a context_changed card no catalog created row', () => {
    expect(cardOf(context)).not.toContain('catalog created');
  });

  it('gives a model_removed card the day it was last seen present', () => {
    expect(cardOf(removed)).toContain('<th>last seen present</th><td>27 August 2026 08:00 UTC</td>');
  });

  it('says so rather than inventing a day when a removal has no last-seen stamp', () => {
    expect(cardOf(event({ ...removed, id: 'x', lastSeen: null } as Partial<DerivedEvent>))).toContain(
      '<th>last seen present</th><td>not recorded</td>',
    );
  });

  it('gives a model_removed card no catalog created row', () => {
    expect(cardOf(removed)).not.toContain('catalog created');
  });

  it('gives a retirement_floor card the date the cell parsed to', () => {
    expect(cardOf(floor)).toContain('<th>parsed floor date</th><td>2027-06-09</td>');
  });

  it('says the cell holds no date rather than printing an empty one', () => {
    expect(cardOf(event({ ...floor, id: 'y', floorDate: null } as Partial<DerivedEvent>))).toContain(
      '<th>parsed floor date</th><td>the cell holds no date</td>',
    );
  });

  it('gives a retirement_floor card no top_provider rows', () => {
    expect(cardOf(floor)).not.toContain('top_provider.context_length');
  });

  // price_changed carries its numbers in the sentence, so its card has no fact
  // table at all, and an empty one would render as an empty bordered box.
  it('gives a price_changed card no fact table at all', () => {
    const price = event({
      id: `${SHA}:price_changed:anthropic/claude-opus-5:prompt`,
      type: 'price_changed',
      modelId: 'anthropic/claude-opus-5',
      field: 'prompt',
      from: '0.000015',
      to: '0.00002',
    } as Partial<DerivedEvent>);
    expect(cardOf(price)).not.toContain('<table class="kv">');
  });
});

describe('the card meta line', () => {
  it('abbreviates the commit sha to seven characters', () => {
    expect(renderTypePage('model_added', FEED)).toContain(`>${SHA.slice(0, 7)}</a>`);
  });

  it('prints no full sha in the meta link text', () => {
    expect(renderTypePage('model_added', FEED)).not.toContain(`>${SHA}</a>`);
  });

  it('links the source page from the card', () => {
    expect(renderTypePage('model_added', FEED)).toContain('<a href="../sources/openrouter-models.html">');
  });
});

describe('feedItemAnchor', () => {
  it('folds a subject carrying a slash and a colon into a fragment-safe id', () => {
    const item = { id: 'abc123:model_added:openai/gpt-5.6-luna:batch' } as never;
    const a = feedItemAnchor(item);
    expect(a).toMatch(/^item-[a-z0-9-]+$/);
  });

  it('is different for two items from the same commit and source', () => {
    const a = feedItemAnchor({ id: 'abc:model_added:openai/gpt-5' } as never);
    const b = feedItemAnchor({ id: 'abc:model_added:openai/gpt-4' } as never);
    expect(a).not.toBe(b);
  });

  it('is stable for the same item across calls, so the address does not move', () => {
    const id = { id: 'abc:price_changed:deepseek/deepseek-v4-flash' } as never;
    expect(feedItemAnchor(id)).toBe(feedItemAnchor(id));
  });
});

/**
 * THE HALF THAT MATTERS. A per-item link is worthless if the page it points at
 * has no such anchor, and a mutation removing the id from the rendered item
 * survived every test above: they all read the feed and none read the page.
 * This one follows each link into the built site the way a subscriber does.
 */
describe('every everything-feed link resolves to its own item on a built page', () => {
  const files = buildSite([], undefined, THREADS, [], [], FEED);
  const byPath = new Map(files.map((f) => [f.path, f.contents]));
  const xml = byPath.get('everything.xml') as string;
  const base = 'https://maxwellbrohm.github.io/llm-catalog-archive/';

  const entries = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const body = m[1] as string;
    return {
      url: (/<link>([^<]+)<\/link>/.exec(body) as RegExpExecArray)[1] as string,
      title: (/<title>([\s\S]*?)<\/title>/.exec(body) as RegExpExecArray)[1] as string,
    };
  });

  it('has items to check, so this describe cannot pass by being empty', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('points every link at a page the build actually emitted', () => {
    for (const e of entries) {
      const [p] = e.url.replace(base, '').split('#');
      expect(byPath.has(p as string), `${e.url} points at a page the build did not emit`).toBe(true);
    }
  });

  it('finds the anchor on that page', () => {
    for (const e of entries) {
      const [p, frag] = e.url.replace(base, '').split('#');
      const html = byPath.get(p as string) as string;
      expect(html.includes(`id="${frag}"`), `${p} has no element with id ${frag}`).toBe(true);
    }
  });

  it('finds the item sentence at that anchor, not merely somewhere on the page', () => {
    for (const e of entries) {
      const [p, frag] = e.url.replace(base, '').split('#');
      const html = byPath.get(p as string) as string;
      const at = html.indexOf(`id="${frag}"`);
      const segment = html.slice(at, at + 1500);
      expect(segment.includes(e.title), `${frag} does not carry its own sentence`).toBe(true);
    }
  });
});

/**
 * The changelog is titled "The narrated diff" and its magnitude column read
 * `+1 -1` on every row that mattered, because openrouter-models/response.json
 * is 700KB of minified JSON on one line. The commit that added 30 catalogue ids
 * and the commit that moved a single price were indistinguishable. A line count
 * describes the file's formatting, not the change.
 */
describe('changeMagnitude', () => {
  const item = (sha: string, sourceId: string, type: string) =>
    ({ sha, sourceId, type }) as never;

  it('counts derived events instead of lines', () => {
    expect(
      changeMagnitude('abc', 'openrouter-models', [
        item('abc', 'openrouter-models', 'model_added'),
        item('abc', 'openrouter-models', 'model_added'),
        item('abc', 'openrouter-models', 'price_changed'),
      ]),
    ).toBe('2 entered, 1 repriced');
  });

  it('orders by count so the biggest thing in the commit is read first', () => {
    expect(
      changeMagnitude('abc', 's', [
        item('abc', 's', 'price_changed'),
        item('abc', 's', 'model_added'),
        item('abc', 's', 'model_added'),
        item('abc', 's', 'model_added'),
      ]),
    ).toBe('3 entered, 1 repriced');
  });

  it('ignores events from another commit', () => {
    expect(
      changeMagnitude('abc', 's', [item('def', 's', 'model_added')]),
    ).toBeNull();
  });

  it('ignores events from another source at the same commit', () => {
    expect(
      changeMagnitude('abc', 's', [item('abc', 'other', 'model_added')]),
    ).toBeNull();
  });

  /**
   * A baseline capture emits no events by design, so there is nothing to count.
   * Returning null lets the caller fall back to line counts rather than print a
   * confident "0 changes" about a commit that stored 416 models.
   */
  it('returns null rather than zero when the commit derived nothing', () => {
    expect(changeMagnitude('abc', 's', [])).toBeNull();
  });

  it('falls back to the raw type name for a type with no label', () => {
    expect(changeMagnitude('abc', 's', [item('abc', 's', 'upstream_pr_merged')])).toBe(
      '1 upstream_pr_merged',
    );
  });
});

describe('the About page states the costs it has actually paid', () => {
  it('names the credential incident rather than leaving it to be discovered', () => {
    const html = renderAboutPage();
    expect(html).toContain('credential gate');
    expect(html).toContain('history is not rewritten here');
  });

  it('says the working tree and every built page are clean', () => {
    expect(renderAboutPage()).toContain('are clean');
  });
});

/**
 * ONE CAPTURE MUST NOT OWN THE FRONT PAGE.
 *
 * The stream is chronological, which is right for news, but a single capture of
 * a catalogue carries dozens of changes at one instant, and chronological order
 * puts all of them at the top. Measured on the live front page before this
 * existed: 150 items of which ONE commit contributed 40, opening with six
 * near-identical price rows for two deepseek models. After: 4 from the busiest
 * commit, 26 distinct commits represented, and a model launch in the first five.
 */
describe('capPerCommit', () => {
  const item = (sha: string, sourceId: string, id: string) => ({ sha, sourceId, id }) as never;

  it('keeps everything when no commit exceeds the cap', () => {
    const items = [item('a', 's', '1'), item('b', 's', '2')];
    expect(capPerCommit(items, 4).shown).toHaveLength(2);
  });

  it('keeps only the cap from one busy commit', () => {
    const items = Array.from({ length: 40 }, (_, i) => item('a', 's', String(i)));
    const { shown, heldBack } = capPerCommit(items, 4);
    expect(shown).toHaveLength(4);
    expect([...heldBack.values()][0]).toBe(36);
  });

  it('preserves chronological order among what it keeps', () => {
    const items = [item('a', 's', '1'), item('b', 's', '2'), item('a', 's', '3')];
    expect(capPerCommit(items, 4).shown.map((i) => i.id)).toEqual(['1', '2', '3']);
  });

  it('keeps the FIRST items of a commit, which are the ones chronology put on top', () => {
    const items = Array.from({ length: 6 }, (_, i) => item('a', 's', String(i)));
    expect(capPerCommit(items, 2).shown.map((i) => i.id)).toEqual(['0', '1']);
  });

  /**
   * One commit can change several sources, and those are unrelated stories that
   * merely share a sha. Capping by sha alone would let a busy catalogue capture
   * silence a documentation change committed in the same run.
   */
  it('counts each source within a commit separately', () => {
    const items = [
      ...Array.from({ length: 5 }, (_, i) => item('a', 'catalog', `c${i}`)),
      ...Array.from({ length: 2 }, (_, i) => item('a', 'docs', `d${i}`)),
    ];
    const { shown } = capPerCommit(items, 3);
    expect(shown.filter((i) => i.sourceId === 'catalog')).toHaveLength(3);
    expect(shown.filter((i) => i.sourceId === 'docs')).toHaveLength(2);
  });

  it('gives a busy commit room again on a later commit', () => {
    const items = [
      ...Array.from({ length: 5 }, (_, i) => item('a', 's', `a${i}`)),
      ...Array.from({ length: 5 }, (_, i) => item('b', 's', `b${i}`)),
    ];
    expect(capPerCommit(items, 2).shown).toHaveLength(4);
  });

  it('reports nothing held back when nothing was', () => {
    expect(capPerCommit([item('a', 's', '1')], 4).heldBack.size).toBe(0);
  });
});

describe('the front page after capping', () => {
  /** 20 price changes from one capture, past the per-capture cap, then one
   * launch from the next. 20 rather than 12 because the cap rose when the tape
   * made density cheap. */
  const many: FeedItem[] = [
    ...Array.from({ length: 20 }, (_, i) => ({
      ...(FEED[0] as FeedItem),
      id: `${SHA}:price_changed:m${i}`,
      // Explicitly a non-headline type: the headline strip repeats
      // headline-shaped items above the stream, which would double the count
      // this test measures and make it about the strip rather than the cap.
      type: 'price_changed' as const,
      sentence: `price row ${i}`,
      sha: SHA,
      sourceId: 'openrouter-models',
    })),
    {
      ...(FEED[0] as FeedItem),
      id: 'b'.repeat(40) + ':model_added:x',
      type: 'model_added' as const,
      sentence: 'a launch',
      sha: 'b'.repeat(40),
      sourceId: 'openrouter-models',
    },
  ];

  const html = renderEverythingPage(many, THREADS);

  it('shows at most the per-capture cap from the busy commit', () => {
    expect((html.match(/price row \d+/g) ?? []).length).toBeLessThanOrEqual(PER_COMMIT_LIMIT);
  });

  it('still shows the item from the other commit, which flooding would have buried', () => {
    expect(html).toContain('a launch');
  });

  it('says how many it held back rather than dropping them silently', () => {
    expect(html).toContain('further item');
  });

  it('says where the rest are, because nothing is actually dropped', () => {
    expect(html).toContain('uncapped');
  });
});

/**
 * VOLUME DECIDED WHAT A READER SAW.
 *
 * The stream is chronological and complete, which is right, but on a catalogue
 * archive that means the loudest source wins. Measured on the live front page:
 * 170 of 444 items were price changes and NINE were announcements, incidents or
 * leaks. Two per cent. A visitor met four price rows and left without learning
 * that a provider had an outage or that a model shipped.
 */
describe('headlines', () => {
  const it_ = (type: string, id: string) => ({ type, id, sentence: id, stamp: null }) as never;

  it('picks announcements, incidents, leaks and catalogue arrivals', () => {
    const picked = headlines(
      [it_('price_changed', 'p'), it_('incident_opened', 'i'), it_('post_published', 'a'), it_('model_added', 'm')],
      10,
    );
    expect(picked.map((i) => i.id)).toEqual(['i', 'a', 'm']);
  });

  /** Routine catalogue telemetry stays in the stream and out of the strip. */
  it('excludes price and context movement, which are an activity log', () => {
    const picked = headlines([it_('price_changed', 'p'), it_('context_changed', 'c'), it_('doc_moved', 'd')], 10);
    expect(picked).toEqual([]);
  });

  it('keeps chronological order among what it picks', () => {
    const picked = headlines([it_('model_added', '1'), it_('incident_opened', '2'), it_('model_added', '3')], 10);
    expect(picked.map((i) => i.id)).toEqual(['1', '2', '3']);
  });

  /**
   * A capture that added 30 models must not make the strip a list of 30 models,
   * which would reproduce the flooding one level up.
   */
  it('shows at most three of any one kind', () => {
    const many = Array.from({ length: 30 }, (_, i) => it_('model_added', `m${i}`));
    expect(headlines(many, 10)).toHaveLength(3);
  });

  it('lets other kinds through once one kind is saturated', () => {
    const feed = [
      ...Array.from({ length: 30 }, (_, i) => it_('model_added', `m${i}`)),
      it_('incident_opened', 'outage'),
    ];
    expect(headlines(feed, 10).map((i) => i.id)).toContain('outage');
  });

  it('stops at the limit', () => {
    const feed = [
      ...Array.from({ length: 3 }, (_, i) => it_('model_added', `a${i}`)),
      ...Array.from({ length: 3 }, (_, i) => it_('incident_opened', `b${i}`)),
      ...Array.from({ length: 3 }, (_, i) => it_('post_published', `c${i}`)),
    ];
    expect(headlines(feed, 4)).toHaveLength(4);
  });

  it('returns nothing when the archive holds no headline-shaped item', () => {
    expect(headlines([it_('price_changed', 'p')], 8)).toEqual([]);
  });
});

describe('the front page headline strip', () => {
  it('renders above the chronological stream when there is news', () => {
    const feed: FeedItem[] = [
      { ...(FEED[0] as FeedItem), id: 'x:incident_opened:1', type: 'incident_opened', sentence: 'an outage happened' },
      { ...(FEED[0] as FeedItem), id: 'x:price_changed:1', type: 'price_changed', sentence: 'a price moved' },
    ];
    const html = renderEverythingPage(feed, THREADS);
    expect(html).toContain('What happened');
    // The headline strip carries the incident's sentence; the price change is
    // in the tape below, which shows the fields the sentence is built from
    // rather than the sentence itself.
    expect(html.indexOf('What happened')).toBeLessThan(html.indexOf('class="tape'));
    expect(html.indexOf('an outage happened')).toBeLessThan(html.indexOf('class="tape'));
  });

  /** An empty archive and a quiet week must not render the same. */
  it('renders no strip at all when nothing is headline-shaped', () => {
    const feed: FeedItem[] = [
      { ...(FEED[0] as FeedItem), id: 'x:price_changed:1', type: 'price_changed', sentence: 'a price moved' },
    ];
    expect(renderEverythingPage(feed, THREADS)).not.toContain('What happened');
  });

  it('says the stream below repeats them, so the strip is not read as a cut', () => {
    const feed: FeedItem[] = [
      { ...(FEED[0] as FeedItem), id: 'x:incident_opened:1', type: 'incident_opened', sentence: 'an outage' },
    ];
    expect(renderEverythingPage(feed, THREADS)).toContain('includes these again');
  });
});

/**
 * THE WIRE AND THE TAPE.
 *
 * Below the front door the page was 103 identical cards, and an outage rendered
 * exactly like the two hundredth price tick of the day. The stream is now drawn
 * as captures on a conductor, with telemetry collapsed into a tape and the
 * things a person came to read given display type.
 */
describe('capturesOf', () => {
  const it_ = (sha: string, sourceId: string, id: string) => ({ sha, sourceId, id }) as never;

  it('groups consecutive items sharing a commit and a source', () => {
    const g = capturesOf([it_('a', 's', '1'), it_('a', 's', '2'), it_('b', 's', '3')]);
    expect(g.map((c) => c.items.length)).toEqual([2, 1]);
  });

  /** One commit can change several sources; those are separate captures. */
  it('splits one commit across two sources', () => {
    const g = capturesOf([it_('a', 'catalog', '1'), it_('a', 'docs', '2')]);
    expect(g).toHaveLength(2);
  });

  /**
   * Consecutive, not global. The stream is chronological and regrouping it
   * would reorder the page, so a source that reappears later gets a second node
   * on the wire, which is what actually happened.
   */
  it('gives a source that reappears a second capture rather than merging it', () => {
    const g = capturesOf([it_('a', 's', '1'), it_('b', 't', '2'), it_('a', 's', '3')]);
    expect(g).toHaveLength(3);
  });

  it('returns nothing for an empty stream', () => {
    expect(capturesOf([])).toEqual([]);
  });
});

describe('tapeDelta', () => {
  it('reads a fall', () => {
    expect(tapeDelta('0.00000165', '0.00000095')).toEqual({ dir: '-', pct: '42%' });
  });

  it('reads a rise, including an exact doubling', () => {
    expect(tapeDelta('0.00000066', '0.00000132')).toEqual({ dir: '+', pct: '100%' });
  });

  it('works at the very small magnitudes these prices actually use', () => {
    expect(tapeDelta('0.000000007', '0.000000014')).toEqual({ dir: '+', pct: '100%' });
  });

  it('reports no direction and no percentage when a value is absent', () => {
    expect(tapeDelta(null, '0.001')).toEqual({ dir: '=', pct: null });
    expect(tapeDelta('0.001', null)).toEqual({ dir: '=', pct: null });
  });

  /** A confident 0% would be a claim the numbers do not support. */
  it('refuses a percentage rather than dividing by zero', () => {
    expect(tapeDelta('0', '0.001')).toEqual({ dir: '+', pct: null });
  });

  it('refuses a percentage on an unparseable value', () => {
    expect(tapeDelta('not-a-number', '0.001').pct).toBeNull();
  });

  it('says flat when nothing moved', () => {
    expect(tapeDelta('0.5', '0.5')).toEqual({ dir: '=', pct: null });
  });

  it('rounds away a change too small to show rather than printing 0%', () => {
    expect(tapeDelta('1000', '1000.4').pct).toBeNull();
  });
});

describe('claimHtml', () => {
  it('sets a quoted URL apart without altering the text', () => {
    const out = claimHtml('The x index listed a URL: "https://a.test/b".');
    expect(out).toContain('<span class="url">https://a.test/b</span>');
    // the quotes the deriver put there survive
    expect(out).toContain('&quot;<span class="url">');
  });

  it('escapes before wrapping, so a hostile sentence cannot inject markup', () => {
    const out = claimHtml('a <script>alert(1)</script> b');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('leaves a sentence with no URL exactly as escaping left it', () => {
    expect(claimHtml('The catalog id "a/b" entered.')).toBe('The catalog id &quot;a/b&quot; entered.');
  });
});

/**
 * THE FRONT PAGE'S OWN ARITHMETIC HAS TO ADD UP.
 *
 * The page is capped TWICE: capPerCommit holds items back so that no single
 * capture fills it, and the overall limit then truncates what survives. The
 * note counted only the first, so it read "Showing 150 items of 408, with 192
 * more held back" and 150 + 192 is 342. Sixty-six items were in neither number,
 * on the front page of an archive whose whole claim is that its numbers can be
 * checked against the bytes.
 *
 * Asserted as arithmetic over the rendered numbers rather than as a string
 * match, so it survives any rewording and fails on any third cut added later.
 */
describe('the front page accounts for every item it does not show', () => {
  /*
   * BOTH CUTS HAVE TO BITE, or this measures one of them. 40 captures of 15
   * items: the per-capture cap holds back 3 from each, and the overall limit
   * then truncates what survives.
   */
  const many: FeedItem[] = Array.from({ length: 40 }, (_, c) =>
    Array.from({ length: 15 }, (_, i) => ({
      ...(FEED[0] as FeedItem),
      id: `${c.toString(16).padStart(40, '0')}:price_changed:m${c}-${i}`,
      type: 'price_changed' as const,
      sentence: `row ${c}-${i}`,
      sha: c.toString(16).padStart(40, '0'),
      sourceId: 'openrouter-models',
    })),
  ).flat();

  const numbersFrom = (html: string) => {
    const m = /Showing ([\d,]+) items? of ([\d,]+)([^.]*)\./.exec(html);
    if (m === null) return null;
    const n = (s: string) => Number(s.replace(/,/g, ''));
    const cuts = [...(m[3] as string).matchAll(/([\d,]+) (?:held back|beyond)/g)].map((c) => n(c[1] as string));
    return { shown: n(m[1] as string), total: n(m[2] as string), cuts };
  };

  it('renders the note at all, so this cannot pass by matching nothing', () => {
    expect(numbersFrom(renderEverythingPage(many, THREADS))).not.toBeNull();
  });

  it('shown plus every cut equals the total', () => {
    const got = numbersFrom(renderEverythingPage(many, THREADS));
    const sum = (got as NonNullable<typeof got>).cuts.reduce((a, b) => a + b, (got as NonNullable<typeof got>).shown);
    expect(sum).toBe((got as NonNullable<typeof got>).total);
  });

  it('names both cuts when both bite, not just the per-capture one', () => {
    const html = renderEverythingPage(many, THREADS);
    expect(html).toContain('held back');
    expect(html).toContain('beyond this page');
  });

  /** With nothing held back and nothing truncated there is no note to make. */
  it('says nothing when the whole feed fits', () => {
    const few = many.slice(0, 3);
    expect(renderEverythingPage(few, THREADS)).not.toContain('Showing 3 items of');
  });
});
