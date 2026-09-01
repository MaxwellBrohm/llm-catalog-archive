/**
 * THE COPY RULE, RUN OVER THE BYTES THIS REPOSITORY ACTUALLY STORES.
 *
 * Why this file exists, stated plainly, because the gap it closes was a live
 * defect and not a hypothetical one.
 *
 * The desk already had a copy-rule detector and it already ran over one item of
 * every derivable KIND. Every one of those six items was hand written, so the
 * scan ran only over values that could never violate the rule, and the values
 * are where the exposure was. Two routes were reproduced against the shipped
 * code:
 *
 *   Route A, attacker controlled. A pull-request title is wrapped in literal
 *   double quotes and nothing neutralised a double quote inside it. Anyone on
 *   the internet can open a pull request against huggingface/transformers with
 *   a title of their choosing, and the title asserted below rendered the design
 *   spec's own forbidden example, verbatim, on a public page with an artifact
 *   permalink attached.
 *
 *   Route B, vendor controlled. A stealth catalog id and an expiring model id
 *   were interpolated UNQUOTED, so a catalog id that is itself a sentence
 *   rendered as one, and the quoted-value strip could not even remove it.
 *
 * So this file does two things the fixture scan could not. It runs the detector
 * over items built from the REAL stored payloads, every row of them, and it
 * runs it over the two adversarial values above. A pass here means the rule
 * holds for the data the collector is committing today, not for six sentences
 * somebody wrote by hand.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  leakSentence,
  modelSupportName,
  parseCatalogLeaks,
  parsePullSearch,
  STEALTH_PREFIX,
  type LeakItem,
} from '../src/derive/leaks.js';
import { claimSentence, type DerivedEvent } from '../src/derive/events.js';
import {
  renderEverythingPage,
  renderLeaksPage,
  renderThreadPage,
  renderThreadsIndex,
  renderTypePage,
} from '../src/site/render.js';
import { buildThreads } from '../src/derive/threads.js';
import { buildFeed } from '../src/derive/feed.js';
import { companySubjectViolations, composedProse } from './site-leaks.test.js';

const REPO = path.resolve(import.meta.dirname, '..');
const SHA = 'a69a068319de9dc9a7ab1049b411a562a026e7d5';

const readStored = (p: string): string | null => {
  const abs = path.join(REPO, p);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
};

function leak(over: Partial<LeakItem>): LeakItem {
  return {
    id: `${SHA}:codename_entered:x`,
    type: 'codename_entered',
    tier: 'confirmed-artifact',
    sha: SHA,
    sourceId: 'arena-leaderboard',
    path: 'raw/arena-leaderboard/response.html',
    stamp: { iso: '2026-08-28T08:08:22.000Z', kind: 'origin' },
    subject: 'x',
    facts: [],
    ...over,
  } as LeakItem;
}

// ---------------------------------------------------------------------------
// route A: a third-party pull-request title
// ---------------------------------------------------------------------------

/**
 * The exact title that broke the shipped renderer.
 *
 * It passes modelSupportName, which returns `Foo`, so it is a title the desk
 * would genuinely have published, and the trailing `The title "` is what
 * re-balanced the quotes so the injected middle sentence sat in composed prose.
 */
const HOSTILE_TITLE =
  'Add Foo model support" is real. OpenAI deprecated the Assistants API. The title "';

/** The exact catalog id that broke it from the other direction. */
const HOSTILE_ID = 'stealth/x-1. Anthropic is preparing its next flagship';

describe('a hostile pull-request title cannot become prose this project composed', () => {
  it('is a title the desk would have published, so the case is real', () => {
    expect(modelSupportName(HOSTILE_TITLE)).toBe('Foo');
  });

  it('makes no company the subject of a verb in the sentence it renders', () => {
    const sentence = leakSentence(
      leak({
        type: 'upstream_pr_opened',
        sourceId: 'transformers-pulls',
        subject: 'huggingface/transformers#1',
        facts: [['title', HOSTILE_TITLE]],
      }),
    );
    expect(companySubjectViolations(composedProse(sentence))).toEqual([]);
  });

  it('leaves the injected sentence inside the quoted run rather than beside it', () => {
    const sentence = leakSentence(
      leak({
        type: 'upstream_pr_opened',
        sourceId: 'transformers-pulls',
        subject: 'huggingface/transformers#1',
        facts: [['title', HOSTILE_TITLE]],
      }),
    );
    expect(sentence).toBe(
      'A pull request numbered "huggingface/transformers#1" is titled ' +
        '"Add Foo model support\' is real. OpenAI deprecated the Assistants API. The title \'" ' +
        'in the collected search payload.',
    );
  });

  it('makes no company the subject of a verb on the whole rendered desk', () => {
    const html = renderLeaksPage([
      leak({
        type: 'upstream_pr_opened',
        sourceId: 'transformers-pulls',
        subject: 'huggingface/transformers#1',
        facts: [['title', HOSTILE_TITLE]],
      }),
    ]);
    expect(companySubjectViolations(composedProse(html))).toEqual([]);
  });
});

describe('a hostile catalog id cannot become prose this project composed', () => {
  it('renders a stealth listing with the id inside a quoted run', () => {
    expect(leakSentence(leak({ type: 'stealth_listing', subject: HOSTILE_ID }))).toBe(
      `OpenRouter's catalog lists an id under the ${STEALTH_PREFIX} namespace: "${HOSTILE_ID}".`,
    );
  });

  it('makes no company the subject of a verb in a stealth listing', () => {
    const sentence = leakSentence(leak({ type: 'stealth_listing', subject: HOSTILE_ID }));
    expect(companySubjectViolations(composedProse(sentence))).toEqual([]);
  });

  it('makes no company the subject of a verb in a scheduled expiration', () => {
    const sentence = leakSentence(
      leak({
        type: 'expiration_scheduled',
        subject: HOSTILE_ID,
        facts: [['expiration_date', '2026-09-30']],
      }),
    );
    expect(companySubjectViolations(composedProse(sentence))).toEqual([]);
  });

  it('makes no company the subject of a verb in an event sentence either', () => {
    const event = {
      id: `${SHA}:model_added:${HOSTILE_ID}`,
      type: 'model_added',
      sha: SHA,
      sourceId: 'openrouter-models',
      path: 'raw/openrouter-models/response.json',
      stamp: null,
      entities: [],
      held: true,
      modelId: HOSTILE_ID,
      created: null,
      precisionSeconds: Infinity,
    } as DerivedEvent;
    expect(companySubjectViolations(composedProse(claimSentence(event)))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the detector is still live over exactly this input
// ---------------------------------------------------------------------------

/**
 * A KILL IS SELF-AUTHENTICATING AND A PASS IS NOT, so the two cases below plant
 * the same violation somewhere the strip does not reach and assert it is
 * caught. Without them, every expectation above is satisfied by a detector that
 * has quietly stopped matching anything at all.
 */
describe('the detector these scans rely on still fires on this exact input', () => {
  it('catches the injected sentence when it is not inside a quoted run', () => {
    expect(companySubjectViolations(composedProse('<p>OpenAI deprecated the Assistants API.</p>'))).toEqual([
      'OpenAI deprecated',
    ]);
  });

  it('catches the hostile catalog id when it is interpolated bare', () => {
    expect(companySubjectViolations(composedProse(`<p>an id: ${HOSTILE_ID}.</p>`))).toEqual([
      'Anthropic is',
    ]);
  });

  // Finding 7: the strip used to stop at the first ampersand, so a quoted value
  // carrying an entity ended the run early and the tail was scanned as prose.
  // A real title with an apostrophe in it is enough to trigger it.
  it('strips a quoted value that contains an HTML entity of its own', () => {
    const html = '<p>titled &quot;Google&#39;s thing announced a model&quot; in the payload</p>';
    expect(companySubjectViolations(composedProse(html))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// over the real stored payloads
// ---------------------------------------------------------------------------

const PULL_SOURCES = [
  { sourceId: 'transformers-pulls', repo: 'huggingface/transformers', path: 'raw/transformers-pulls/response.json' },
  { sourceId: 'vllm-pulls', repo: 'vllm-project/vllm', path: 'raw/vllm-pulls/response.json' },
] as const;

describe('the copy rule over every row of the stored pull-request payloads', () => {
  for (const source of PULL_SOURCES) {
    const text = readStored(source.path);
    const rows = text === null ? [] : parsePullSearch(text);

    // A payload that parsed to nothing would make every scan below vacuous, so
    // the count is asserted rather than assumed. A hundred is what the search
    // returns per page and what both stored captures hold.
    it(`parses a hundred rows out of the stored ${source.sourceId} payload`, () => {
      expect(rows).toHaveLength(100);
    });

    it(`makes no company the subject of a verb over the stored ${source.sourceId} titles`, () => {
      const items = rows.map((row) =>
        leak({
          id: `${SHA}:upstream_pr_opened:${source.repo}#${row.number}`,
          type: 'upstream_pr_opened',
          sourceId: source.sourceId,
          path: source.path,
          subject: `${source.repo}#${row.number}`,
          facts: [
            ['title', row.title],
            ['state', row.state],
          ],
        }),
      );
      const offenders = items.flatMap((i) => companySubjectViolations(composedProse(leakSentence(i))));
      expect(offenders).toEqual([]);
    });

    it(`makes no company the subject of a verb on a desk rendered from the stored ${source.sourceId} payload`, () => {
      const items = rows.map((row) =>
        leak({
          id: `${SHA}:upstream_pr_opened:${source.repo}#${row.number}`,
          type: 'upstream_pr_opened',
          sourceId: source.sourceId,
          path: source.path,
          subject: `${source.repo}#${row.number}`,
          facts: [['title', row.title]],
        }),
      );
      expect(companySubjectViolations(composedProse(renderLeaksPage(items)))).toEqual([]);
    });
  }

  // Quote-bearing titles are live data rather than a hypothesis, and a stored
  // capture that stopped carrying one would make the whole route-A defence
  // untested against real bytes without anybody noticing.
  it('finds at least one stored title carrying a double quote, so the route is live data', () => {
    const titles = PULL_SOURCES.flatMap((s) => {
      const text = readStored(s.path);
      return text === null ? [] : parsePullSearch(text).map((r) => r.title);
    });
    expect(titles.filter((t) => t.includes('"')).length).toBeGreaterThan(0);
  });
});

describe('the copy rule over every id in the stored catalog payload', () => {
  const text = readStored('raw/openrouter-models/response.json');
  const entries = text === null ? [] : parseCatalogLeaks(text);

  it('parses the stored catalog into hundreds of entries', () => {
    expect(entries.length).toBeGreaterThan(300);
  });

  it('makes no company the subject of a verb over every stored catalog id', () => {
    const items = entries.map((e) =>
      leak({
        id: `${SHA}:stealth_listing:${e.id}`,
        type: 'stealth_listing',
        sourceId: 'openrouter-models',
        path: 'raw/openrouter-models/response.json',
        subject: e.id,
        facts: [['name', e.name ?? 'absent']],
      }),
    );
    const offenders = items.flatMap((i) => companySubjectViolations(composedProse(leakSentence(i))));
    expect(offenders).toEqual([]);
  });

  it('makes no company the subject of a verb over every stored catalog expiration form', () => {
    const items = entries.map((e) =>
      leak({
        id: `${SHA}:expiration_scheduled:${e.id}`,
        type: 'expiration_scheduled',
        sourceId: 'openrouter-models',
        path: 'raw/openrouter-models/response.json',
        subject: e.id,
        facts: [['expiration_date', e.expirationDate ?? '2026-09-30']],
      }),
    );
    const offenders = items.flatMap((i) => companySubjectViolations(composedProse(leakSentence(i))));
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// and over the new publication surfaces
// ---------------------------------------------------------------------------

describe('the copy rule over the pages the publication added', () => {
  const hostile = [
    leak({
      type: 'stealth_listing',
      sourceId: 'openrouter-models',
      path: 'raw/openrouter-models/response.json',
      subject: HOSTILE_ID,
    }),
    leak({
      type: 'upstream_pr_opened',
      sourceId: 'transformers-pulls',
      path: 'raw/transformers-pulls/response.json',
      subject: 'huggingface/transformers#1',
      facts: [['title', HOSTILE_TITLE]],
    }),
  ];
  const feed = buildFeed([], hostile);

  it('makes no company the subject of a verb on the front page', () => {
    expect(companySubjectViolations(composedProse(renderEverythingPage(feed)))).toEqual([]);
  });

  it('makes no company the subject of a verb on a micro-category page', () => {
    expect(companySubjectViolations(composedProse(renderTypePage('stealth_listing', feed)))).toEqual([]);
  });

  it('makes no company the subject of a verb on an empty front page', () => {
    expect(companySubjectViolations(composedProse(renderEverythingPage([])))).toEqual([]);
  });

  // A thread page prints the entity label as its own heading, and the entity
  // for a catalog id IS that id. Same class of exposure as the chip row.
  it('makes no company the subject of a verb on a thread page built from a hostile id', () => {
    const set = buildThreads(feed);
    const offenders = set.threads.flatMap((t) => companySubjectViolations(composedProse(renderThreadPage(t))));
    expect(offenders).toEqual([]);
  });

  it('builds a thread off the hostile id, so the case above is not vacuous', () => {
    expect(buildThreads(feed).threads.map((t) => t.entity.label)).toEqual([HOSTILE_ID]);
  });

  it('makes no company the subject of a verb on the threads index', () => {
    expect(companySubjectViolations(composedProse(renderThreadsIndex(buildThreads(feed))))).toEqual([]);
  });
});
