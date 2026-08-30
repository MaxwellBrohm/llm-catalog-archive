import { describe, it, expect } from 'vitest';
import {
  entitiesForApiModel,
  entitiesForCatalogModel,
  entitiesForDocUrl,
  entitySlug,
  labFromVendor,
  LABS,
  providerFromSourceId,
} from '../src/derive/entities.js';

describe('labFromVendor', () => {
  it('maps the vendor prefix anthropic to the lab anthropic', () => {
    expect(labFromVendor('anthropic')).toBe('anthropic');
  });

  it('maps the catalogue spelling mistralai to the lab mistral', () => {
    expect(labFromVendor('mistralai')).toBe('mistral');
  });

  it('maps the catalogue spelling meta-llama to the lab meta', () => {
    expect(labFromVendor('meta-llama')).toBe('meta');
  });

  it('maps the catalogue spelling x-ai to the lab xai', () => {
    expect(labFromVendor('x-ai')).toBe('xai');
  });

  // The tilde marks OpenRouter's floating ids. It is a marker on the id, not
  // part of the vendor's name, so stripping it is what lets
  // ~anthropic/claude-opus-latest reach Anthropic's thread at all.
  it('strips the tilde OpenRouter puts on a floating id before looking the vendor up', () => {
    expect(labFromVendor('~anthropic')).toBe('anthropic');
  });

  it('returns null for a vendor the table does not hold rather than inventing a lab', () => {
    expect(labFromVendor('aion-labs')).toBeNull();
  });

  // OpenRouter is a router, and the product's lab list is closed. A vendor
  // prefix that happens to be a company is not automatically a lab.
  it('returns null for openrouter, which is not one of the labs the product names', () => {
    expect(labFromVendor('openrouter')).toBeNull();
  });

  it('returns null for the empty vendor', () => {
    expect(labFromVendor('')).toBeNull();
  });

  it('never returns a value outside the published lab list', () => {
    const vendors = ['anthropic', 'claude', 'mistralai', 'meta-llama', 'x-ai', 'z-ai', 'moonshotai'];
    const labs = vendors.map((v) => labFromVendor(v));
    expect(labs).toEqual(['anthropic', 'anthropic', 'mistral', 'meta', 'xai', 'zai', 'moonshot']);
  });

  it('publishes exactly the sixteen labs the product names', () => {
    expect([...LABS]).toEqual([
      'anthropic',
      'openai',
      'google',
      'meta',
      'mistral',
      'deepseek',
      'qwen',
      'xai',
      'zai',
      'moonshot',
      'minimax',
      'nvidia',
      'cohere',
      'perplexity',
      'together',
      'groq',
    ]);
  });
});

describe('providerFromSourceId', () => {
  it('reads openai out of openai-llms-txt', () => {
    expect(providerFromSourceId('openai-llms-txt')).toBe('openai');
  });

  it('reads groq out of the full-text variant groq-llms-full-txt', () => {
    expect(providerFromSourceId('groq-llms-full-txt')).toBe('groq');
  });

  it('reads anthropic out of anthropic-deprecations', () => {
    expect(providerFromSourceId('anthropic-deprecations')).toBe('anthropic');
  });

  it('returns null for a source id carrying no provider segment', () => {
    expect(providerFromSourceId('modelsdev-commits')).toBeNull();
  });

  it('returns null rather than an empty provider when the id is only the suffix', () => {
    expect(providerFromSourceId('-llms-txt')).toBeNull();
  });
});

describe('entitiesForCatalogModel', () => {
  it('yields the model entity namespaced to the catalogue it was read from', () => {
    expect(entitiesForCatalogModel('anthropic/claude-opus-5')[0]).toEqual({
      kind: 'model',
      id: 'model/openrouter:anthropic/claude-opus-5',
      label: 'anthropic/claude-opus-5',
    });
  });

  it('yields the lab entity beside the model when the vendor is a known lab', () => {
    expect(entitiesForCatalogModel('anthropic/claude-opus-5')[1]).toEqual({
      kind: 'lab',
      id: 'lab/anthropic',
      label: 'anthropic',
    });
  });

  // The model dimension is unambiguous (the argument IS the catalogue's id) and
  // the lab dimension is not, so exactly one of the two is held.
  it('yields the model alone, with no lab, for a vendor the table does not hold', () => {
    expect(entitiesForCatalogModel('aion-labs/aion-1.0')).toEqual([
      { kind: 'model', id: 'model/openrouter:aion-labs/aion-1.0', label: 'aion-labs/aion-1.0' },
    ]);
  });

  it('yields nothing for an id with no vendor separator', () => {
    expect(entitiesForCatalogModel('claude-opus-5')).toEqual([]);
  });

  it('yields nothing for an id whose vendor half is empty', () => {
    expect(entitiesForCatalogModel('/claude-opus-5')).toEqual([]);
  });

  it('yields nothing for an id whose slug half is empty', () => {
    expect(entitiesForCatalogModel('anthropic/')).toEqual([]);
  });
});

describe('entitiesForApiModel', () => {
  it('namespaces a provider API model name away from the OpenRouter catalogue', () => {
    expect(entitiesForApiModel('anthropic', 'claude-opus-4-1-20250805')[0]).toEqual({
      kind: 'model',
      id: 'model/anthropic-api:claude-opus-4-1-20250805',
      label: 'claude-opus-4-1-20250805',
    });
  });

  it('attaches the lab for the provider the table holds', () => {
    expect(entitiesForApiModel('anthropic', 'claude-opus-5')[1]).toEqual({
      kind: 'lab',
      id: 'lab/anthropic',
      label: 'anthropic',
    });
  });

  // A slash means the caller handed over a catalogue id, which belongs in the
  // openrouter namespace. Accepting it here would file the same model under two
  // ids that differ only in which function was called.
  it('yields nothing for a name carrying a vendor separator', () => {
    expect(entitiesForApiModel('anthropic', 'anthropic/claude-opus-5')).toEqual([]);
  });

  it('yields nothing for an empty model name', () => {
    expect(entitiesForApiModel('anthropic', '')).toEqual([]);
  });

  it('yields nothing for an empty provider', () => {
    expect(entitiesForApiModel('', 'claude-opus-5')).toEqual([]);
  });
});

describe('entitiesForDocUrl', () => {
  // The section, not the page. OpenRouter moved containers.md from
  // .../server-tools/ to .../features/ in the archive's own history, and a
  // per-page entity would file that one move under two threads nobody reads.
  it('takes the section, which is every path segment except the page itself', () => {
    expect(
      entitiesForDocUrl('https://openrouter.ai/docs/guides/features/containers.md', 'openrouter')[0],
    ).toEqual({
      kind: 'api-surface',
      id: 'api-surface/openrouter.ai/docs/guides/features',
      label: 'openrouter.ai/docs/guides/features',
    });
  });

  it('attaches no lab for openrouter, which is not one of the sixteen labs', () => {
    expect(
      entitiesForDocUrl('https://openrouter.ai/docs/guides/features/containers.md', 'openrouter'),
    ).toHaveLength(1);
  });

  it('attaches the lab beside the surface when the provider is a known lab', () => {
    expect(
      entitiesForDocUrl('https://developers.openai.com/api/docs/assistants/tools.md', 'openai')[1],
    ).toEqual({ kind: 'lab', id: 'lab/openai', label: 'openai' });
  });

  it('yields nothing at all for text that is not a URL', () => {
    expect(entitiesForDocUrl('guides/features/containers.md', 'openai')).toEqual([]);
  });

  it('yields nothing for a non-http scheme', () => {
    expect(entitiesForDocUrl('javascript:alert(1)', 'openai')).toEqual([]);
  });

  // A javascript: url whose body happens to look like a path would otherwise
  // pass the section test and open a thread, because URL parses it happily and
  // its pathname is the whole body. These are third-party bytes.
  it('yields nothing for a non-http scheme whose body looks like a path', () => {
    expect(entitiesForDocUrl('javascript:a/b/c.md', 'openai')).toEqual([]);
  });

  // One segment is a page sitting at the host root. There is no section above
  // it, and calling the host a section would invent an API surface.
  it('yields nothing for a page at the host root, where there is no section', () => {
    expect(entitiesForDocUrl('https://developers.openai.com/index.md', 'openai')).toEqual([]);
  });

  it('yields nothing for the host root itself', () => {
    expect(entitiesForDocUrl('https://developers.openai.com/', 'openai')).toEqual([]);
  });
});

describe('entitySlug', () => {
  it('folds a catalogue model id to a file-safe permalink segment', () => {
    expect(
      entitySlug({ kind: 'model', id: 'model/openrouter:anthropic/claude-opus-5', label: 'x' }),
    ).toBe('model-openrouter-anthropic-claude-opus-5');
  });

  it('folds a lab id to its own segment', () => {
    expect(entitySlug({ kind: 'lab', id: 'lab/anthropic', label: 'x' })).toBe('lab-anthropic');
  });

  it('folds a docs host and section without leaving a leading or trailing dash', () => {
    expect(
      entitySlug({ kind: 'api-surface', id: 'api-surface/docs.together.ai/reference/', label: 'x' }),
    ).toBe('api-surface-docs-together-ai-reference');
  });

  it('never emits the empty string, which would not be a file name', () => {
    expect(entitySlug({ kind: 'lab', id: '///', label: 'x' })).toBe('entity');
  });
});

describe('the vendor table, exhaustively', () => {
  // Fourteen of the sixteen lab names appear as both the key and the value of a
  // table row, so a mutation to the value alone is invisible to a test that
  // checks one row at a time. This asserts the whole mapping in one literal.
  it('maps every vendor prefix the catalogue ships to the lab it belongs to', () => {
    const vendors = [
      'anthropic',
      'claude',
      'openai',
      'google',
      'meta',
      'meta-llama',
      'mistral',
      'mistralai',
      'deepseek',
      'qwen',
      'x-ai',
      'xai',
      'z-ai',
      'zai',
      'moonshot',
      'moonshotai',
      'minimax',
      'nvidia',
      'cohere',
      'perplexity',
      'together',
      'groq',
    ];
    expect(vendors.map((v) => labFromVendor(v))).toEqual([
      'anthropic',
      'anthropic',
      'openai',
      'google',
      'meta',
      'meta',
      'mistral',
      'mistral',
      'deepseek',
      'qwen',
      'xai',
      'xai',
      'zai',
      'zai',
      'moonshot',
      'moonshot',
      'minimax',
      'nvidia',
      'cohere',
      'perplexity',
      'together',
      'groq',
    ]);
  });

  it('reads a provider out of the sitemap source shape as well as the llms.txt one', () => {
    expect(providerFromSourceId('anthropic-sitemap')).toBe('anthropic');
  });
});

describe('entitiesForApiModel with an unknown provider', () => {
  // openrouter is a router and not one of the sixteen labs, so the lab
  // dimension is held. Pushing an entity built from a null lab would put a
  // thread called lab/null in the generated directory.
  it('yields the model alone when the provider is not a lab', () => {
    expect(entitiesForApiModel('openrouter', 'some-model')).toEqual([
      { kind: 'model', id: 'model/openrouter-api:some-model', label: 'some-model' },
    ]);
  });
});

describe('entitiesForDocUrl, the shapes the archive actually holds', () => {
  it('accepts a plain http url as well as https', () => {
    expect(entitiesForDocUrl('http://docs.together.ai/reference/a.md', 'together')[0]?.id).toBe(
      'api-surface/docs.together.ai/reference',
    );
  });

  // Two segments is the smallest url that has a section: one page inside one
  // directory. The boundary matters because the guard above it rejects one.
  it('takes the single directory of a two segment path as the section', () => {
    expect(entitiesForDocUrl('https://docs.together.ai/reference/a.md', 'together')[0]?.id).toBe(
      'api-surface/docs.together.ai/reference',
    );
  });

  it('keeps the host in the surface id, so two providers cannot share a section', () => {
    expect(entitiesForDocUrl('https://docs.perplexity.ai/docs/router/a.md', 'perplexity')[0]?.id).toBe(
      'api-surface/docs.perplexity.ai/docs/router',
    );
  });
});

describe('entitySlug folding', () => {
  it('lowercases before folding, so two cases of one id cannot become two pages', () => {
    expect(entitySlug({ kind: 'model', id: 'model/openrouter:Meta/Llama-4', label: 'x' })).toBe(
      'model-openrouter-meta-llama-4',
    );
  });

  it('trims a leading run of folded characters', () => {
    expect(entitySlug({ kind: 'lab', id: '::anthropic', label: 'x' })).toBe('anthropic');
  });

  it('collapses a run of folded characters to a single dash', () => {
    expect(entitySlug({ kind: 'lab', id: 'lab///anthropic', label: 'x' })).toBe('lab-anthropic');
  });
});
