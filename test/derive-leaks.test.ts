import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  ARENA_CODENAME_FLOOR,
  arenaCodenameMap,
  CHANNEL_TOKENS,
  confirmationQuery,
  deriveLeakRefusals,
  deriveLeaks,
  EXPIRATION_SENTINEL_YEAR,
  isCodenameReveal,
  isExpirationSentinel,
  isIdentityToken,
  isLabelVariant,
  isStealthListing,
  leakSentence,
  leakResult,
  leaksFromChange,
  modelSupportName,
  parseCatalogLeaks,
  parsePullSearch,
  type LeakItem,
} from '../src/derive/leaks.js';
import { catalog, change, SHA } from './derive-fixtures.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * A record in the shape the arena flight payload actually carries it: JSON
 * escaped inside a JS string literal, so every quote is a backslash-quote.
 *
 * Written as a helper rather than pasted, because the escaping is the whole
 * difficulty of this source and a fixture that quietly used the bare form
 * would match zero records and look like an empty leaderboard.
 */
function arenaRecord(publicName: string, displayName: string): string {
  return `\\"publicName\\":\\"${publicName}\\",\\"displayName\\":\\"${displayName}\\",\\"rating\\":1200,\\"votes\\":5000`;
}

const arenaDoc = (pairs: [string, string][]): string =>
  `{\\"models\\":[{${pairs.map(([a, b]) => arenaRecord(a, b)).join('},{')}}]}`;

/**
 * Enough pairs on BOTH sides of a change to clear ARENA_CODENAME_FLOOR.
 *
 * The desk refuses to derive anything across a change where either capture's
 * codename map is below the floor, because a payload reshape that collapses the
 * map and then recovers makes every name in it look newly entered: roughly a
 * thousand false claims at live scale, each with an honest permalink attached.
 * A two-record fixture is below that floor, so without this filler every case
 * below would be asserting against the refusal rather than against the signal.
 *
 * Each filler name IS its own displayName and the same pairs appear on both
 * sides, so the filler enters nothing and unmasks nothing. Every item a test
 * below sees comes from the pairs that test passed in.
 */
const ARENA_FILLER: [string, string][] = Array.from({ length: ARENA_CODENAME_FLOOR }, (_, i) => {
  const name = `filler-${String(i).padStart(4, '0')}`;
  return [name, name];
});

function arenaChange(before: [string, string][], after: [string, string][]) {
  return change({
    sourceId: 'arena-leaderboard',
    path: 'raw/arena-leaderboard/response.html',
    before: arenaDoc([...ARENA_FILLER, ...before]),
    after: arenaDoc([...ARENA_FILLER, ...after]),
  });
}

/** The same shape with NO filler, so the floor itself can be asserted on. */
function unpaddedArenaChange(before: [string, string][], after: [string, string][]) {
  return change({
    sourceId: 'arena-leaderboard',
    path: 'raw/arena-leaderboard/response.html',
    before: arenaDoc(before),
    after: arenaDoc(after),
  });
}

type PullSpec = { number: number; title: string; state?: string; merged_at?: string | null };

const pullDoc = (items: PullSpec[]): string =>
  JSON.stringify({
    total_count: items.length,
    incomplete_results: false,
    items: items.map((p) => ({
      number: p.number,
      title: p.title,
      state: p.state ?? 'open',
      created_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-30T00:00:00Z',
      score: 1,
      html_url: `https://github.com/huggingface/transformers/pull/${p.number}`,
      pull_request: { merged_at: p.merged_at ?? null },
    })),
  });

function pullChange(before: PullSpec[], after: PullSpec[], sourceId = 'transformers-pulls') {
  return change({
    sourceId,
    path: `raw/${sourceId}/response.json`,
    before: pullDoc(before),
    after: pullDoc(after),
  });
}

/**
 * The complete set of differing (publicName, displayName) pairs in a live
 * capture, with a HAND classification beside each.
 *
 * The point of the fixture is that it is the whole population and not a
 * selection: a filter tuned against six chosen rows proves nothing about the
 * fifty-one it was not shown.
 */
function livePairs(): { publicName: string; displayName: string; expected: string }[] {
  return fs
    .readFileSync('test/fixtures/arena-pairs-2026-08-31.tsv', 'utf8')
    .split('\n')
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => {
      const [publicName, displayName, expected] = l.split('\t');
      return { publicName: publicName!, displayName: displayName!, expected: expected! };
    });
}

// ---------------------------------------------------------------------------
// the fixtures still carry their properties
// ---------------------------------------------------------------------------

describe('the leaks fixtures still carry what the tests read them for', () => {
  it('holds every one of the 57 differing pairs the live capture had', () => {
    expect(livePairs()).toHaveLength(57);
  });

  it('classifies 39 of those pairs as reveals by hand', () => {
    expect(livePairs().filter((p) => p.expected === 'reveal')).toHaveLength(39);
  });

  it('classifies 18 of those pairs as label variants by hand', () => {
    expect(livePairs().filter((p) => p.expected === 'variant')).toHaveLength(18);
  });

  // The real payload's escaping. A slice that had been unescaped on the way
  // into the repository would make every arena test here pass against a shape
  // the live source does not serve.
  it('keeps the arena slice in the backslash-escaped form the live payload uses', () => {
    const slice = fs.readFileSync('test/fixtures/arena-flight-slice.txt', 'utf8');
    expect(slice.includes('\\"publicName\\":\\"')).toBe(true);
  });

  it('carries no bare publicName key in the arena slice at all', () => {
    const slice = fs.readFileSync('test/fixtures/arena-flight-slice.txt', 'utf8');
    expect(slice.includes('"publicName":"')).toBe(false);
  });

  it('keeps merged_at inside the stored github search payload', () => {
    const payload = JSON.parse(fs.readFileSync('test/fixtures/github-pulls-transformers.json', 'utf8'));
    const merged = payload.items.filter((i: { pull_request: { merged_at: string | null } }) => i.pull_request.merged_at !== null);
    expect(merged.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// the codename filter
// ---------------------------------------------------------------------------

describe('isIdentityToken', () => {
  it('accepts a multi-character token carrying a letter', () => {
    expect(isIdentityToken('qwen')).toBe(true);
  });

  // `anonymous-0410` -> `openhard-1.0-search-non-reasoning-0410` is a real
  // reveal whose only shared token is this date stamp.
  it('rejects an all-digit token', () => {
    expect(isIdentityToken('0410')).toBe(false);
  });

  it('rejects a single character', () => {
    expect(isIdentityToken('v')).toBe(false);
  });

  // The boundary itself. `>= 2` mutated to `> 2` survived until this existed,
  // and it would have reclassified `k2 -> dreamina-seedance-2.0-720p` and every
  // other two-character shared token.
  it('accepts a two-character token, which is the boundary', () => {
    expect(isIdentityToken('hy')).toBe(true);
  });

  // `hunyuan-hy3-preview` -> `hy4-preview` shares nothing but this word.
  it('rejects a release-channel word', () => {
    expect(isIdentityToken('preview')).toBe(false);
  });

  it('accepts a token that merely contains a channel word', () => {
    expect(isIdentityToken('previewer')).toBe(true);
  });
});

describe('CHANNEL_TOKENS', () => {
  // Pinned as a set rather than spot-checked. Every member of this list moves a
  // pair from variant to reveal when the two names share only that word, so the
  // list IS the filter's behaviour and an unasserted member is a silent one.
  it('holds exactly the eighteen release-channel words', () => {
    expect([...CHANNEL_TOKENS].sort()).toEqual([
      'alpha',
      'beta',
      'chat',
      'exp',
      'experimental',
      'free',
      'high',
      'instruct',
      'latest',
      'low',
      'max',
      'medium',
      'mini',
      'preview',
      'pro',
      'rc',
      'thinking',
      'xhigh',
    ]);
  });

  it('rejects every one of them as an identity token', () => {
    expect([...CHANNEL_TOKENS].filter((t) => isIdentityToken(t))).toEqual([]);
  });
});

describe('isLabelVariant', () => {
  it('calls a suffix addition a variant', () => {
    expect(isLabelVariant('grok-4.6', 'grok-4.6-xhigh')).toBe(true);
  });

  it('calls a trailing date stamp a variant', () => {
    expect(isLabelVariant('deepseek-v4-flash', 'deepseek-v4-flash-20260731')).toBe(true);
  });

  it('calls a parenthetical a variant', () => {
    expect(isLabelVariant('glm-5.3', 'glm-5.3 (max)')).toBe(true);
  });

  it('calls a no-system-prompt suffix a variant', () => {
    expect(isLabelVariant('gpt-5.4-no-system-prompt', 'gpt-5.4')).toBe(true);
  });

  it('does not call an animal codename a variant', () => {
    expect(isLabelVariant('significant-otter', 'gemma-4-26b-a4b')).toBe(false);
  });

  it('does not call a shared bare date stamp a variant', () => {
    expect(isLabelVariant('anonymous-0410', 'openhard-1.0-search-non-reasoning-0410')).toBe(false);
  });

  it('does not call a shared release channel a variant', () => {
    expect(isLabelVariant('hunyuan-hy3-preview', 'hy4-preview')).toBe(false);
  });
});

describe('isCodenameReveal over the whole live capture', () => {
  it('agrees with the hand classification on all 57 pairs', () => {
    const wrong = livePairs()
      .filter((p) => isCodenameReveal(p.publicName, p.displayName) !== (p.expected === 'reveal'))
      .map((p) => `${p.publicName} -> ${p.displayName}`);
    expect(wrong).toEqual([]);
  });

  // The exact rows the spec records a positive "nonsense word or animal name"
  // filter as missing. Named individually, because the aggregate above would
  // still pass if all seven flipped and seven variants flipped the other way.
  it('reveals every one of the seven rows a positive filter misses', () => {
    const pairs = new Map(livePairs().map((p) => [p.publicName, p.displayName]));
    const misses = ['anonymous-0410', 'k2', 'cold_brew', 'onyx-v1-4', 'lo-bah-png', 'nonnas-meatballs-open-weight', 'may-alpha'];
    const notRevealed = misses.filter((n) => !isCodenameReveal(n, pairs.get(n) ?? ''));
    expect(notRevealed).toEqual([]);
  });

  it('treats a pair with no displayName as not a reveal', () => {
    expect(isCodenameReveal('cold_brew', '')).toBe(false);
  });

  it('treats a pair whose two names are identical as not a reveal', () => {
    expect(isCodenameReveal('cold_brew', 'cold_brew')).toBe(false);
  });

  // A single-character name shares no IDENTITY token with itself, so the
  // variant filter cannot catch this one and the equality test is the only
  // thing that does. Mutation testing found that test surviving deletion while
  // the multi-token case above stayed green.
  it('treats a single-character name equal to its own displayName as not a reveal', () => {
    expect(isCodenameReveal('x', 'x')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// arena extraction
// ---------------------------------------------------------------------------

describe('arenaCodenameMap', () => {
  it('reads the publicName to displayName pair out of the escaped payload', () => {
    expect(arenaCodenameMap(arenaDoc([['cold_brew', 'muse-video']])).get('cold_brew')).toBe('muse-video');
  });

  // 29 distinct names out of 34 records in the slice: the payload repeats a
  // name across flight chunks and the map keys on the name, so this number
  // being the record count instead would mean the dedupe had stopped working.
  it('reads 29 distinct names out of the live slice', () => {
    const slice = fs.readFileSync('test/fixtures/arena-flight-slice.txt', 'utf8');
    expect(arenaCodenameMap(slice).size).toBe(29);
  });

  it('reads the cold_brew reveal out of the live slice', () => {
    const slice = fs.readFileSync('test/fixtures/arena-flight-slice.txt', 'utf8');
    expect(arenaCodenameMap(slice).get('cold_brew')).toBe('muse-video');
  });

  // The predicate splits on modelKey too, because it is deciding whether ANY
  // record moved. The codename map must not, or a leaderboard row would be
  // filed as a picker pair.
  it('ignores a modelKey record', () => {
    const doc = `{\\"modelKey\\":\\"gpt-5\\",\\"modelDisplayName\\":\\"GPT-5\\"}`;
    expect(arenaCodenameMap(doc).size).toBe(0);
  });
});

describe('arena leaks', () => {
  it('reports a publicName that was not in the previous capture', () => {
    const items = leaksFromChange(arenaChange([['a', 'a']], [['a', 'a'], ['cold_brew', 'cold_brew']]));
    expect(items.map((i) => i.type)).toEqual(['codename_entered']);
  });

  it('names the new publicName as the subject', () => {
    const items = leaksFromChange(arenaChange([['a', 'a']], [['a', 'a'], ['cold_brew', 'cold_brew']]));
    expect(items[0]!.subject).toBe('cold_brew');
  });

  it('reports an unmask when the two names stop agreeing', () => {
    const items = leaksFromChange(arenaChange([['cold_brew', 'cold_brew']], [['cold_brew', 'muse-video']]));
    expect(items.map((i) => i.type)).toEqual(['codename_unmasked']);
  });

  it('records the displayName the unmask moved from', () => {
    const items = leaksFromChange(arenaChange([['cold_brew', 'cold_brew']], [['cold_brew', 'muse-video']]));
    expect(items[0]!.facts).toContainEqual(['displayName before', 'cold_brew']);
  });

  it('records the displayName the unmask moved to', () => {
    const items = leaksFromChange(arenaChange([['cold_brew', 'cold_brew']], [['cold_brew', 'muse-video']]));
    expect(items[0]!.facts).toContainEqual(['displayName after', 'muse-video']);
  });

  // A model gaining `-high` is not an unmask, and reporting it as one is how
  // the desk publishes 22 non-events per cycle.
  it('reports no unmask when the new displayName is a label variant', () => {
    const items = leaksFromChange(arenaChange([['grok-4.6', 'grok-4.6']], [['grok-4.6', 'grok-4.6-high']]));
    expect(items).toEqual([]);
  });

  it('reports no unmask for a name that also entered in the same commit', () => {
    const items = leaksFromChange(arenaChange([], [['cold_brew', 'muse-video']]));
    expect(items.map((i) => i.type)).toEqual(['codename_entered']);
  });

  it('classifies an entering name that already carries a real displayName as a reveal', () => {
    const items = leaksFromChange(arenaChange([], [['cold_brew', 'muse-video']]));
    expect(items[0]!.facts).toContainEqual(['classification', 'reveal: the two names share no identity token']);
  });

  it('classifies an entering name that carries a variant displayName as a variant', () => {
    const items = leaksFromChange(arenaChange([], [['grok-4.6', 'grok-4.6-high']]));
    expect(items[0]!.facts).toContainEqual([
      'classification',
      'label variant: the two names share an identity token',
    ]);
  });

  it('reports nothing at all when no name moved', () => {
    expect(leaksFromChange(arenaChange([['a', 'a']], [['a', 'a']]))).toEqual([]);
  });

  // A reveal that was ALREADY revealed is not news, and dropping the
  // "did it move" half of the test republishes every standing reveal on every
  // commit for ever. Mutation testing found that half surviving.
  it('reports no unmask for a reveal that was already recorded in the previous capture', () => {
    expect(leaksFromChange(arenaChange([['cold_brew', 'muse-video']], [['cold_brew', 'muse-video']]))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the upstream pull request filter
// ---------------------------------------------------------------------------

describe('modelSupportName', () => {
  it('names the architecture in a plain Add X model support title', () => {
    expect(modelSupportName('Add Ovis2.5 model support')).toBe('Ovis2.5');
  });

  it('names a multi word architecture', () => {
    expect(modelSupportName('Add Cosmos3 Edge model support')).toBe('Cosmos3 Edge');
  });

  it('strips a leading bracket tag', () => {
    expect(modelSupportName('[Model] Add PP-DocLayoutV4 Model Support')).toBe('PP-DocLayoutV4');
  });

  it('stops the name before the word Models rather than swallowing it', () => {
    expect(modelSupportName('[Model] Add PP-OCRv6 Models Support')).toBe('PP-OCRv6');
  });

  it('handles the support-for word order', () => {
    expect(modelSupportName('Add support for RADIO models')).toBe('RADIO');
  });

  it('handles a lowercase qualifier between the name and the word models', () => {
    expect(modelSupportName('Add support for Quatfit1 multimodal models')).toBe('Quatfit1');
  });

  it('strips a conventional-commit prefix', () => {
    expect(modelSupportName('feat: Add Arcee model support')).toBe('Arcee');
  });

  // The whole reason for filtering on the shape rather than on "Add".
  it('rejects a plumbing title that names no architecture', () => {
    expect(modelSupportName('Add tiny_model_id support to ProcessorTesterMixin for memory-sensitive tests')).toBeNull();
  });

  it('rejects a title whose capitalised word is a kernel feature rather than a model', () => {
    expect(modelSupportName('Add GGUF support for MiniMax-M2.1 model')).toBeNull();
  });

  it('rejects an attention-implementation title', () => {
    expect(modelSupportName('Add Flash Attention support to Marian model')).toBeNull();
  });

  it('rejects a lowercase key_mapping title', () => {
    expect(modelSupportName('[`peft`] Support key_mapping with PEFT models')).toBeNull();
  });

  it('rejects a docs title that begins with neither Add nor Support', () => {
    expect(modelSupportName('[docs] Kernel supported models')).toBeNull();
  });

  // The maintainers' own tag is better evidence than a title regex, so a
  // tagged title is held to a weaker shape.
  it('accepts a tagged title with no word model in it', () => {
    expect(modelSupportName('[Model] Add Kimi K3 support: Rust frontend [1/2]')).toBe('Kimi K3');
  });

  it('rejects the same shape when no maintainer tag says it is a model', () => {
    expect(modelSupportName('Add GGUF support')).toBeNull();
  });

  it('rejects a tagged title whose first word after Support is lowercase', () => {
    expect(modelSupportName('[Model] Support `use_cache=False` for DeepSeek V4')).toBeNull();
  });

  // The commit prefix is stripped only from the FRONT. Without the anchor a
  // title mentioning `fix:` halfway through would have its head eaten.
  it('does not strip a commit-prefix word from the middle of a title', () => {
    expect(modelSupportName('Add Arcee model support, fix: nothing else')).toBe('Arcee');
  });

  // The tag strip is anchored too, and a bracket later in the title is not a
  // tag: `[1/2]` at the end is a part marker.
  it('reads a title whose only bracket is a trailing part marker', () => {
    expect(modelSupportName('Add Arcee model support [1/2]')).toBe('Arcee');
  });

  it('does not treat a non-model bracket tag as a model tag', () => {
    expect(modelSupportName('[Bugfix] Add Eagle3 support')).toBeNull();
  });

  // A documented miss, asserted so it stays documented rather than becoming a
  // surprise. Giving up the capital readmits every plumbing title at once.
  it('misses a lowercase architecture name, which is the filter’s stated floor', () => {
    expect(modelSupportName('Add dots3-note Preview model support')).toBeNull();
  });
});

describe('parsePullSearch', () => {
  it('reads 18 rows out of the stored live payload', () => {
    const text = fs.readFileSync('test/fixtures/github-pulls-transformers.json', 'utf8');
    expect(parsePullSearch(text)).toHaveLength(18);
  });

  it('reads merged_at out of the search payload without a second fetch', () => {
    const text = fs.readFileSync('test/fixtures/github-pulls-transformers.json', 'utf8');
    const merged = parsePullSearch(text).filter((r) => r.mergedAt !== null);
    expect(merged.length).toBe(8);
  });

  it('reads null merged_at for a pull request that is still open', () => {
    const rows = parsePullSearch(pullDoc([{ number: 1, title: 'Add X model support' }]));
    expect(rows[0]!.mergedAt).toBeNull();
  });

  it('returns nothing for a body with no items array', () => {
    expect(parsePullSearch('{"message":"rate limited"}')).toEqual([]);
  });

  it('returns nothing for a body that is not JSON', () => {
    expect(parsePullSearch('<html>429</html>')).toEqual([]);
  });

  it('drops an item with no numeric number', () => {
    expect(parsePullSearch('{"items":[{"number":"48387","title":"Add X model support"}]}')).toEqual([]);
  });
});

describe('upstream pull request leaks', () => {
  it('reports a model-support pull request that entered the window', () => {
    const items = leaksFromChange(pullChange([], [{ number: 48387, title: 'Add Ovis2.5 model support' }]));
    expect(items.map((i) => i.type)).toEqual(['upstream_pr_opened']);
  });

  it('subjects the item on the repository and number', () => {
    const items = leaksFromChange(pullChange([], [{ number: 48387, title: 'Add Ovis2.5 model support' }]));
    expect(items[0]!.subject).toBe('huggingface/transformers#48387');
  });

  it('records the architecture the title named', () => {
    const items = leaksFromChange(pullChange([], [{ number: 48387, title: 'Add Ovis2.5 model support' }]));
    expect(items[0]!.facts).toContainEqual(['architecture named in the title', 'Ovis2.5']);
  });

  it('ignores a pull request whose title names no architecture', () => {
    expect(leaksFromChange(pullChange([], [{ number: 47005, title: 'Add tiny_model_id support to ProcessorTesterMixin' }]))).toEqual([]);
  });

  // `state` cannot stand in for `merged_at`: an abandoned attempt and a landed
  // runtime commit are both `closed`.
  it('reports a merge when merged_at goes from null to a date', () => {
    const before = [{ number: 47181, title: 'Add Cosmos3 Edge model support' }];
    const after = [{ number: 47181, title: 'Add Cosmos3 Edge model support', state: 'closed', merged_at: '2026-07-16T18:43:59Z' }];
    expect(leaksFromChange(pullChange(before, after)).map((i) => i.type)).toEqual(['upstream_pr_merged']);
  });

  it('reports no merge for a pull request that closed without merging', () => {
    const before = [{ number: 47081, title: 'Add Quatfit1 multimodal models' }];
    const after = [{ number: 47081, title: 'Add Quatfit1 multimodal models', state: 'closed' }];
    expect(leaksFromChange(pullChange(before, after))).toEqual([]);
  });

  it('records the merge date as a fact', () => {
    const before = [{ number: 47181, title: 'Add Cosmos3 Edge model support' }];
    const after = [{ number: 47181, title: 'Add Cosmos3 Edge model support', state: 'closed', merged_at: '2026-07-16T18:43:59Z' }];
    expect(leaksFromChange(pullChange(before, after))[0]!.facts).toContainEqual(['merged_at', '2026-07-16T18:43:59Z']);
  });

  it('reports a merge only once, on the commit that recorded the date', () => {
    const merged = [{ number: 47181, title: 'Add Cosmos3 Edge model support', state: 'closed', merged_at: '2026-07-16T18:43:59Z' }];
    expect(leaksFromChange(pullChange(merged, merged))).toEqual([]);
  });

  it('names the vllm repository for the vllm source', () => {
    const items = leaksFromChange(pullChange([], [{ number: 55, title: 'Add Spark3 model support' }], 'vllm-pulls'));
    expect(items[0]!.subject).toBe('vllm-project/vllm#55');
  });

  it('reports nothing for a source id that is not a known repository', () => {
    expect(leaksFromChange(pullChange([], [{ number: 1, title: 'Add Ovis2.5 model support' }], 'openai-llms-txt'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// OpenRouter stealth/ and expiration_date
// ---------------------------------------------------------------------------

describe('isStealthListing', () => {
  it('accepts an id under the stealth namespace', () => {
    expect(isStealthListing('stealth/sonnet-x', null)).toBe(true);
  });

  it('rejects an id that merely contains the word stealth', () => {
    expect(isStealthListing('acme/stealth-mode-7', null)).toBe(false);
  });

  // The kilo provider prefixes DISCOUNTED listings with stealth/, so a bare
  // prefix test files a price promotion as an unreleased model.
  it('rejects the kilo naming collision by its id', () => {
    expect(isStealthListing('stealth/kilo-fast', null)).toBe(false);
  });

  it('rejects the kilo naming collision by its display name', () => {
    expect(isStealthListing('stealth/fast-1', 'Kilo discounted route')).toBe(false);
  });
});

describe('isExpirationSentinel', () => {
  // Four of the six non-null expiration_date values in the stored catalog are
  // this, all under one vendor. It is that vendor spelling "no expiry".
  it('reads a far-future date as a sentinel', () => {
    expect(isExpirationSentinel('2098-12-31')).toBe(true);
  });

  it('reads a near-term date as a real expiry', () => {
    expect(isExpirationSentinel('2026-09-30')).toBe(false);
  });

  it('reads the sentinel year itself as a sentinel', () => {
    expect(isExpirationSentinel(`${EXPIRATION_SENTINEL_YEAR}-01-01`)).toBe(true);
  });

  it('reads the year below the sentinel as a real expiry', () => {
    expect(isExpirationSentinel(`${EXPIRATION_SENTINEL_YEAR - 1}-12-31`)).toBe(false);
  });
});

describe('parseCatalogLeaks', () => {
  it('reads a model id out of the catalog', () => {
    expect(parseCatalogLeaks(catalog([{ id: 'anthropic/claude-opus-5' }]))[0]!.id).toBe('anthropic/claude-opus-5');
  });

  // parseCatalog THROWS here, which is right for the changelog and wrong for a
  // desk that prints a per-signal count on its own page.
  it('returns nothing rather than throwing on a body with no data array', () => {
    expect(parseCatalogLeaks('{"error":"upstream"}')).toEqual([]);
  });
});

describe('catalog leaks', () => {
  it('reports an id that appeared under the stealth namespace', () => {
    const items = leaksFromChange(
      change({ before: catalog([{ id: 'a/b' }]), after: catalog([{ id: 'a/b' }, { id: 'stealth/sonnet-x' }]) }),
    );
    expect(items.map((i) => i.type)).toEqual(['stealth_listing']);
  });

  // Without the "was it there before" half, every standing stealth id is
  // republished on every commit that touches the catalog.
  it('reports nothing for a stealth id that was already in the previous capture', () => {
    const both = catalog([{ id: 'stealth/sonnet-x' }]);
    expect(leaksFromChange(change({ before: both, after: both + ' ' }))).toEqual([]);
  });

  it('reports nothing for an ordinary model appearing', () => {
    const items = leaksFromChange(
      change({ before: catalog([{ id: 'a/b' }]), after: catalog([{ id: 'a/b' }, { id: 'openai/gpt-6' }]) }),
    );
    expect(items).toEqual([]);
  });

  it('reports an expiration_date going from absent to a near-term date', () => {
    const items = leaksFromChange(
      change({
        before: catalog([{ id: 'a/b' }]),
        after: catalog([{ id: 'a/b', expiration_date: '2026-09-30' }]),
      }),
    );
    expect(items.map((i) => i.type)).toEqual(['expiration_scheduled']);
  });

  it('reports nothing for an expiration_date set to the vendor sentinel', () => {
    const items = leaksFromChange(
      change({
        before: catalog([{ id: 'a/b' }]),
        after: catalog([{ id: 'a/b', expiration_date: '2098-12-31' }]),
      }),
    );
    expect(items).toEqual([]);
  });

  it('reports nothing when an expiration_date merely moved', () => {
    const items = leaksFromChange(
      change({
        before: catalog([{ id: 'a/b', expiration_date: '2026-09-30' }]),
        after: catalog([{ id: 'a/b', expiration_date: '2026-10-31' }]),
      }),
    );
    expect(items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the dispatcher
// ---------------------------------------------------------------------------

describe('leaksFromChange', () => {
  // The same refusal src/derive/events.ts makes: with no before, reporting
  // 1,029 codenames as having entered testing today would be 1,029 false
  // claims with honest artifact links attached.
  // `before` is deliberately NON-null here, so the only thing that can stop
  // this is the kind check. With `before: null` as well, the second guard
  // catches it and the kind check goes untested, which is what mutation
  // testing found: the kind arm survived replacement.
  it('emits nothing at all for a baseline capture, even when a before is present', () => {
    const baseline = { ...arenaChange([['a', 'a']], [['cold_brew', 'muse-video']]), kind: 'added' as const };
    expect(leaksFromChange(baseline)).toEqual([]);
  });

  it('emits nothing for a modified change that carries no before', () => {
    expect(leaksFromChange({ ...arenaChange([], [['cold_brew', 'muse-video']]), before: null })).toEqual([]);
  });

  it('emits nothing for a source it holds no reader for', () => {
    expect(leaksFromChange(change({ sourceId: 'claude-status', before: 'a', after: 'b' }))).toEqual([]);
  });
});

/**
 * THE COLLAPSE GUARD, which is the difference between a quiet week and a
 * thousand false claims.
 *
 * The predicate's own floor does not protect this. It counts the UNION of
 * `modelKey` and `publicName` records, 1,846 live, while the codename map reads
 * `publicName` alone, 1,029 live. A payload of 600 modelKey records and one
 * publicName record passes the predicate and leaves the map holding one name,
 * so a picker reshape that moves publicName into a lazily loaded chunk is
 * invisible upstream. When the shape recovers, every name in the map has no
 * previous value and reads as newly entered.
 */
describe('the arena codename floor', () => {
  const pair = (n: number): [string, string] => [`filler-${String(n).padStart(4, '0')}`, `filler-${String(n).padStart(4, '0')}`];
  const atFloor = Array.from({ length: ARENA_CODENAME_FLOOR }, (_, i) => pair(i));
  const belowFloor = atFloor.slice(0, ARENA_CODENAME_FLOOR - 1);

  it('derives nothing across a change whose before capture is below the floor', () => {
    const collapsed = unpaddedArenaChange(belowFloor, [...atFloor, ['cold_brew', 'muse-video']]);
    expect(leaksFromChange(collapsed)).toEqual([]);
  });

  it('derives nothing across a change whose after capture is below the floor', () => {
    const collapsing = unpaddedArenaChange([...atFloor, ['cold_brew', 'cold_brew']], belowFloor);
    expect(leaksFromChange(collapsing)).toEqual([]);
  });

  it('derives normally at exactly the floor', () => {
    const ok = unpaddedArenaChange(atFloor, [...atFloor, ['cold_brew', 'cold_brew']]);
    expect(leaksFromChange(ok).map((i) => i.type)).toEqual(['codename_entered']);
  });

  // A refusal and a quiet week both produce zero items, so the refusal is the
  // only thing that tells them apart and it has to be emitted, not just implied
  // by the absence of items.
  it('records one refusal for the change it declined to derive from', () => {
    const collapsed = unpaddedArenaChange(belowFloor, atFloor);
    expect(leakResult(collapsed).refusals).toHaveLength(1);
  });

  it('names both measured sizes and the floor in the refusal', () => {
    const collapsed = unpaddedArenaChange(belowFloor, atFloor);
    expect(leakResult(collapsed).refusals[0]?.reason).toBe(
      `the codename map holds ${ARENA_CODENAME_FLOOR - 1} publicName records before this change and ${ARENA_CODENAME_FLOOR} after, ` +
        `and the floor is ${ARENA_CODENAME_FLOOR}. Nothing is derived across a change where either side is below it.`,
    );
  });

  it('points the refusal at the artifact and commit it refused', () => {
    const collapsed = unpaddedArenaChange(belowFloor, atFloor);
    expect(leakResult(collapsed).refusals[0]?.path).toBe('raw/arena-leaderboard/response.html');
  });

  it('records no refusal for a change it derived from', () => {
    const ok = unpaddedArenaChange(atFloor, [...atFloor, ['cold_brew', 'cold_brew']]);
    expect(leakResult(ok).refusals).toEqual([]);
  });

  // The flood this exists to stop, measured rather than described: without the
  // guard a recovery emits one codename_entered per name in the map.
  it('would otherwise emit one item per name in the recovered map', () => {
    const recovered = unpaddedArenaChange(atFloor, atFloor.map(([n]) => [n, n] as [string, string]).concat([['cold_brew', 'cold_brew']]));
    expect(leaksFromChange(recovered)).toHaveLength(1);
  });

  it('refuses a baseline capture without reporting it as a floor refusal', () => {
    const baseline = change({
      sourceId: 'arena-leaderboard',
      path: 'raw/arena-leaderboard/response.html',
      kind: 'added',
      before: null,
      after: arenaDoc(atFloor),
    });
    expect(leakResult(baseline).refusals).toEqual([]);
  });
});

describe('deriveLeakRefusals', () => {
  const pair = (n: number): [string, string] => [`f-${n}`, `f-${n}`];
  const atFloor = Array.from({ length: ARENA_CODENAME_FLOOR }, (_, i) => pair(i));
  const belowFloor = atFloor.slice(0, 10);

  it('collects a refusal from every change that produced one', () => {
    const changes = [unpaddedArenaChange(belowFloor, atFloor), unpaddedArenaChange(atFloor, belowFloor)];
    expect(deriveLeakRefusals(changes)).toHaveLength(2);
  });

  it('collects nothing from changes that all derived cleanly', () => {
    expect(deriveLeakRefusals([unpaddedArenaChange(atFloor, atFloor)])).toEqual([]);
  });
});

describe('deriveLeaks', () => {
  it('orders items newest stamp first', () => {
    const older = { ...arenaChange([], [['a', 'a']]), sha: '1'.repeat(40), stamp: { iso: '2026-08-01T00:00:00Z', kind: 'origin' as const } };
    const newer = { ...arenaChange([], [['b', 'b']]), sha: '2'.repeat(40), stamp: { iso: '2026-08-20T00:00:00Z', kind: 'origin' as const } };
    expect(deriveLeaks([older, newer]).map((i) => i.subject)).toEqual(['b', 'a']);
  });

  it('breaks a stamp tie on the item id rather than on input order', () => {
    const stamp = { iso: '2026-08-01T00:00:00Z', kind: 'origin' as const };
    const b = { ...arenaChange([], [['b', 'b']]), sha: '2'.repeat(40), stamp };
    const a = { ...arenaChange([], [['a', 'a']]), sha: '1'.repeat(40), stamp };
    expect(deriveLeaks([b, a]).map((i) => i.subject)).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// the claim forms
// ---------------------------------------------------------------------------

function itemOf(over: Partial<LeakItem>): LeakItem {
  return {
    id: 'x',
    type: 'codename_entered',
    tier: 'confirmed-artifact',
    sha: 'a'.repeat(40),
    sourceId: 'arena-leaderboard',
    path: 'raw/arena-leaderboard/response.html',
    stamp: null,
    subject: 'cold_brew',
    facts: [],
    ...over,
  } as LeakItem;
}

describe('leakSentence', () => {
  it('describes an entering codename as a name appearing in a payload', () => {
    expect(leakSentence(itemOf({ type: 'codename_entered', subject: 'cold_brew' }))).toBe(
      'A model named "cold_brew" appears in arena.ai\'s leaderboard payload.',
    );
  });

  it('describes an unmask as the recorded displayName changing', () => {
    expect(leakSentence(itemOf({ type: 'codename_unmasked', subject: 'cold_brew' }))).toBe(
      'The displayName recorded beside the publicName "cold_brew" in arena.ai\'s leaderboard payload changed, and the two names no longer share an identity token.',
    );
  });

  it('describes an opened pull request by its title', () => {
    const item = itemOf({
      type: 'upstream_pr_opened',
      subject: 'huggingface/transformers#48387',
      facts: [['title', 'Add Ovis2.5 model support']],
    });
    expect(leakSentence(item)).toBe(
      'A pull request numbered "huggingface/transformers#48387" is titled "Add Ovis2.5 model support" in the collected search payload.',
    );
  });

  it('describes a merge by the merged_at the payload recorded', () => {
    const item = itemOf({
      type: 'upstream_pr_merged',
      subject: 'huggingface/transformers#47181',
      facts: [['merged_at', '2026-07-16T18:43:59Z']],
    });
    expect(leakSentence(item)).toBe(
      'The pull request numbered "huggingface/transformers#47181" records a merged_at of "2026-07-16T18:43:59Z" in the collected search payload.',
    );
  });

  it('describes a stealth listing as the catalog listing an id', () => {
    expect(leakSentence(itemOf({ type: 'stealth_listing', subject: 'stealth/sonnet-x' }))).toBe(
      'OpenRouter\'s catalog lists an id under the stealth/ namespace: "stealth/sonnet-x".',
    );
  });

  it('describes a scheduled expiration as the catalog recording a date', () => {
    const item = itemOf({
      type: 'expiration_scheduled',
      subject: 'dots-studio/dots-3-note-preview:free',
      facts: [['expiration_date', '2026-09-30']],
    });
    expect(leakSentence(item)).toBe(
      'OpenRouter\'s catalog recorded an expiration_date of "2026-09-30" for "dots-studio/dots-3-note-preview:free".',
    );
  });

  it('names the missing label rather than printing an empty gap', () => {
    expect(leakSentence(itemOf({ type: 'upstream_pr_merged', subject: 'r#1', facts: [] }))).toContain(
      '<merged_at not recorded>',
    );
  });
});

/**
 * The fact LABELS are a contract, not decoration. src/site/render.ts finds a
 * pull request's title by the label `title` in order to build the confirmation
 * query, and leakSentence finds `merged_at` and `expiration_date` the same way.
 * A renamed label makes the sentence print `<merged_at not recorded>` on a page
 * that has the date sitting in the row above it.
 */
describe('the fact labels every item carries', () => {
  const labels = (items: LeakItem[]): string[] => items.flatMap((i) => i.facts.map(([k]) => k));

  it('labels an entering codename with its two names and a classification', () => {
    expect(labels(leaksFromChange(arenaChange([], [['cold_brew', 'muse-video']])))).toEqual([
      'publicName',
      'displayName',
      'classification',
    ]);
  });

  it('labels an unmask with the name and both sides of the displayName', () => {
    expect(labels(leaksFromChange(arenaChange([['cold_brew', 'cold_brew']], [['cold_brew', 'muse-video']])))).toEqual([
      'publicName',
      'displayName before',
      'displayName after',
    ]);
  });

  it('labels an opened pull request with the five shared rows plus created_at and state', () => {
    expect(labels(leaksFromChange(pullChange([], [{ number: 1, title: 'Add Arcee model support' }])))).toEqual([
      'repository',
      'pull request',
      'title',
      'architecture named in the title',
      'pull request URL',
      'created_at',
      'state',
    ]);
  });

  it('labels a merged pull request with the five shared rows plus merged_at', () => {
    const before = [{ number: 1, title: 'Add Arcee model support' }];
    const after = [{ number: 1, title: 'Add Arcee model support', merged_at: '2026-07-16T18:43:59Z' }];
    expect(labels(leaksFromChange(pullChange(before, after)))).toEqual([
      'repository',
      'pull request',
      'title',
      'architecture named in the title',
      'pull request URL',
      'merged_at',
    ]);
  });

  it('labels a stealth listing with the id, the name and the expiration', () => {
    const items = leaksFromChange(
      change({ before: catalog([{ id: 'a/b' }]), after: catalog([{ id: 'a/b' }, { id: 'stealth/x' }]) }),
    );
    expect(labels(items)).toEqual(['catalog id', 'catalog name', 'expiration_date']);
  });

  it('labels a scheduled expiration with the id, the date and the sentinel note', () => {
    const items = leaksFromChange(
      change({ before: catalog([{ id: 'a/b' }]), after: catalog([{ id: 'a/b', expiration_date: '2026-09-30' }]) }),
    );
    expect(labels(items)).toEqual(['catalog id', 'expiration_date', 'sentinel check']);
  });

  it('records the pull request URL the payload carried', () => {
    const items = leaksFromChange(pullChange([], [{ number: 48387, title: 'Add Arcee model support' }]));
    expect(items[0]!.facts).toContainEqual([
      'pull request URL',
      'https://github.com/huggingface/transformers/pull/48387',
    ]);
  });

  it('says the URL was not recorded rather than printing an empty cell', () => {
    const doc = '{"items":[{"number":9,"title":"Add Arcee model support","state":"open"}]}';
    const c = change({ sourceId: 'transformers-pulls', path: 'raw/transformers-pulls/response.json', before: '{"items":[]}', after: doc });
    expect(leaksFromChange(c)[0]!.facts).toContainEqual(['pull request URL', 'not recorded']);
  });
});

/**
 * The item id is `<sha>:<type>:<subject>`, and it is the thing that makes an
 * item unique within a commit. A collision would fold two claims into one row.
 */
describe('the item id every leak carries', () => {
  it('ids an entering codename by its sha, type and name', () => {
    const items = leaksFromChange(arenaChange([], [['cold_brew', 'muse-video']]));
    expect(items[0]!.id).toBe(`${SHA}:codename_entered:cold_brew`);
  });

  it('ids an unmask by its sha, type and name', () => {
    const items = leaksFromChange(arenaChange([['cold_brew', 'cold_brew']], [['cold_brew', 'muse-video']]));
    expect(items[0]!.id).toBe(`${SHA}:codename_unmasked:cold_brew`);
  });

  it('ids an opened pull request by its sha, type, repository and number', () => {
    const items = leaksFromChange(pullChange([], [{ number: 48387, title: 'Add Arcee model support' }]));
    expect(items[0]!.id).toBe(`${SHA}:upstream_pr_opened:huggingface/transformers#48387`);
  });

  it('ids a merged pull request by its sha, type, repository and number', () => {
    const before = [{ number: 47181, title: 'Add Arcee model support' }];
    const after = [{ number: 47181, title: 'Add Arcee model support', merged_at: '2026-07-16T18:43:59Z' }];
    expect(leaksFromChange(pullChange(before, after))[0]!.id).toBe(
      `${SHA}:upstream_pr_merged:huggingface/transformers#47181`,
    );
  });

  it('ids a stealth listing by its sha, type and catalog id', () => {
    const items = leaksFromChange(
      change({ before: catalog([{ id: 'a/b' }]), after: catalog([{ id: 'a/b' }, { id: 'stealth/x' }]) }),
    );
    expect(items[0]!.id).toBe(`${SHA}:stealth_listing:stealth/x`);
  });

  it('ids a scheduled expiration by its sha, type and catalog id', () => {
    const items = leaksFromChange(
      change({ before: catalog([{ id: 'a/b' }]), after: catalog([{ id: 'a/b', expiration_date: '2026-09-30' }]) }),
    );
    expect(items[0]!.id).toBe(`${SHA}:expiration_scheduled:a/b`);
  });

  // Every derived item is confirmed-artifact and nothing here can produce
  // another tier: a machine reading stored bytes cannot be the thing that
  // vouches for a source's track record.
  it('tiers every derivable item as confirmed-artifact', () => {
    const all = [
      ...leaksFromChange(arenaChange([['c', 'c']], [['c', 'muse-video'], ['n', 'n']])),
      ...leaksFromChange(pullChange([], [{ number: 1, title: 'Add Arcee model support' }])),
      ...leaksFromChange(change({ before: catalog([{ id: 'a/b' }]), after: catalog([{ id: 'a/b' }, { id: 'stealth/x' }]) })),
    ];
    expect([...new Set(all.map((i) => i.tier))]).toEqual(['confirmed-artifact']);
  });
});

/**
 * What a row that is missing a field renders as. Every one of these is a value
 * a reader compares against the linked artifact, so an empty cell and a value
 * of "absent" are different statements and the second is the true one.
 */
describe('the absent-value spellings', () => {
  it('says absent for an entering codename with no displayName at all', () => {
    const items = leaksFromChange(arenaChange([], [['cold_brew', '']]));
    expect(items[0]!.facts).toContainEqual(['displayName', 'absent']);
  });

  it('says so in words when an entering codename carries no displayName', () => {
    const items = leaksFromChange(arenaChange([], [['cold_brew', '']]));
    expect(items[0]!.facts).toContainEqual(['classification', 'no displayName recorded beside it']);
  });

  it('says absent for an unmask whose previous displayName was empty', () => {
    const items = leaksFromChange(arenaChange([['cold_brew', '']], [['cold_brew', 'muse-video']]));
    expect(items[0]!.facts).toContainEqual(['displayName before', 'absent']);
  });

  it('says not recorded for a pull request with no created_at', () => {
    const doc = '{"items":[{"number":9,"title":"Add Arcee model support","state":"open"}]}';
    const c = change({ sourceId: 'transformers-pulls', path: 'raw/transformers-pulls/response.json', before: '{"items":[]}', after: doc });
    expect(leaksFromChange(c)[0]!.facts).toContainEqual(['created_at', 'not recorded']);
  });

  it('says absent for a stealth listing whose catalog name is missing', () => {
    const after = '{"data":[{"id":"stealth/x"}]}';
    expect(leaksFromChange(change({ before: '{"data":[]}', after }))[0]!.facts).toContainEqual(['catalog name', 'absent']);
  });

  it('says absent for a stealth listing with no expiration_date', () => {
    const after = '{"data":[{"id":"stealth/x"}]}';
    expect(leaksFromChange(change({ before: '{"data":[]}', after }))[0]!.facts).toContainEqual(['expiration_date', 'absent']);
  });
});

/**
 * The type narrowing, exercised rather than assumed. These are stored bytes
 * from a third party and every field can arrive as the wrong type; the
 * alternative to a test here is a page printing `[object Object]` beside an
 * honest artifact link.
 */
describe('rows whose fields arrive as the wrong type', () => {
  const pullAfter = (item: string) => change({
    sourceId: 'transformers-pulls',
    path: 'raw/transformers-pulls/response.json',
    before: '{"items":[]}',
    after: `{"items":[${item}]}`,
  });

  it('drops an item whose title is not a string', () => {
    expect(parsePullSearch('{"items":[{"number":1,"title":42}]}')).toEqual([]);
  });

  it('reads a non-string state as the empty string', () => {
    const items = leaksFromChange(pullAfter('{"number":1,"title":"Add Arcee model support","state":7}'));
    expect(items[0]!.facts).toContainEqual(['state', '']);
  });

  it('reads a non-string created_at as absent', () => {
    const items = leaksFromChange(pullAfter('{"number":1,"title":"Add Arcee model support","created_at":7}'));
    expect(items[0]!.facts).toContainEqual(['created_at', 'not recorded']);
  });

  it('reads a non-string html_url as absent', () => {
    const items = leaksFromChange(pullAfter('{"number":1,"title":"Add Arcee model support","html_url":7}'));
    expect(items[0]!.facts).toContainEqual(['pull request URL', 'not recorded']);
  });

  it('reads a non-string merged_at as no merge at all', () => {
    const before = '{"items":[{"number":1,"title":"Add Arcee model support"}]}';
    const after = '{"items":[{"number":1,"title":"Add Arcee model support","pull_request":{"merged_at":7}}]}';
    const c = change({ sourceId: 'transformers-pulls', path: 'raw/transformers-pulls/response.json', before, after });
    expect(leaksFromChange(c)).toEqual([]);
  });

  it('drops a catalog entry whose id is not a string', () => {
    expect(parseCatalogLeaks('{"data":[{"id":42}]}')).toEqual([]);
  });

  it('drops a catalog entry whose id is the empty string', () => {
    expect(parseCatalogLeaks('{"data":[{"id":""}]}')).toEqual([]);
  });

  it('drops a catalog entry that is not an object', () => {
    expect(parseCatalogLeaks('{"data":["a/b"]}')).toEqual([]);
  });

  it('reads a non-string catalog name as absent', () => {
    const items = leaksFromChange(change({ before: '{"data":[]}', after: '{"data":[{"id":"stealth/x","name":7}]}' }));
    expect(items[0]!.facts).toContainEqual(['catalog name', 'absent']);
  });

  it('reads a non-string expiration_date as no expiration at all', () => {
    const before = '{"data":[{"id":"a/b"}]}';
    const after = '{"data":[{"id":"a/b","expiration_date":20260930}]}';
    expect(leaksFromChange(change({ before, after }))).toEqual([]);
  });
});

describe('confirmationQuery', () => {
  it('builds the huggingface search url for a name', () => {
    expect(confirmationQuery('Ovis2.5')).toBe('https://huggingface.co/api/models?search=Ovis2.5');
  });

  it('percent-encodes a name carrying a space', () => {
    expect(confirmationQuery('Cosmos3 Edge')).toBe('https://huggingface.co/api/models?search=Cosmos3%20Edge');
  });
});
