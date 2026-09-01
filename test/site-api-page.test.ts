import { describe, it, expect } from 'vitest';
import { renderApiPage, API_PATH } from '../src/site/render.js';
import { buildApi } from '../src/api/build.js';

const SITE = 'https://example.test/archive';
const page = renderApiPage(SITE);

const emitted = new Set(
  buildApi({ feed: [], threads: { threads: [], held: [] }, refusals: [], ledger: [], changes: [], siteUrl: SITE }).map(
    (f) => f.path,
  ),
);

/** Every concrete API address the page prints, templated ones excluded. */
function addressesOnPage(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/api\/v1\/[A-Za-z0-9/{}._-]+\.json/g)) {
    const rel = m[0];
    if (rel.includes('{')) continue;
    out.add(rel);
  }
  return [...out].sort();
}

describe('the API documentation page', () => {
  it('lives at api.html', () => {
    expect(API_PATH).toBe('api.html');
  });

  // The reason to check this rather than eyeball it: an endpoint renamed in the
  // generator leaves a curl example on a published page that 404s, and a docs
  // page whose examples do not run is worse than no docs page.
  it('prints only addresses the generator actually emits', () => {
    const missing = addressesOnPage(page).filter((rel) => !emitted.has(rel));
    expect(missing).toEqual([]);
  });

  it('prints the concrete addresses the examples are built on', () => {
    expect(addressesOnPage(page)).toEqual([
      'api/v1/accuracy.json',
      'api/v1/events.json',
      'api/v1/events/context-changed.json',
      'api/v1/events/price-changed.json',
      'api/v1/index.json',
      'api/v1/leaks.json',
      'api/v1/models.json',
      'api/v1/retirements.json',
    ]);
  });

  it('writes the examples against the base URL it was given, not a placeholder', () => {
    expect(page).toContain('curl -s https://example.test/archive/api/v1/index.json');
  });

  it('names the npx spec that resolves to this repository', () => {
    expect(page).toContain('npx github:MaxwellBrohm/llm-catalog-archive models --lab anthropic');
  });

  it('labels the commodity tier as a commodity rather than as a feature', () => {
    expect(page).toContain('Free commodity');
  });

  /**
   * This replaced a sentence claiming one incumbent had "no API at all".
   * pricepertoken.com serves a keyless /_payload.json, so that was false. The
   * page now names each incumbent's actual shape and says it was corrected.
   */
  it('states the tier-B claim as shape, not as absence of an API', () => {
    expect(page).toContain('The claim here is shape');
    expect(page).not.toContain('no API at all,');
  });

  it('names what each incumbent actually serves, checkably', () => {
    expect(page).toContain('/_payload.json');
    expect(page).toContain('redirects');
  });

  it('admits the earlier sentence was wrong rather than quietly editing it', () => {
    expect(page).toContain('which was wrong');
  });

  it('states that null precision is not zero error', () => {
    expect(page).toContain('Null is not zero error.');
  });

  it('states that a catalog id and a provider API model name are not joined', () => {
    expect(page).toContain('deciding they name the same model is a judgement nothing here makes');
  });

  it('marks itself as the active section in the navigation', () => {
    expect(page).toContain('<a class="on" aria-current="page" href="api.html">API and CLI</a>');
  });
});
