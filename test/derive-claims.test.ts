/**
 * The claim forms, spec section 10.1.
 *
 * These are the tests that stop the project shipping the sentence it was
 * founded to avoid. "OpenRouter's catalog context_length for X changed from A
 * to B" is an observation; "X's usable context was cut" is an inference that a
 * provider joining or leaving the routing pool falsifies, and 39 of 416 models
 * in the stored capture carry a top_provider.context_length that disagrees with
 * the catalogue's, so the inference is wrong often enough to matter.
 */

import { describe, it, expect } from 'vitest';
import { claimSentence, eventsFromChange, type DerivedEvent } from '../src/derive/events.js';
import { catalog, change, deprecationsDoc, docChange } from './derive-fixtures.js';

function first(events: DerivedEvent[], type: DerivedEvent['type']): DerivedEvent {
  const hit = events.find((e) => e.type === type);
  if (hit === undefined) throw new Error(`no ${type} event in the fixture`);
  return hit;
}

const modelAdded = first(
  eventsFromChange(change({ before: catalog([]), after: catalog([{ id: 'z-ai/glm-5.3' }]) })),
  'model_added',
);

const modelRemoved = first(
  eventsFromChange(change({ before: catalog([{ id: 'z-ai/glm-5.3' }]), after: catalog([]) })),
  'model_removed',
);

const priceChanged = first(
  eventsFromChange(
    change({
      before: catalog([{ id: 'z-ai/glm-5.2', pricing: { prompt: '0.000001' } }]),
      after: catalog([{ id: 'z-ai/glm-5.2', pricing: { prompt: '0.000003' } }]),
    }),
  ),
  'price_changed',
);

const contextChanged = first(
  eventsFromChange(
    change({
      before: catalog([
        { id: 'deepseek/deepseek-chat', context_length: 128000, top_provider_context_length: 128000 },
      ]),
      after: catalog([
        { id: 'deepseek/deepseek-chat', context_length: 65536, top_provider_context_length: 128000 },
      ]),
    }),
  ),
  'context_changed',
);

const expirationSet = first(
  eventsFromChange(
    change({
      before: catalog([{ id: 'openai/gpt-preview', expiration_date: null }]),
      after: catalog([{ id: 'openai/gpt-preview', expiration_date: '2026-09-30' }]),
    }),
  ),
  'expiration_set',
);

const aliasRetargeted = first(
  eventsFromChange(
    change({
      before: catalog([{ id: 'z-ai/glm-5.3', canonical_slug: 'z-ai/glm-5.3-20260816' }]),
      after: catalog([{ id: 'z-ai/glm-5.3', canonical_slug: 'z-ai/glm-5.3-20260901' }]),
    }),
  ),
  'alias_retargeted',
);

const docEvents = eventsFromChange(
  docChange(
    '- [Assistants API deep dive](https://developers.openai.com/api/docs/assistants/deep-dive.md)',
    '- [Responses](https://developers.openai.com/api/docs/responses.md)',
  ),
);
const docAdded = first(docEvents, 'doc_added');
const docRemoved = first(docEvents, 'doc_removed');

const retirementFloor = first(
  eventsFromChange(
    change({
      sourceId: 'anthropic-deprecations',
      path: 'raw/anthropic-deprecations/response.md',
      before: deprecationsDoc([['claude-opus-5', 'Active', 'N/A', 'Not sooner than July 24, 2027']]),
      after: deprecationsDoc([['claude-opus-5', 'Active', 'N/A', 'Not sooner than June 9, 2027']]),
    }),
  ),
  'retirement_floor',
);

const ALL: DerivedEvent[] = [
  modelAdded,
  modelRemoved,
  priceChanged,
  contextChanged,
  expirationSet,
  aliasRetargeted,
  docAdded,
  docRemoved,
  retirementFloor,
];

describe('the sentence each event renders as', () => {
  it('renders a model that entered the catalogue', () => {
    expect(claimSentence(modelAdded)).toBe("z-ai/glm-5.3 entered OpenRouter's catalog.");
  });

  it('renders a model that left the catalogue', () => {
    expect(claimSentence(modelRemoved)).toBe("z-ai/glm-5.3 left OpenRouter's catalog.");
  });

  it('renders a price change as a change to what the catalogue lists', () => {
    expect(claimSentence(priceChanged)).toBe(
      "OpenRouter's listed prompt price for z-ai/glm-5.2 changed from 0.000001 to 0.000003.",
    );
  });

  // The worked example the spec gives. The second sentence is what lets a
  // reader see routing churn for themselves, and it is why the event carries
  // top_provider.context_length on both sides.
  it('renders a context change naming the catalogue field and both top_provider values', () => {
    expect(claimSentence(contextChanged)).toBe(
      "OpenRouter's catalog context_length for deepseek/deepseek-chat changed from 128000 to 65536. " +
        'The top_provider.context_length recorded beside it was 128000 and is 128000.',
    );
  });

  it('renders an expiration date the catalogue recorded', () => {
    expect(claimSentence(expirationSet)).toBe(
      "OpenRouter's catalog recorded an expiration_date of 2026-09-30 for openai/gpt-preview.",
    );
  });

  it('renders an alias retarget as a canonical_slug move under an unchanged id', () => {
    expect(claimSentence(aliasRetargeted)).toBe(
      "OpenRouter's catalog canonical_slug for z-ai/glm-5.3 changed from z-ai/glm-5.3-20260816 to z-ai/glm-5.3-20260901.",
    );
  });

  it('renders an added documentation entry naming the index as the subject', () => {
    expect(claimSentence(docAdded)).toBe(
      'The openai-llms-txt index added an entry titled "Responses" at https://developers.openai.com/api/docs/responses.md.',
    );
  });

  it('renders a removed documentation entry naming the index as the subject', () => {
    expect(claimSentence(docRemoved)).toBe(
      'The openai-llms-txt index removed an entry titled "Assistants API deep dive" at https://developers.openai.com/api/docs/assistants/deep-dive.md.',
    );
  });

  it('renders a retirement floor as what the table records, quoting the cell', () => {
    expect(claimSentence(retirementFloor)).toBe(
      'The anthropic-deprecations table records the tentative retirement date for claude-opus-5 as "Not sooner than June 9, 2027".',
    );
  });

  it('renders an absent price side as absent rather than as an empty string', () => {
    const gone = first(
      eventsFromChange(
        change({
          before: catalog([{ id: 'z-ai/glm-5.2', pricing: { prompt: '1', web_search: '0.004' } }]),
          after: catalog([{ id: 'z-ai/glm-5.2', pricing: { prompt: '1' } }]),
        }),
      ),
      'price_changed',
    );
    expect(claimSentence(gone)).toBe(
      "OpenRouter's listed web_search price for z-ai/glm-5.2 changed from 0.004 to absent.",
    );
  });
});

/**
 * The company names a claim could name as a subject.
 *
 * Capitalised forms only. A lowercase `openai` inside `openai-llms-txt` or
 * inside a url is an identifier quoted from the archive, and quoting an
 * identifier is not making a company the subject of a verb.
 */
const COMPANIES = [
  'OpenRouter',
  'OpenAI',
  'Anthropic',
  'Google',
  'Meta',
  'Mistral',
  'DeepSeek',
  'Qwen',
  'Perplexity',
  'Together',
  'Groq',
  'Cohere',
  'NVIDIA',
];

/** Every place a capitalised company name appears, with what follows it. */
function companyMentions(sentence: string): { company: string; tail: string }[] {
  const out: { company: string; tail: string }[] = [];
  for (const company of COMPANIES) {
    let at = sentence.indexOf(company);
    while (at !== -1) {
      out.push({ company, tail: sentence.slice(at + company.length) });
      at = sentence.indexOf(company, at + 1);
    }
  }
  return out;
}

describe('the claim rule: an artifact is the subject, never a company', () => {
  // The rule stated mechanically. Every capitalised company name in a rendered
  // sentence is followed by an apostrophe-s, which makes it a modifier on the
  // artifact that follows. A company name standing on its own before a word is
  // a company doing something, which is the sentence a routing change or a
  // docs-platform migration falsifies.
  it('leaves every capitalised company name in a possessive, never standing alone', () => {
    const bare = ALL.flatMap((e) =>
      companyMentions(claimSentence(e))
        .filter((m) => !m.tail.startsWith("'s"))
        .map((m) => `${m.company} in: ${claimSentence(e)}`),
    );
    expect(bare).toEqual([]);
  });

  it('names a company at all in exactly the six catalogue claim forms', () => {
    const named = ALL.filter((e) => companyMentions(claimSentence(e)).length > 0).map((e) => e.type);
    expect(named).toEqual([
      'model_added',
      'model_removed',
      'price_changed',
      'context_changed',
      'expiration_set',
      'alias_retargeted',
    ]);
  });

  it('gives no sentence a causal clause', () => {
    const causal = ALL.filter((e) => /\b(because|due to|as a result|in order to|so that)\b/i.test(claimSentence(e)));
    expect(causal).toEqual([]);
  });

  // The forbidden column of the spec's table, word for word: "X's usable
  // context was cut", "X was discontinued", "X got 30% cheaper".
  it('uses none of the words the forbidden column of the spec table is built from', () => {
    const banned = ALL.filter((e) =>
      /\b(usable|cut|discontinued|cheaper|deprecated|launched|released)\b/i.test(claimSentence(e)),
    );
    expect(banned).toEqual([]);
  });

  it('ends every sentence with a full stop', () => {
    expect(ALL.filter((e) => !claimSentence(e).endsWith('.'))).toEqual([]);
  });

  it('renders a sentence for all nine event types', () => {
    expect(ALL.map((e) => e.type)).toEqual([
      'model_added',
      'model_removed',
      'price_changed',
      'context_changed',
      'expiration_set',
      'alias_retargeted',
      'doc_added',
      'doc_removed',
      'retirement_floor',
    ]);
  });
});
