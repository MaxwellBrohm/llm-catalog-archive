import { describe, expect, it } from 'vitest';
import { eventsFromChange, claimSentence, type DerivedEvent } from '../src/derive/events.js';
import { docChange } from './derive-fixtures.js';

const line = (title: string, url: string) => `- [${title}](${url})`;
const typesOf = (evs: DerivedEvent[]) => evs.map((e) => e.type).sort();

/**
 * A documentation index that renames a directory produces, per page, a url that
 * vanishes and a url that appears carrying the SAME TITLE. Reported as a
 * removal plus an addition that is twice wrong: the page was not removed and
 * the page is not new.
 *
 * In one live diff, 4 of 9 removals were Perplexity moving /gateway/ to
 * /router/ and OpenRouter lifting containers.md up a level. The other 5 were
 * OpenAI's Assistants API pages genuinely leaving the index. All nine rendered
 * at identical weight, so a real deprecation sat beside four non-events.
 */
describe('a documentation entry that changed url under one title', () => {
  const moved = eventsFromChange(
    docChange(
      line('Router Models & Pricing', 'https://docs.perplexity.ai/docs/gateway/models.md'),
      line('Router Models & Pricing', 'https://docs.perplexity.ai/docs/router/models.md'),
    ),
  );

  it('is one event, not two', () => {
    expect(moved).toHaveLength(1);
  });

  it('is a move rather than a removal or an addition', () => {
    expect(typesOf(moved)).toEqual(['doc_moved']);
  });

  it('carries both urls, so the move is checkable against the artifact', () => {
    const e = moved[0] as Extract<DerivedEvent, { type: 'doc_moved' }>;
    expect(e.fromUrl).toBe('https://docs.perplexity.ai/docs/gateway/models.md');
    expect(e.url).toBe('https://docs.perplexity.ai/docs/router/models.md');
  });

  /** The subject is the index entry, not the page: that is what the bytes support. */
  it('names the index entry as the subject and quotes every third-party value', () => {
    expect(claimSentence(moved[0] as DerivedEvent)).toBe(
      'The documentation index entry titled "Router Models & Pricing" moved from ' +
        '"https://docs.perplexity.ai/docs/gateway/models.md" to ' +
        '"https://docs.perplexity.ai/docs/router/models.md".',
    );
  });
});

describe('a genuine removal is still a removal', () => {
  const gone = eventsFromChange(
    docChange(
      [
        line('Assistants API deep dive', 'https://developers.openai.com/api/docs/assistants/deep-dive.md'),
        line('Responses', 'https://developers.openai.com/api/docs/responses.md'),
      ].join('\n'),
      line('Responses', 'https://developers.openai.com/api/docs/responses.md'),
    ),
  );

  it('reports a removal when no arrival carries that title', () => {
    expect(typesOf(gone)).toEqual(['doc_removed']);
  });
});

describe('a genuine addition is still an addition', () => {
  const added = eventsFromChange(
    docChange(line('Responses', 'https://x/a.md'), [line('Responses', 'https://x/a.md'), line('Batches', 'https://x/b.md')].join('\n')),
  );

  it('reports an addition when no departure carries that title', () => {
    expect(typesOf(added)).toEqual(['doc_added']);
  });
});

/**
 * THE AMBIGUITY GUARD. Same title ≠ same page. If a title occurs more than once
 * on either side of the diff there is no way to say which departure pairs with
 * which arrival, so nothing is paired: two true statements beat one confident
 * wrong one.
 */
describe('an ambiguous title is not paired', () => {
  const ambiguous = eventsFromChange(
    docChange(
      [line('Overview', 'https://x/a/overview.md'), line('Overview', 'https://x/b/overview.md')].join('\n'),
      [line('Overview', 'https://x/c/overview.md'), line('Overview', 'https://x/d/overview.md')].join('\n'),
    ),
  );

  it('emits removals and additions rather than guessing the pairing', () => {
    expect(typesOf(ambiguous)).toEqual(['doc_added', 'doc_added', 'doc_removed', 'doc_removed']);
  });

  it('emits no move at all', () => {
    expect(ambiguous.some((e) => e.type === 'doc_moved')).toBe(false);
  });

  it('is still ambiguous when only one side repeats the title', () => {
    const oneSided = eventsFromChange(
      docChange(
        line('Overview', 'https://x/a/overview.md'),
        [line('Overview', 'https://x/c/overview.md'), line('Overview', 'https://x/d/overview.md')].join('\n'),
      ),
    );
    expect(oneSided.some((e) => e.type === 'doc_moved')).toBe(false);
  });
});

describe('an entry whose url did not change', () => {
  it('emits nothing, because nothing about it changed', () => {
    const same = line('Responses', 'https://x/a.md');
    expect(eventsFromChange(docChange(same, same))).toEqual([]);
  });
});
