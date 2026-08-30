/**
 * Literals for the derive tests. Not a test file: vitest only collects
 * `test/**\/*.test.ts`.
 *
 * The catalogue entries are trimmed copies of real rows from
 * raw/openrouter-models/response.json, including the two shapes that break a
 * naive differ: a `pricing.overrides` ARRAY, which 60 models carry today, and a
 * `top_provider.context_length` that disagrees with the model's own
 * `context_length`, which 39 of 416 carry.
 */

import type { ContentChange, Tier } from '../src/derive/events.js';
import type { Stamp } from '../src/site/record.js';

export const SHA = 'a69a068319de9dc9a7ab1049b411a562a026e7d5';

export const ORIGIN: Stamp = { iso: '2026-08-28T08:08:22.000Z', kind: 'origin' };
export const EARLIER: Stamp = { iso: '2026-08-27T08:08:22.000Z', kind: 'origin' };

export type ModelSpec = {
  id: string;
  created?: number;
  canonical_slug?: string;
  context_length?: number;
  top_provider_context_length?: number | null;
  pricing?: Record<string, unknown>;
  expiration_date?: string | null;
};

/** A catalogue document with exactly these models, in this order. */
export function catalog(models: ModelSpec[]): string {
  return JSON.stringify({
    data: models.map((m) => ({
      id: m.id,
      canonical_slug: m.canonical_slug ?? m.id,
      name: m.id,
      created: m.created ?? 1787752741,
      context_length: m.context_length ?? 128000,
      pricing: m.pricing ?? { prompt: '0.000001', completion: '0.000002' },
      top_provider: {
        context_length:
          m.top_provider_context_length === undefined
            ? (m.context_length ?? 128000)
            : m.top_provider_context_length,
        max_completion_tokens: 8192,
        is_moderated: false,
      },
      expiration_date: m.expiration_date ?? null,
    })),
  });
}

export function change(over: Partial<ContentChange> = {}): ContentChange {
  return {
    sourceId: 'openrouter-models',
    path: 'raw/openrouter-models/response.json',
    sha: SHA,
    tier: 'fast' as Tier,
    kind: 'modified',
    before: catalog([{ id: 'anthropic/claude-opus-5' }]),
    after: catalog([{ id: 'anthropic/claude-opus-5' }]),
    stamp: ORIGIN,
    previousStamp: EARLIER,
    ...over,
  };
}

/** A change to a docs index, with both sides given as llms.txt text. */
export function docChange(before: string, after: string, sourceId = 'openai-llms-txt'): ContentChange {
  return change({
    sourceId,
    path: `raw/${sourceId}/response.txt`,
    before,
    after,
  });
}

/** The lifecycle table, as the stored deprecations markdown writes it. */
export function deprecationsDoc(rows: [string, string, string, string][]): string {
  const head = '| API model name | Current state | Deprecated | Tentative retirement date |';
  const rule = '| -------------- | ------------- | ---------- | ------------------------- |';
  const body = rows.map((r) => `| ${r.join(' | ')} |`);
  return ['# Model deprecations', '', head, rule, ...body, '', '## Deprecation history'].join('\n');
}
