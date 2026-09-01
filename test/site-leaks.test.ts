import { describe, it, expect } from 'vitest';
import { renderLeaksPage, renderLedgerPage, LEAKS_INDEX_PATH, LEDGER_PATH } from '../src/site/render.js';
import { buildSite } from '../src/site/build.js';
import { parseLedger } from '../src/site/ledger.js';
import { leakSentence, type LeakItem, type LeakRefusal } from '../src/derive/leaks.js';
import { escapeHtml, type Stamp } from '../src/site/record.js';

const SHA = 'a69a068319de9dc9a7ab1049b411a562a026e7d5';
const ORIGIN: Stamp = { iso: '2026-08-28T08:08:22.000Z', kind: 'origin' };

function item(over: Partial<LeakItem>): LeakItem {
  return {
    id: `${SHA}:codename_entered:cold_brew`,
    type: 'codename_entered',
    tier: 'confirmed-artifact',
    sha: SHA,
    sourceId: 'arena-leaderboard',
    path: 'raw/arena-leaderboard/response.html',
    stamp: ORIGIN,
    subject: 'cold_brew',
    facts: [['publicName', 'cold_brew']],
    ...over,
  } as LeakItem;
}

/**
 * One item of every derivable kind, so the copy-rule scan below is run over
 * every sentence the generator can produce rather than over the one kind that
 * happens to be in the archive today.
 */
const ALL_KINDS: LeakItem[] = [
  item({ type: 'codename_entered', subject: 'cold_brew' }),
  item({ type: 'codename_unmasked', subject: 'cold_brew', facts: [['displayName after', 'muse-video']] }),
  item({
    type: 'upstream_pr_opened',
    sourceId: 'transformers-pulls',
    path: 'raw/transformers-pulls/response.json',
    subject: 'huggingface/transformers#48387',
    facts: [['title', 'Add Ovis2.5 model support'], ['architecture named in the title', 'Ovis2.5']],
  }),
  item({
    type: 'upstream_pr_merged',
    sourceId: 'vllm-pulls',
    path: 'raw/vllm-pulls/response.json',
    subject: 'vllm-project/vllm#47181',
    facts: [['title', 'Add Cosmos3 Edge model support'], ['merged_at', '2026-07-16T18:43:59Z']],
  }),
  item({
    type: 'stealth_listing',
    sourceId: 'openrouter-models',
    path: 'raw/openrouter-models/response.json',
    subject: 'stealth/sonnet-x',
  }),
  item({
    type: 'expiration_scheduled',
    sourceId: 'openrouter-models',
    path: 'raw/openrouter-models/response.json',
    subject: 'dots-studio/dots-3-note-preview:free',
    facts: [['expiration_date', '2026-09-30']],
  }),
];

// ---------------------------------------------------------------------------
// the copy rule, as a detector
// ---------------------------------------------------------------------------

/**
 * Every company, lab and vendor whose name could plausibly reach a leaks page.
 *
 * A closed list, and the same reasoning src/derive/entities.ts uses for LABS:
 * an open one would mean inventing a company out of any capitalised token, and
 * the detector would then flag the architecture names the titles carry.
 */
const COMPANIES = [
  'OpenAI',
  'Anthropic',
  'Google',
  'Meta',
  'Mistral',
  'DeepSeek',
  'Alibaba',
  'Qwen',
  'xAI',
  'Moonshot',
  'MiniMax',
  'NVIDIA',
  'Cohere',
  'Perplexity',
  'Together',
  'Groq',
  'OpenRouter',
  'HuggingFace',
  'Hugging Face',
  'Microsoft',
  'Amazon',
  'ByteDance',
  'arena.ai',
];

/**
 * A verb that turns a company name into an actor.
 *
 * The list is deliberately of the verbs a leak story reaches for, because those
 * are the sentences that are wrong: "OpenAI deprecated the Assistants API",
 * "X is Y's next flagship", "Anthropic is testing a new model". A general
 * part-of-speech tagger would be more complete and would also be a dependency
 * whose behaviour nobody in this repository could state.
 */
const ACTOR_VERBS = [
  'is',
  'are',
  'was',
  'were',
  'has',
  'have',
  'had',
  'will',
  'would',
  'plans',
  'planned',
  'intends',
  'announced',
  'announces',
  'launched',
  'launches',
  'released',
  'releases',
  'shipped',
  'ships',
  'deprecated',
  'deprecates',
  'retired',
  'retires',
  'cut',
  'cuts',
  'raised',
  'lowered',
  'confirmed',
  'confirms',
  'denied',
  'denies',
  'said',
  'says',
  'built',
  'builds',
  'made',
  'makes',
  'renamed',
  'renames',
  'introduced',
  'introduces',
  'tested',
  'tests',
  'trained',
  'trains',
];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Sentences in which a company name is the subject of a verb.
 *
 * A possessive is NOT a violation and is the whole point of the allowed form:
 * "OpenRouter's catalog lists an id" names the catalog as the subject and the
 * company only as a modifier. The pattern requires WHITESPACE between the
 * company name and the verb, which is exactly what a possessive does not have,
 * whether it is written `OpenRouter's` or HTML-escaped to `OpenRouter&#39;s`,
 * and it is also what keeps `huggingface/transformers#48387` out.
 */
export function companySubjectViolations(text: string): string[] {
  const out: string[] = [];
  for (const company of COMPANIES) {
    const re = new RegExp(`\\b${escapeRe(company)}\\b\\s+(?:${ACTOR_VERBS.join('|')})\\b`, 'gi');
    for (const m of text.matchAll(re)) out.push(m[0]);
  }
  return out;
}

/**
 * The prose a page composed, with everything quoted out of the archive removed.
 *
 * The copy rule permits a company name inside a value read out of a stored
 * artifact: a pull request titled "OpenAI released a thing" is what the payload
 * says, and quoting it is describing an artifact rather than making the claim.
 * So table cells, code spans, and double-quoted runs inside a sentence are
 * dropped before the scan, and everything the generator wrote itself is kept.
 */
export function composedProse(html: string): string {
  return html
    .replace(/<td class="(?:mono|quoted)">[\s\S]*?<\/td>/g, ' ')
    .replace(/<code\b[\s\S]*?<\/code>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    // A NEGATIVE LOOKAHEAD RATHER THAN [^&], because a quoted archive value can
    // contain an entity of its own. `[^&]*?` stops at the first ampersand, so a
    // title carrying an apostrophe or an ampersand ends the run early, the
    // strip fails, and the rest of the value is scanned as though this file had
    // written it. Harmless against six hand-written fixtures and a source of
    // false alarms the moment the scan is pointed at real stored payloads,
    // which is exactly what the scans further down do.
    .replace(/&quot;(?:(?!&quot;)[\s\S])*?&quot;/g, ' ')
    .replace(/"[^"]*"/g, ' ');
}

describe('companySubjectViolations, the detector itself', () => {
  // The spec's own forbidden example, verbatim.
  it('flags a company deprecating an API', () => {
    expect(companySubjectViolations('OpenAI deprecated the Assistants API')).toEqual(['OpenAI deprecated']);
  });

  it('flags the next-flagship form', () => {
    expect(companySubjectViolations('Anthropic is preparing its next flagship')).toEqual(['Anthropic is']);
  });

  it('flags a company cutting a context window', () => {
    expect(companySubjectViolations("DeepSeek cut the model's usable context")).toEqual(['DeepSeek cut']);
  });

  it('flags a company as a subject regardless of case', () => {
    expect(companySubjectViolations('openrouter announced a change')).toEqual(['openrouter announced']);
  });

  // The allowed forms, one each. A detector that flagged these would be
  // unusable and the page would be rewritten around a false alarm.
  it('accepts a possessive in front of an artifact', () => {
    expect(companySubjectViolations("OpenRouter's catalog context_length changed from 1 to 2")).toEqual([]);
  });

  it('accepts an HTML-escaped possessive', () => {
    expect(companySubjectViolations('OpenRouter&#39;s catalog recorded an expiration_date')).toEqual([]);
  });

  it('accepts a company name inside a repository path', () => {
    expect(companySubjectViolations('A pull request in huggingface/transformers is titled X')).toEqual([]);
  });

  it('accepts a sentence whose subject is the artifact', () => {
    expect(companySubjectViolations('A model named "k2" appears in a leaderboard payload')).toEqual([]);
  });

  // The stripping in composedProse must not be able to swallow an unquoted
  // violation, or the scan below would be a scan of nothing.
  it('still sees a violation that survives the quoted-value stripping', () => {
    expect(companySubjectViolations(composedProse('<p>Google announced a model</p>'))).toEqual(['Google announced']);
  });

  it('drops a violation that sits inside a quoted archive value', () => {
    expect(companySubjectViolations(composedProse('<p>titled &quot;Google announced a model&quot;</p>'))).toEqual([]);
  });

  // A cell holding an archive value is marked, and only marked cells are
  // dropped. An unmarked cell is the ledger's own claim column, which is
  // human-written and has to stay in scope.
  it('drops a violation that sits inside a marked value cell', () => {
    expect(companySubjectViolations(composedProse('<td class="quoted">Google announced a model</td>'))).toEqual([]);
  });

  it('keeps a violation that sits inside an unmarked cell', () => {
    expect(companySubjectViolations(composedProse('<td>Google announced a model</td>'))).toEqual(['Google announced']);
  });
});

// ---------------------------------------------------------------------------
// THE COPY RULE, over what is actually rendered
// ---------------------------------------------------------------------------

describe('the rendered leaks desk never makes a company the subject of a verb', () => {
  it('puts no company in front of a verb in any claim sentence', () => {
    const offenders = ALL_KINDS.flatMap((i) => companySubjectViolations(leakSentence(i)));
    expect(offenders).toEqual([]);
  });

  it('puts no company in front of a verb anywhere the leaks page composed', () => {
    expect(companySubjectViolations(composedProse(renderLeaksPage(ALL_KINDS)))).toEqual([]);
  });

  it('puts no company in front of a verb on an empty leaks page', () => {
    expect(companySubjectViolations(composedProse(renderLeaksPage([])))).toEqual([]);
  });

  it('puts no company in front of a verb on the ledger page', () => {
    const claims = parseLedger(
      JSON.stringify({
        kind: 'claim',
        id: 'a',
        claim: 'A model named "k2" appears in arena.ai\'s leaderboard payload.',
        tier: 'unconfirmed',
        recorded: '2026-08-31',
      }),
    );
    expect(companySubjectViolations(composedProse(renderLedgerPage(claims)))).toEqual([]);
  });

  // A ledger claim is human-written, so the SCAN has to reach it. This is the
  // proof that it does: a violation planted in a ledger row is caught.
  it('catches a company subject planted in a human-written ledger claim', () => {
    const claims = parseLedger(
      JSON.stringify({
        kind: 'claim',
        id: 'a',
        claim: 'OpenAI deprecated the Assistants API.',
        tier: 'unconfirmed',
        recorded: '2026-08-31',
      }),
    );
    expect(companySubjectViolations(composedProse(renderLedgerPage(claims)))).toEqual(['OpenAI deprecated']);
  });
});

// ---------------------------------------------------------------------------
// the pages themselves
// ---------------------------------------------------------------------------

describe('renderLeaksPage', () => {
  it('renders the claim sentence for every item it is given', () => {
    const html = renderLeaksPage(ALL_KINDS);
    const missing = ALL_KINDS.filter((i) => !html.includes(escapeHtml(leakSentence(i))));
    expect(missing).toEqual([]);
  });

  it('links every item to its raw artifact at that item’s own commit', () => {
    expect(renderLeaksPage(ALL_KINDS)).toContain(
      `https://github.com/MaxwellBrohm/llm-catalog-archive/blob/${SHA}/raw/arena-leaderboard/response.html`,
    );
  });

  it('links no artifact at HEAD', () => {
    expect(renderLeaksPage(ALL_KINDS)).not.toContain('/blob/HEAD/');
  });

  it('labels every item with its sourcing tier', () => {
    expect(
      renderLeaksPage(ALL_KINDS).match(/badge-tier badge-confirmed-artifact">confirmed-artifact</g),
    ).toHaveLength(ALL_KINDS.length);
  });

  // A section that vanished when it was empty would make "no reveals this
  // week" and "the extractor broke three weeks ago" render identically.
  it('keeps every signal heading on a page with no items at all', () => {
    const html = renderLeaksPage([]);
    const headings = ['a name entered the payload', 'a name was unmasked', 'a model-support pull request appeared', 'a model-support pull request merged', 'stealth/ namespace', 'an expiration_date was recorded'];
    expect(headings.filter((h) => !html.includes(h))).toEqual([]);
  });

  it('says so in words when a signal has no items', () => {
    expect(renderLeaksPage([])).toContain('No item of this kind is derivable from the archive as it stands');
  });

  it('prints the confirmation query for an upstream pull request', () => {
    expect(renderLeaksPage(ALL_KINDS)).toContain('https://huggingface.co/api/models?search=Ovis2.5');
  });

  // The query is evidence about a weights repository and the pull request is
  // evidence about a runtime. Merging them is the claim the copy rule forbids.
  it('calls the empty result a statement about the search rather than about what exists', () => {
    expect(renderLeaksPage(ALL_KINDS)).toContain('An empty array is a statement about that search, not about what exists');
  });

  it('prints no confirmation query for an arena item', () => {
    expect(renderLeaksPage([ALL_KINDS[0]!])).not.toContain('huggingface.co/api/models');
  });

  it('says nothing is rehosted', () => {
    expect(renderLeaksPage(ALL_KINDS)).toContain('Nothing here rehosts weights or source');
  });
});

/**
 * THE REFUSALS SECTION, which is the only thing on the desk that can tell a
 * quiet week apart from a broken parser.
 *
 * Both produce a count of zero. The desk was shipped with no way to render the
 * difference, and the guard that produces a refusal was added because the
 * codename map had no floor of its own: a picker reshape that collapsed it and
 * then recovered would have emitted roughly a thousand "a name entered the
 * payload" items, each with an honest permalink attached.
 */
describe('renderLeaksPage renders what the desk refused', () => {
  const refusal: LeakRefusal = {
    sourceId: 'arena-leaderboard',
    sha: SHA,
    path: 'raw/arena-leaderboard/response.html',
    stamp: ORIGIN,
    reason: 'the codename map holds 1 publicName record before this change and 1029 after, and the floor is 400.',
  };

  it('prints the reason it refused, in the words the derivation measured', () => {
    expect(renderLeaksPage([], [], [refusal])).toContain(
      'the codename map holds 1 publicName record before this change and 1029 after, and the floor is 400.',
    );
  });

  it('names the source it refused to derive from', () => {
    expect(renderLeaksPage([], [], [refusal])).toContain(
      'The desk derived nothing across one recorded change of arena-leaderboard',
    );
  });

  it('marks a refusal as a refusal rather than as a claim', () => {
    expect(renderLeaksPage([], [], [refusal])).toContain('<span class="badge badge-refusal">refused</span>');
  });

  it('links the refusal to the raw artifact at the commit it refused', () => {
    expect(renderLeaksPage([], [], [refusal])).toContain(
      `https://github.com/MaxwellBrohm/llm-catalog-archive/blob/${SHA}/raw/arena-leaderboard/response.html`,
    );
  });

  it('links the refusal to the change page for that commit', () => {
    expect(renderLeaksPage([], [], [refusal])).toContain(`href="../changes/${SHA}.html"`);
  });

  it('counts the refusals in words', () => {
    expect(renderLeaksPage([], [], [refusal, { ...refusal, sha: '0'.repeat(40) }])).toContain('2 changes the desk declined');
  });

  // A page that printed nothing here would leave a reader unable to tell a
  // clean run from a run with no refusal reporting at all.
  it('says no change was refused when none was', () => {
    expect(renderLeaksPage([], [], [])).toContain('No change was refused');
  });

  it('prints no refusal card when none was refused', () => {
    expect(renderLeaksPage([], [], [])).not.toContain('badge-refusal');
  });

  it('keeps the refusals heading on a desk with nothing refused', () => {
    expect(renderLeaksPage([], [], [])).toContain('<h2>Refused</h2>');
  });

  it('escapes a hostile reason rather than rendering it as markup', () => {
    expect(renderLeaksPage([], [], [{ ...refusal, reason: '<script>x</script>' }])).not.toContain('<script>x</script>');
  });
});

describe('renderLedgerPage', () => {
  it('refuses to print an accuracy rate for an empty ledger', () => {
    expect(renderLedgerPage([])).toContain('not yet scored: no claim has resolved');
  });

  it('prints the rate once a claim has resolved', () => {
    const claims = parseLedger(
      [
        JSON.stringify({ kind: 'claim', id: 'a', claim: 'x', tier: 'unconfirmed', recorded: '2026-08-31' }),
        JSON.stringify({ kind: 'resolution', claim_id: 'a', outcome: 'confirmed', resolved: '2026-09-15' }),
      ].join('\n'),
    );
    expect(renderLedgerPage(claims)).toContain('100%');
  });

  it('says the ledger is empty rather than printing an empty table', () => {
    expect(renderLedgerPage([])).toContain('The ledger is empty');
  });

  /*
   * The lede used to read "Every claim this desk has made and what became of
   * it" over a scorecard of zero, while the desk itself published items. There
   * is no code path from a derived item into meta/leaks-ledger.jsonl, and there
   * should not be: a derived item is a description of stored bytes and predicts
   * nothing, so it is not a thing that can be right or wrong. The copy has to
   * say which of the two it is counting.
   */
  it('scopes its claim to what is entered in this ledger', () => {
    expect(renderLedgerPage([])).toContain('Every claim ENTERED IN THIS LEDGER');
  });

  /**
   * These used to assert that a derived desk item "reaches this file through no
   * code path at all" and that an empty ledger beside a stocked desk was "the
   * expected state". Both were true and are now false: the catalog's own
   * expiration_date IS scoreable, so there is a code path, and the ledger holds
   * real claims. What survives is the distinction the page exists to make.
   */
  it('says a desk item predicts nothing and is never scored here', () => {
    expect(renderLedgerPage([])).toContain('predicts nothing, and is never scored here');
  });

  it('says the ledger scores a field rather than a company', () => {
    expect(renderLedgerPage([])).toContain('scores a FIELD rather than a company');
  });

  it('says why a retirement floor cannot be scored the same way', () => {
    expect(renderLedgerPage([])).toContain('is the guess this archive refuses');
  });
});

describe('buildSite emits the desk', () => {
  it('writes the leaks index', () => {
    expect(buildSite([]).map((f) => f.path)).toContain(LEAKS_INDEX_PATH);
  });

  it('writes the ledger page', () => {
    expect(buildSite([]).map((f) => f.path)).toContain(LEDGER_PATH);
  });

  // The legacy mirror is per page because a change page's URL is a permalink.
  // A new HTML page has to acquire its stub the same way every other one did.
  it('mirrors the leaks index at its legacy address', () => {
    expect(buildSite([]).map((f) => f.path)).toContain(`site/${LEAKS_INDEX_PATH}`);
  });

  it('renders the leak items it is handed onto the leaks index', () => {
    const files = buildSite([], undefined, undefined, ALL_KINDS);
    const page = files.find((f) => f.path === LEAKS_INDEX_PATH)!;
    expect(page.contents).toContain('stealth/sonnet-x');
  });

  it('renders the ledger claims it is handed onto the ledger page', () => {
    const claims = parseLedger(
      JSON.stringify({ kind: 'claim', id: 'a', claim: 'a claim in the ledger', tier: 'unconfirmed', recorded: '2026-08-31' }),
    );
    const files = buildSite([], undefined, undefined, [], claims);
    expect(files.find((f) => f.path === LEDGER_PATH)!.contents).toContain('a claim in the ledger');
  });
});
