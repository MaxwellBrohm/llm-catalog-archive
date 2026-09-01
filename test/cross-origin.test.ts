import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { checkHealth } from '../src/health.js';
import { loadSources } from '../src/config.js';
import type { Source } from '../src/config.js';
import type { Observed } from '../src/types.js';

/**
 * COULD ONE SOURCE'S BYTES BE ARCHIVED UNDER ANOTHER SOURCE'S NAME?
 *
 * The write gates are structural: status, size band, content type, required key
 * path, record floor, canary. Structurally identical siblings therefore pass
 * each other's gates. A sweep of every stored capture against every other
 * source's gates found 5 of 306 foreign bodies accepted, all between siblings:
 * claude-status against modelsdev-commits both ways, openai-status into
 * claude-status, and vllm-pulls against transformers-pulls both ways.
 *
 * Reaching it needs a typo in meta/sources.json or an origin misroute, and
 * src/health.ts only downgrades to 'relocated' when finalUrl differs from the
 * CONFIGURED url, so a wrong url in the config is not a mismatch, it is the
 * expectation. Worst case is an OpenAI status feed archived under
 * raw/claude-status/ with every derived incident attributed to Anthropic.
 *
 * The fix is a canary per source, which the spec already required. This test is
 * what keeps it fixed: it fails the moment a new source arrives without a
 * canary that distinguishes it from its siblings.
 */

const file = loadSources(JSON.parse(fs.readFileSync('meta/sources.json', 'utf8')));
const active = file.sources.filter((s) => s.status === 'active');

/** The stored body for a source, or null when it has never captured. */
function storedBody(s: Source): Uint8Array | null {
  const p = path.join(process.cwd(), s.path);
  return fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null;
}

const bodies = new Map<string, Uint8Array>();
for (const s of active) {
  const b = storedBody(s);
  if (b !== null) bodies.set(s.id, b);
}

const obsFor = (s: Source, body: Uint8Array): Observed => ({
  status: 200,
  body,
  finalUrl: s.url,
  redirectCount: 0,
  headers: {},
});

const NOW = Date.parse('2026-09-01T12:00:00Z');

describe('a foreign body cannot be archived under the wrong source', () => {
  it('has enough stored captures to make the sweep meaningful', () => {
    expect(bodies.size).toBeGreaterThan(10);
  });

  it('accepts each source its own body, so the gates are not simply refusing everything', () => {
    const rejected: string[] = [];
    for (const s of active) {
      const own = bodies.get(s.id);
      if (own === undefined) continue;
      // Judged against its own stored size, and with a lastChangeAt inside any
      // quiet window, so this measures the STRUCTURAL gates only.
      const v = checkHealth(s, obsFor(s, own), { bytes: own.byteLength, lastChangeAt: new Date(NOW).toISOString() }, NOW);
      if (!v.writeAllowed) rejected.push(`${s.id}: ${v.reason ?? v.state}`);
    }
    expect(rejected).toEqual([]);
  });

  it('rejects every other source’s body, on every source', () => {
    const accepted: string[] = [];
    for (const target of active) {
      const own = bodies.get(target.id);
      for (const [foreignId, foreign] of bodies) {
        if (foreignId === target.id) continue;
        const v = checkHealth(
          target,
          obsFor(target, foreign),
          { bytes: own?.byteLength ?? foreign.byteLength, lastChangeAt: new Date(NOW).toISOString() },
          NOW,
        );
        if (v.writeAllowed) accepted.push(`${foreignId} was accepted as ${target.id}`);
      }
    }
    expect(accepted).toEqual([]);
  });
});

/**
 * The canary is what closes the hole above for a source whose siblings share its
 * shape. A source with no canary is only safe while nothing else in the archive
 * looks like it, which is a property of the OTHER entries and so cannot be
 * relied on as new sources arrive.
 */
describe('canary coverage', () => {
  const withoutCanary = active.filter((s) => s.invariants.canary === null);

  /**
   * This list SHRANK when two sitemaps were added. anthropic-sitemap and
   * openrouter-sitemap were safe on structure alone only while they were the
   * only two urlsets in the archive; deepmind-sitemap and openai-sitemap ended
   * that, and the sweep above immediately accepted each of them as the other.
   * Structural uniqueness is a property of the OTHER entries, which is exactly
   * why it cannot be relied on as sources arrive.
   */
  it('names the sources standing on structure alone, so the list is deliberate', () => {
    expect(withoutCanary.map((s) => s.id).sort()).toEqual(['arena-leaderboard', 'openrouter-models'].sort());
  });

  it('gives every source that has a same-shaped sibling a canary', () => {
    // Two left: a JSON catalogue with a data key, and a 5MB HTML picker
    // payload. Nothing else in the archive has either shape.
    for (const s of active) {
      const siblings = active.filter(
        (o) => o.id !== s.id && o.contentType === s.contentType && o.expectedRoot === s.expectedRoot,
      );
      if (siblings.length > 0 && s.invariants.canary === null) {
        expect(
          ['arena-leaderboard', 'openrouter-models'],
          `${s.id} shares its shape with ${siblings.map((x) => x.id).join(', ')} but has no canary`,
        ).toContain(s.id);
      }
    }
  });

  it('uses a canary that actually appears in that source’s own stored bytes', () => {
    const missing: string[] = [];
    for (const s of active) {
      const own = bodies.get(s.id);
      if (own === null || own === undefined || s.invariants.canary === null) continue;
      const text = new TextDecoder('utf-8', { fatal: false }).decode(own);
      if (!text.includes(s.invariants.canary)) missing.push(s.id);
    }
    expect(missing).toEqual([]);
  });
});
