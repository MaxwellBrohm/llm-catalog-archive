/**
 * A Hacker News title, composed from the item's own fields.
 *
 * WHY THIS EXISTS. The derived sentences run 130 to 190 characters and HN caps
 * a title at 80, so the drafter refused HN every single day, and the person at
 * the desk had to write a title by hand for the one venue that matters most.
 * That lasted about a week before it stopped happening.
 *
 * WHY IT IS A TEMPLATE AND NOT A MODEL. The rule that a machine never rewrites a
 * claim still holds, and it holds here in a stricter form than for the
 * sentence: every VALUE in a title (a codename, a model id, a repository, a
 * date) is copied byte for byte from the event's typed fields, and the template
 * supplies only the connective words between them. A language model writing the
 * title would be free to say "DeepSeek V4" when the artifact says
 * "DeepSeek-V4-Flash-Vision-Exp", and the whole point of this site is that it
 * does not do that. A template cannot.
 *
 * It is also deterministic, which means it can be tested and mutation-tested,
 * and it costs nothing to run.
 *
 * NEVER TRUNCATED. If the filled template exceeds the limit it returns null and
 * the desk asks a person, exactly as before. A long model id is the usual cause.
 */

import type { FeedItem } from '../derive/feed.js';

export const HN_TITLE_LIMIT = 80;

function fact(item: FeedItem, key: string): string | null {
  const row = item.facts.find(([k]) => k === key);
  return row === undefined ? null : row[1];
}

/**
 * The catalogue's name, from the source id.
 *
 * `openrouter-models` is a machine key for a file on disk; the thing a reader
 * knows is called OpenRouter. This cost the archive its single most newsworthy
 * item: the first stealth listing it ever recorded scored 10.1 bits and was
 * routed to Bluesky, because "in the openrouter-models catalogue" pushed the
 * composed title to 82 characters against HN's 80. Two characters, on the story
 * this site exists to break.
 *
 * NOT A PARAPHRASE. The mapping is from a source id (ours, not the vendor's)
 * to the vendor's own name for itself, and the model id in the same title stays
 * byte for byte. An unmapped source falls back to the raw id rather than to a
 * guess, so a new source never gets a name it did not earn.
 */
const CATALOGUE_NAME: Readonly<Record<string, string>> = {
  'openrouter-models': 'OpenRouter',
  'groq-llms-full-txt': 'Groq',
  'together-llms-txt': 'Together',
  'mistral-llms-txt': 'Mistral',
  'xai-llms-txt': 'xAI',
  'openai-llms-txt': 'OpenAI',
  'claude-llms-txt': 'Anthropic',
  'perplexity-llms-txt': 'Perplexity',
};

function catalogueName(sourceId: string): string {
  return CATALOGUE_NAME[sourceId] ?? sourceId;
}

/** `vllm-project/vllm` -> `vllm`. The repo's own short name, casing untouched. */
function repoShort(full: string): string {
  const slash = full.lastIndexOf('/');
  return slash === -1 ? full : full.slice(slash + 1);
}

/**
 * The title, or null when this type has no template or the filled one is too
 * long. The `by` field says which, so the desk can show the difference between
 * "we wrote this from the event" and "nobody has written one".
 */
export type Title = { readonly text: string; readonly by: 'template' };

export function hnTitle(item: FeedItem, limit: number = HN_TITLE_LIMIT): Title | null {
  const text = compose(item);
  if (text === null || text.length > limit || text.length === 0) return null;
  return { text, by: 'template' };
}

function compose(item: FeedItem): string | null {
  const ev = item.event;
  switch (item.type) {
    case 'codename_unmasked': {
      const name = fact(item, 'publicName');
      const to = fact(item, 'displayName after');
      if (name === null || to === null || to === 'absent') return null;
      return `Arena codename "${name}" resolves to ${to}`;
    }
    /*
     * THE SAME TITLE AS codename_unmasked ON PURPOSE. To a reader the finding
     * is identical, "this codename is that model", and the two types differ
     * only in whether the archive also knows WHEN the pairing appeared. That
     * difference belongs in the sentence and the facts, which carry it, not in
     * a headline that would have to say "has been observed to be" to express
     * it. "resolves to" is present tense and claims no timing.
     */
    case 'codename_standing': {
      const key = fact(item, 'modelKey');
      const to = fact(item, 'displayName');
      if (key === null || to === null || to === '') return null;
      return `Arena codename "${item.id.split(':').slice(2).join(':')}" resolves to ${to}`;
    }
    case 'codename_entered': {
      const name = fact(item, 'publicName');
      if (name === null) return null;
      return `New codename "${name}" on the arena.ai leaderboard`;
    }
    case 'upstream_pr_merged': {
      const repo = fact(item, 'repository');
      const arch = fact(item, 'architecture named in the title');
      if (repo === null || arch === null) return null;
      return `${repoShort(repo)} merges ${arch} support`;
    }
    case 'upstream_pr_opened': {
      const repo = fact(item, 'repository');
      const arch = fact(item, 'architecture named in the title');
      if (repo === null || arch === null) return null;
      return `${arch} support proposed for ${repoShort(repo)}`;
    }
    case 'stealth_listing': {
      const id = fact(item, 'catalog id');
      if (id === null) return null;
      return `Unannounced model "${id}" listed on ${catalogueName(item.sourceId)}`;
    }
    case 'model_added':
      if (ev === null || ev.type !== 'model_added') return null;
      return `${ev.modelId} added to the ${catalogueName(item.sourceId)} catalogue`;
    case 'model_removed':
      if (ev === null || ev.type !== 'model_removed') return null;
      return `${ev.modelId} removed from the ${catalogueName(item.sourceId)} catalogue`;
    case 'retirement_floor':
      if (ev === null || ev.type !== 'retirement_floor' || ev.floorDate === null) return null;
      return `${ev.provider} sets ${ev.model} retirement for ${ev.floorDate}`;
    case 'incident_opened':
      if (ev === null || ev.type !== 'incident_opened') return null;
      return `${ev.provider} status: "${ev.title}"`;
    default:
      return null;
  }
}
