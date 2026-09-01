import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_API,
  daysUntil,
  coveredProviders,
  looksLikeCatalogId,
  parseArgs,
  parseWindowDays,
  retiringRows,
  run,
  table,
  type Retirement,
} from '../bin/llmcat.js';
import { buildApi } from '../src/api/build.js';
import { renderApiPage, exampleModelId } from '../src/site/render.js';
import { writeSite } from '../src/site/build.js';
import { deriveEvents } from '../src/derive/events.js';
import { buildFeed } from '../src/derive/feed.js';
import { buildThreads } from '../src/derive/threads.js';
import { catalog, change, deprecationsDoc, replacementTable } from './derive-fixtures.js';

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseArgs', () => {
  it('reads the command out of the first positional', () => {
    expect(parseArgs(['models']).command).toBe('models');
  });

  it('defaults to help when nothing was typed', () => {
    expect(parseArgs([]).command).toBe('help');
  });

  it('reads a flag written with a following value', () => {
    expect(parseArgs(['models', '--lab', 'anthropic']).flags.get('lab')).toBe('anthropic');
  });

  it('reads a flag written with an equals sign', () => {
    expect(parseArgs(['models', '--lab=anthropic']).flags.get('lab')).toBe('anthropic');
  });

  it('reads a bare flag as true rather than as an empty value', () => {
    expect(parseArgs(['models', '--json']).flags.get('json')).toBe(true);
  });

  it('keeps an explicitly empty value distinguishable from a bare flag', () => {
    expect(parseArgs(['retiring', '--models=']).flags.get('models')).toBe('');
  });

  it('does not swallow the next flag as a value', () => {
    expect(parseArgs(['models', '--json', '--lab', 'anthropic']).flags.get('json')).toBe(true);
  });

  it('keeps positionals after the command', () => {
    expect(parseArgs(['watch', 'anthropic/claude-opus-5']).positionals).toEqual(['anthropic/claude-opus-5']);
  });
});

/**
 * A month is 30 days and a year is 365, stated rather than implied: this is a
 * planning horizon, not a calendar, and a window that silently meant 31 days in
 * March would put a retirement date on the wrong side of the line.
 */
describe('parseWindowDays', () => {
  it('reads 90d as ninety days', () => {
    expect(parseWindowDays('90d')).toBe(90);
  });

  it('reads a bare number as days', () => {
    expect(parseWindowDays('90')).toBe(90);
  });

  it('reads 12w as eighty-four days', () => {
    expect(parseWindowDays('12w')).toBe(84);
  });

  it('reads 6m as a hundred and eighty days', () => {
    expect(parseWindowDays('6m')).toBe(180);
  });

  it('reads 1y as three hundred and sixty-five days', () => {
    expect(parseWindowDays('1y')).toBe(365);
  });

  it('refuses a window it cannot read rather than defaulting to one nobody asked for', () => {
    expect(parseWindowDays('soon')).toBeNull();
  });
});

describe('daysUntil', () => {
  it('counts the days between two calendar dates', () => {
    expect(daysUntil('2026-11-24', '2026-08-31')).toBe(85);
  });

  it('returns zero on the day itself', () => {
    expect(daysUntil('2026-08-31', '2026-08-31')).toBe(0);
  });

  it('returns a negative count for a date already past', () => {
    expect(daysUntil('2026-08-05', '2026-08-31')).toBe(-26);
  });

  it('crosses a daylight-saving boundary without losing a day', () => {
    expect(daysUntil('2026-11-05', '2026-10-29')).toBe(7);
  });

  it('refuses a value that is not a date', () => {
    expect(daysUntil('N/A', '2026-08-31')).toBeNull();
  });
});

describe('looksLikeCatalogId', () => {
  it('recognises a vendor-prefixed catalogue id', () => {
    expect(looksLikeCatalogId('anthropic/claude-opus-5')).toBe(true);
  });

  it('does not mistake a provider API model name for one', () => {
    expect(looksLikeCatalogId('claude-opus-4-1-20250805')).toBe(false);
  });
});

describe('table', () => {
  it('pads every column to its widest cell', () => {
    expect(table([['a', 'x'], ['bbb', 'y']])).toBe('a    x\nbbb  y');
  });

  it('leaves no trailing whitespace on a short last cell', () => {
    expect(table([['a', 'x'], ['bbb', '']])).toBe('a    x\nbbb');
  });

  it('renders nothing at all for no rows', () => {
    expect(table([])).toBe('');
  });
});

const RETIREMENTS: Retirement[] = [
  { provider: 'anthropic', model: 'claude-opus-4-1-20250805', floor_date: '2026-08-05', floor_text: 'August 5, 2026', replacement: 'claude-opus-4-8', replacement_source: 'x' },
  { provider: 'anthropic', model: 'claude-opus-4-5-20251101', floor_date: '2026-11-24', floor_text: 'November 24, 2026', replacement: null, replacement_source: null },
  { provider: 'anthropic', model: 'claude-opus-5', floor_date: '2027-07-24', floor_text: 'Not sooner than July 24, 2027', replacement: null, replacement_source: null },
  { provider: 'anthropic', model: 'claude-undated', floor_date: null, floor_text: 'N/A', replacement: null, replacement_source: null },
];

describe('retiringRows', () => {
  it('marks a floor inside the window as inside', () => {
    expect(retiringRows(RETIREMENTS, ['claude-opus-4-5-20251101'], 90, '2026-08-31')[0]!.status).toBe('inside');
  });

  it('marks a floor one day past the window as outside', () => {
    expect(retiringRows(RETIREMENTS, ['claude-opus-4-5-20251101'], 84, '2026-08-31')[0]!.status).toBe('outside');
  });

  it('includes a floor already in the past, which is the case the query exists to catch', () => {
    expect(retiringRows(RETIREMENTS, ['claude-opus-4-1-20250805'], 90, '2026-08-31')[0]!.status).toBe('inside');
  });

  it('reports the days remaining for a floor still ahead', () => {
    expect(retiringRows(RETIREMENTS, ['claude-opus-4-5-20251101'], 90, '2026-08-31')[0]!.days).toBe(85);
  });

  it('carries the replacement the provider table recorded', () => {
    expect(retiringRows(RETIREMENTS, ['claude-opus-4-1-20250805'], 90, '2026-08-31')[0]!.record?.replacement).toBe('claude-opus-4-8');
  });

  it('marks a cell holding no date as undated rather than as safe', () => {
    expect(retiringRows(RETIREMENTS, ['claude-undated'], 90, '2026-08-31')[0]!.status).toBe('undated');
  });

  it('quotes the unparseable cell so a reader can go and look at it', () => {
    expect(retiringRows(RETIREMENTS, ['claude-undated'], 90, '2026-08-31')[0]!.note).toBe(
      "the table's cell holds no parseable date: N/A",
    );
  });

  it('marks a name the archive holds no floor for as unknown', () => {
    expect(retiringRows(RETIREMENTS, ['claude-made-up'], 90, '2026-08-31')[0]!.status).toBe('unknown');
  });

  // The whole point of refusing the join. A catalogue id silently reported as
  // "no floor" would read as "safe", which is the wrong answer to the only
  // question this command is asked.
  it('says why a catalogue id has no floor rather than reporting it as safe', () => {
    expect(retiringRows(RETIREMENTS, ['anthropic/claude-opus-5'], 90, '2026-08-31')[0]!.note).toBe(
      "no retirement floor is recorded under this name. It has the shape of an OpenRouter catalog id, and retirement floors are published in the provider's own API model namespace. This archive does not join the two.",
    );
  });

  it('checks every floor in the archive when no list was given', () => {
    expect(retiringRows(RETIREMENTS, [], 90, '2026-08-31').map((r) => r.model)).toEqual([
      'claude-opus-4-1-20250805',
      'claude-opus-4-5-20251101',
      'claude-opus-5',
      'claude-undated',
    ]);
  });

  it('orders the rows by how soon each floor lands', () => {
    expect(retiringRows(RETIREMENTS, ['claude-opus-5', 'claude-opus-4-1-20250805'], 400, '2026-08-31').map((r) => r.model)).toEqual([
      'claude-opus-4-1-20250805',
      'claude-opus-5',
    ]);
  });
});

describe('the default API base', () => {
  it('points at the published deployment, so the CLI works with no flags', () => {
    expect(DEFAULT_API).toBe('https://maxwellbrohm.github.io/llm-catalog-archive/api/v1');
  });
});

// ---------------------------------------------------------------------------
// the CLI over a real generated mirror
// ---------------------------------------------------------------------------

const lifecycle = [
  deprecationsDoc([
    ['claude-opus-5', 'Active', 'N/A', 'Not sooner than July 24, 2027'],
    ['claude-opus-4-1-20250805', 'Deprecated', 'August 5, 2025', 'August 5, 2026'],
  ]),
  replacementTable([['August 5, 2026', 'claude-opus-4-1-20250805', 'claude-opus-4-8']]),
].join('\n');

const changes = [
  change({
    before: catalog([{ id: 'anthropic/claude-opus-5', pricing: { prompt: '0.000001', completion: '0.000005' } }]),
    after: catalog([{ id: 'anthropic/claude-opus-5', pricing: { prompt: '0.000002', completion: '0.000005' } }]),
  }),
  change({
    sourceId: 'anthropic-deprecations',
    path: 'raw/anthropic-deprecations/response.md',
    tier: 'daily',
    before: lifecycle,
    after: lifecycle,
  }),
];

function mirror(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmcat-'));
  temps.push(dir);
  const feed = buildFeed(deriveEvents(changes), []);
  writeSite(dir, buildApi({ feed, threads: buildThreads(feed), refusals: [], ledger: [], changes }));
  return path.join(dir, 'api/v1');
}

const BASE = mirror();

/** Run the CLI and return its exit code and its whole output. */
async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await run([...argv, '--api', BASE], (s) => lines.push(s));
  return { code, out: lines.join('\n') };
}

/**
 * THE EXIT CODE IS THE WHOLE PRODUCT FOR A CI CALLER. It reads the code and
 * nothing else, so a code that says "clear" when the archive simply has no data
 * for the name asked about is worse than no gate at all: it converts ignorance
 * into a green build. Before this contract existed, `retiring` returned 0 for
 * every provider except the one whose deprecation table is collected.
 */
describe('llmcat retiring, as a CI gate', () => {
  it('exits 2 when a requested name cannot be answered, rather than 0', async () => {
    const r = await cli(['retiring', '--models', 'openai/gpt-5.2', '--within', '90d']);
    expect(r.code).toBe(2);
  });

  it('says out loud how many names it could not answer', async () => {
    const r = await cli(['retiring', '--models', 'openai/gpt-5.2', '--within', '90d']);
    expect(r.out).toContain('could not be answered');
  });

  it('lets an unanswerable name dominate a real hit, because the verdict is then untrustworthy', async () => {
    // one name the archive has a floor for, one it does not
    const r = await cli([
      'retiring', '--models', 'claude-opus-4-1-20250805,openai/gpt-5.2', '--within', '3650d',
    ]);
    expect(r.code).toBe(2);
  });

  it('still exits 1 when every requested name was answerable and something is inside', async () => {
    const r = await cli(['retiring', '--models', 'claude-opus-4-1-20250805', '--within', '3650d']);
    expect(r.code).toBe(1);
  });

  it('prints which providers it actually has floors for', async () => {
    const r = await cli(['retiring', '--within', '90d']);
    expect(r.out).toContain('Retirement floors are collected for:');
  });

  it('says that an already-past floor is deliberately inside the window', async () => {
    const r = await cli(['retiring', '--within', '90d']);
    expect(r.out).toContain('already in the past');
  });

  it('carries the same contract into --json', async () => {
    const r = await cli(['retiring', '--models', 'openai/gpt-5.2', '--within', '90d', '--json']);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).covered_providers).toBeTypeOf('string');
  });
});

describe('coveredProviders', () => {
  it('reads the prefixes off the records rather than hardcoding them', () => {
    expect(coveredProviders([
      { model: 'claude-3-5-haiku-20241022' } as Retirement,
      { model: 'claude-opus-4-20250514' } as Retirement,
    ])).toBe('claude');
  });

  it('reports no provider on an empty archive instead of an empty string', () => {
    expect(coveredProviders([])).toBe('no provider');
  });

  it('splits an OpenRouter-shaped id at the slash', () => {
    expect(coveredProviders([{ model: 'openai/gpt-5' } as Retirement])).toBe('openai');
  });
});

describe('llmcat models', () => {
  it('prints the catalogue id out of the current state', async () => {
    expect((await cli(['models'])).out).toContain('anthropic/claude-opus-5');
  });

  it('prints the prompt price the stored bytes carry after the change', async () => {
    expect((await cli(['models'])).out).toContain('0.000002');
  });

  it('names the artifact the state was read from', async () => {
    expect((await cli(['models'])).out).toContain(
      '/blob/a69a068319de9dc9a7ab1049b411a562a026e7d5/raw/openrouter-models/response.json',
    );
  });

  it('filters to one lab', async () => {
    expect((await cli(['models', '--lab', 'openai'])).out).toContain('0 model(s)');
  });

  it('prints the records themselves under --json', async () => {
    const parsed = JSON.parse((await cli(['models', '--json'])).out) as { id: string }[];
    expect(parsed.map((m) => m.id)).toEqual(['anthropic/claude-opus-5']);
  });
});

describe('llmcat price-history', () => {
  it('prints both sides of the listed price change', async () => {
    const { out } = await cli(['price-history', 'anthropic/claude-opus-5']);
    expect(out).toContain('0.000001');
    expect(out).toContain('0.000002');
  });

  it('prints the artifact permalink beside the row', async () => {
    expect((await cli(['price-history', 'anthropic/claude-opus-5'])).out).toContain(
      '/blob/a69a068319de9dc9a7ab1049b411a562a026e7d5/raw/openrouter-models/response.json',
    );
  });

  it('exits nonzero for an id the catalogue does not carry', async () => {
    expect((await cli(['price-history', 'nope/nope'])).code).toBe(1);
  });

  it('reports a usage error when no model was named', async () => {
    expect((await cli(['price-history'])).code).toBe(2);
  });
});

describe('llmcat watch', () => {
  it('prints the item history for a model, once', async () => {
    expect((await cli(['watch', 'anthropic/claude-opus-5', '--once'])).out).toContain('1 item(s)');
  });

  it('labels the timestamp field rather than printing a bare instant', async () => {
    expect((await cli(['watch', 'anthropic/claude-opus-5', '--once'])).out).toContain('(origin_date)');
  });

  it('says an unknown id is not in the catalogue rather than printing nothing', async () => {
    expect((await cli(['watch', 'nope/nope', '--once'])).out).toContain('is not in the current catalog state');
  });
});

describe('llmcat retiring', () => {
  it('exits 1 when a named model has a floor inside the window, so it gates CI', async () => {
    expect((await cli(['retiring', '--within', '90d', '--today', '2026-08-31', '--models', 'claude-opus-4-1-20250805'])).code).toBe(1);
  });

  it('exits 0 when nothing named lands inside the window', async () => {
    expect((await cli(['retiring', '--within', '90d', '--today', '2026-08-31', '--models', 'claude-opus-5'])).code).toBe(0);
  });

  it('prints the replacement the provider table recommends', async () => {
    expect((await cli(['retiring', '--within', '90d', '--today', '2026-08-31', '--models', 'claude-opus-4-1-20250805'])).out).toContain('claude-opus-4-8');
  });

  it('refuses to guess a floor for an OpenRouter catalogue id', async () => {
    expect((await cli(['retiring', '--within', '90d', '--today', '2026-08-31', '--models', 'anthropic/claude-opus-5'])).out).toContain(
      'This archive does not join the two.',
    );
  });

  it('reports a usage error for a window it cannot read', async () => {
    expect((await cli(['retiring', '--within', 'soon'])).code).toBe(2);
  });

  it('reads the names from a file when given one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmcat-list-'));
    temps.push(dir);
    const list = path.join(dir, 'models.txt');
    fs.writeFileSync(list, 'claude-opus-4-1-20250805\n\nclaude-opus-5\n');
    const { code } = await cli(['retiring', '--within', '90d', '--today', '2026-08-31', '--file', list]);
    expect(code).toBe(1);
  });

  it('names the artifact the floors were read from', async () => {
    expect((await cli(['retiring', '--within', '90d', '--today', '2026-08-31'])).out).toContain(
      '/raw/anthropic-deprecations/response.md',
    );
  });
});

describe('llmcat leaks', () => {
  it('reports the refusal count beside the item count', async () => {
    expect((await cli(['leaks'])).out).toContain('0 refusal(s)');
  });
});

describe('llmcat help', () => {
  it('is what a bare invocation prints', async () => {
    expect((await cli([])).out).toContain('llmcat: the keyless CLI');
  });

  it('exits 2 on a command it does not have', async () => {
    expect((await cli(['frobnicate'])).code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// the arms the first pass left unasserted
// ---------------------------------------------------------------------------

import { stampOf } from '../bin/llmcat.js';
import { deriveLeaks } from '../src/derive/leaks.js';

describe('parseArgs edges', () => {
  it('keeps an empty flag name written with an equals sign', () => {
    expect(parseArgs(['x', '--=v']).flags.get('')).toBe('v');
  });
});

describe('parseWindowDays edges', () => {
  it('trims the value before reading it', () => {
    expect(parseWindowDays(' 90d ')).toBe(90);
  });

  it('refuses a window with trailing words after the unit', () => {
    expect(parseWindowDays('90d ago')).toBeNull();
  });

  it('refuses a window with leading words before the number', () => {
    expect(parseWindowDays('in 90d')).toBeNull();
  });
});

/**
 * The CLI prints the field beside every instant. A column that silently mixed
 * origin_date and observed_at would be the conflation section 9 forbids.
 */
describe('stampOf', () => {
  it('prints the value and the field it came from', () => {
    expect(stampOf({ timestamp: { value: '2026-08-28T08:08:22.000Z', field: 'origin_date' } })).toBe(
      '2026-08-28T08:08:22.000Z (origin_date)',
    );
  });

  it('says so plainly when a record carries no timestamp', () => {
    expect(stampOf({ timestamp: null })).toBe('no timestamp');
  });

  it('says so plainly when the timestamp key is absent altogether', () => {
    expect(stampOf({})).toBe('no timestamp');
  });

  it('prints an empty value rather than the string "undefined" for a malformed stamp', () => {
    expect(stampOf({ timestamp: { field: 'origin_date' } })).toBe(' (origin_date)');
  });

  it('prints an empty field rather than the string "undefined" for an unlabelled stamp', () => {
    expect(stampOf({ timestamp: { value: '2026-08-28T08:08:22.000Z' } })).toBe(
      '2026-08-28T08:08:22.000Z ()',
    );
  });
});

describe('table pads every column', () => {
  it('pads a middle column to its widest cell', () => {
    expect(table([['a', 'bb', 'c'], ['a', 'b', 'c']])).toBe('a  bb  c\na  b   c');
  });
});

const SAME_DAY: Retirement[] = [
  { provider: 'anthropic', model: 'zeta', floor_date: '2026-11-24', floor_text: 'x', replacement: null, replacement_source: null },
  { provider: 'anthropic', model: 'mid', floor_date: '2026-11-24', floor_text: 'x', replacement: null, replacement_source: null },
  { provider: 'anthropic', model: 'alpha', floor_date: '2026-11-24', floor_text: 'x', replacement: null, replacement_source: null },
];

describe('retiringRows: ordering and boundaries', () => {
  it('breaks a tie on the model name so the output is stable across runs', () => {
    expect(retiringRows(SAME_DAY, [], 400, '2026-08-31').map((r) => r.model)).toEqual([
      'alpha',
      'mid',
      'zeta',
    ]);
  });

  it('counts a floor exactly on the horizon as inside it', () => {
    expect(retiringRows(SAME_DAY, ['alpha'], 85, '2026-08-31')[0]!.status).toBe('inside');
  });

  it('marks a floor date that is not a date as undated rather than as safe', () => {
    const bad: Retirement[] = [{ provider: 'anthropic', model: 'x', floor_date: '2026-99-99', floor_text: 'x', replacement: null, replacement_source: null }];
    expect(retiringRows(bad, ['x'], 90, '2026-08-31')[0]!.status).toBe('undated');
  });

  it('says the date could not be read when the recorded date is unparseable', () => {
    const bad: Retirement[] = [{ provider: 'anthropic', model: 'x', floor_date: '2026-99-99', floor_text: 'x', replacement: null, replacement_source: null }];
    expect(retiringRows(bad, ['x'], 90, '2026-08-31')[0]!.note).toBe('the recorded date could not be read as a date');
  });
});

describe('readDoc chooses the network for an http base', () => {
  it('does not look on disk for a base that is an http URL', async () => {
    await expect(readDocFailure()).resolves.not.toContain('ENOENT');
  });
});

/** The rejection message from an http base pointed at a closed port. */
async function readDocFailure(): Promise<string> {
  const { readDoc } = await import('../bin/llmcat.js');
  try {
    await readDoc('http://127.0.0.1:1/api/v1', 'index.json');
    return 'resolved';
  } catch (e) {
    return String(e);
  }
}

// ---------------------------------------------------------------------------
// a second mirror, richer than the first
// ---------------------------------------------------------------------------

/** A catalogue payload with the shapes the table formatter has to survive. */
const sparseCatalog = JSON.stringify({
  data: [
    { id: 'anthropic/claude-opus-5', canonical_slug: 'anthropic/claude-opus-5', context_length: 200000, pricing: { prompt: '0.000002', completion: '0.000005' }, top_provider: { context_length: 200000 }, expiration_date: null },
    { id: '~anthropic/claude-latest', canonical_slug: 'anthropic/claude-opus-5', context_length: null, pricing: {}, top_provider: { context_length: null }, expiration_date: null },
    { id: 'moonshotai/kimi-k2.5', canonical_slug: 'moonshotai/kimi-k2.5', context_length: 128000, pricing: { prompt: '0.0000005', completion: '0.000002' }, top_provider: { context_length: 128000 }, expiration_date: '2026-12-01T00:00:00Z' },
  ],
});

/** The two captures before it, sharing every id so only the prices move. */
const captureA = catalog([
  { id: 'anthropic/claude-opus-5', context_length: 200000, pricing: { prompt: '0.0000005', completion: '0.000005' } },
  { id: '~anthropic/claude-latest', context_length: 200000 },
  { id: 'moonshotai/kimi-k2.5', context_length: 128000, pricing: { prompt: '0.0000005', completion: '0.000002' } },
]);
const captureB = catalog([
  { id: 'anthropic/claude-opus-5', context_length: 200000, pricing: { prompt: '0.000001', completion: '0.000005' } },
  { id: '~anthropic/claude-latest', context_length: 200000 },
  { id: 'moonshotai/kimi-k2.5', context_length: 128000, pricing: { prompt: '0.0000005', completion: '0.000002' } },
]);

const priceOne = change({
  sha: '1'.repeat(40),
  stamp: { iso: '2026-08-20T00:00:00.000Z', kind: 'origin' },
  before: captureA,
  after: captureB,
});
const priceTwo = change({
  sha: '2'.repeat(40),
  stamp: { iso: '2026-08-25T00:00:00.000Z', kind: 'origin' },
  before: captureB,
  after: sparseCatalog,
});

const richLifecycle = [
  deprecationsDoc([
    ['claude-opus-4-1-20250805', 'Deprecated', 'August 5, 2025', 'August 5, 2026'],
    ['claude-opus-4-5-20251101', 'Active', 'N/A', 'November 24, 2026'],
    ['claude-opus-5', 'Active', 'N/A', 'Not sooner than July 24, 2027'],
  ]),
  replacementTable([['August 5, 2026', 'claude-opus-4-1-20250805', 'claude-opus-4-8']]),
].join('\n');

const richChanges = [
  priceTwo,
  priceOne,
  change({
    sourceId: 'anthropic-deprecations',
    path: 'raw/anthropic-deprecations/response.md',
    tier: 'daily',
    before: deprecationsDoc([['claude-opus-4-1-20250805', 'Deprecated', 'August 5, 2025', 'N/A']]),
    after: richLifecycle,
  }),
];

function mirrorOf(changes: typeof richChanges): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmcat-'));
  temps.push(dir);
  const feed = buildFeed(deriveEvents(changes), deriveLeaks(changes));
  writeSite(dir, buildApi({ feed, threads: buildThreads(feed), refusals: [], ledger: [], changes }));
  return path.join(dir, 'api/v1');
}

const RICH = mirrorOf(richChanges);
/** A mirror with a lifecycle table and no catalogue capture at all. */
const NO_CATALOG = mirrorOf([richChanges[2]!]);

async function at(base: string, argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await run([...argv, '--api', base], (s) => lines.push(s));
  return { code, out: lines.join('\n') };
}

describe('llmcat models over a richer catalogue', () => {
  it('prints the column headings', async () => {
    expect((await at(RICH, ['models'])).out).toContain('MODEL');
  });

  it('includes a floating id under the lab whose prefix it carries', async () => {
    expect((await at(RICH, ['models', '--lab', 'anthropic'])).out).toContain('~anthropic/claude-latest');
  });

  it('includes the plain id under that lab too', async () => {
    expect((await at(RICH, ['models', '--lab', 'anthropic'])).out).toContain('anthropic/claude-opus-5');
  });

  it('excludes a model belonging to another lab', async () => {
    expect((await at(RICH, ['models', '--lab', 'anthropic'])).out).not.toContain('moonshotai/kimi-k2.5');
  });

  it('honours a row limit', async () => {
    expect((await at(RICH, ['models', '--limit', '1'])).out).toContain('1 model(s)');
  });

  it('ignores a limit that is not a positive number', async () => {
    expect((await at(RICH, ['models', '--limit', 'lots'])).out).toContain('3 model(s)');
  });

  it('prints absent rather than a blank for a model with no context_length', async () => {
    expect((await at(RICH, ['models', '--lab', 'anthropic'])).out).toContain('absent');
  });

  it('says the catalogue state is unknown when no catalogue has been captured', async () => {
    expect((await at(NO_CATALOG, ['models'])).out).toContain('an unknown commit');
  });

  it('prints no artifact line when there is no catalogue capture to link', async () => {
    expect((await at(NO_CATALOG, ['models'])).out).not.toContain('artifact:');
  });
});

describe('llmcat price-history over two commits', () => {
  it('prints the oldest change first', async () => {
    const { out } = await at(RICH, ['price-history', 'anthropic/claude-opus-5']);
    expect(out.indexOf('2026-08-20')).toBeLessThan(out.indexOf('2026-08-25'));
  });

  it('prints the column headings', async () => {
    expect((await at(RICH, ['price-history', 'anthropic/claude-opus-5'])).out).toContain('FIELD');
  });

  it('prints the records themselves under --json', async () => {
    const parsed = JSON.parse((await at(RICH, ['price-history', 'anthropic/claude-opus-5', '--json'])).out) as unknown[];
    expect(parsed.length).toBe(2);
  });

  it('says so when a model in the catalogue has no price change on record', async () => {
    expect((await at(RICH, ['price-history', 'moonshotai/kimi-k2.5'])).out).toContain(
      'No listed-price change for moonshotai/kimi-k2.5',
    );
  });
});

describe('llmcat watch', () => {
  it('prints the records themselves under --json', async () => {
    const parsed = JSON.parse((await at(RICH, ['watch', 'anthropic/claude-opus-5', '--once', '--json'])).out) as { total: number };
    expect(parsed.total).toBe(2);
  });

  it('reports a usage error when no model was named', async () => {
    expect((await at(RICH, ['watch'])).code).toBe(2);
  });

  it('hints at the id shape when the name carries no vendor prefix', async () => {
    expect((await at(RICH, ['watch', 'claude-opus-5', '--once'])).out).toContain('vendor-prefixed');
  });

  it('does not repeat that hint for a name that already has a vendor prefix', async () => {
    expect((await at(RICH, ['watch', 'nope/nope', '--once'])).out).not.toContain('vendor-prefixed');
  });
});

describe('llmcat leaks filtering', () => {
  it('keeps the items of the tier asked for', async () => {
    expect((await at(RICH, ['leaks', '--tier', 'confirmed-artifact'])).out).toContain('1 item(s)');
  });

  it('keeps none of another tier', async () => {
    expect((await at(RICH, ['leaks', '--tier', 'credible'])).out).toContain('0 item(s)');
  });

  it('prints the column headings', async () => {
    expect((await at(RICH, ['leaks'])).out).toContain('SUBJECT');
  });

  it('prints the records themselves under --json', async () => {
    const parsed = JSON.parse((await at(RICH, ['leaks', '--json'])).out) as unknown[];
    expect(parsed.length).toBe(1);
  });
});

describe('llmcat retiring over a richer table', () => {
  it('defaults the horizon to ninety days when none was given', async () => {
    expect((await at(RICH, ['retiring', '--today', '2026-08-31'])).out).toContain('within 90 day(s)');
  });

  it('defaults today to a real calendar day when none was given', async () => {
    const parsed = JSON.parse((await at(RICH, ['retiring', '--within', '90d', '--json'])).out) as { today: string };
    expect(parsed.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('prints the column headings', async () => {
    expect((await at(RICH, ['retiring', '--within', '90d', '--today', '2026-08-31'])).out).toContain('RECOMMENDED REPLACEMENT');
  });

  it('marks a floor already past as past rather than as a negative number', async () => {
    expect((await at(RICH, ['retiring', '--within', '90d', '--today', '2026-08-31'])).out).toContain('26 past');
  });

  it('prints a plain day count for a floor still ahead', async () => {
    const { out } = await at(RICH, ['retiring', '--within', '90d', '--today', '2026-08-31']);
    expect(out).toMatch(/claude-opus-4-5-20251101\s+2026-11-24\s+85\s/);
  });

  it('says none rather than nothing when the window is empty', async () => {
    expect((await at(RICH, ['retiring', '--within', '1d', '--today', '2020-01-01', '--models', 'claude-opus-5'])).out).toContain(
      'None of the names checked',
    );
  });

  it('prints the day count for a name that fell outside the window', async () => {
    expect((await at(RICH, ['retiring', '--within', '90d', '--today', '2026-08-31', '--models', 'claude-opus-5'])).out).toContain(
      'claude-opus-5: floor 2027-07-24, 327 day(s) out',
    );
  });

  it('prints no not-inside section when every name checked is inside', async () => {
    expect((await at(RICH, ['retiring', '--within', '400d', '--today', '2026-08-31'])).out).not.toContain(
      'Not inside the window:',
    );
  });

  it('checks only the names given, never adding one of its own', async () => {
    const parsed = JSON.parse(
      (await at(RICH, ['retiring', '--within', '90d', '--today', '2026-08-31', '--models', 'claude-opus-5', '--json'])).out,
    ) as { rows: { model: string }[] };
    expect(parsed.rows.map((r) => r.model)).toEqual(['claude-opus-5']);
  });

  it('drops the blank lines in a model list file rather than checking an empty name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmcat-list2-'));
    temps.push(dir);
    const list = path.join(dir, 'models.txt');
    fs.writeFileSync(list, '\nclaude-opus-5\n\n');
    const parsed = JSON.parse((await at(RICH, ['retiring', '--within', '90d', '--today', '2026-08-31', '--file', list, '--json'])).out) as {
      rows: { model: string }[];
    };
    expect(parsed.rows.map((r) => r.model)).toEqual(['claude-opus-5']);
  });

  it('reads the file rather than falling back to every floor in the archive', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmcat-list3-'));
    temps.push(dir);
    const list = path.join(dir, 'models.txt');
    fs.writeFileSync(list, 'claude-opus-5\n');
    expect((await at(RICH, ['retiring', '--within', '90d', '--today', '2026-08-31', '--file', list])).code).toBe(0);
  });

  it('prints no source line when the archive holds no lifecycle capture', async () => {
    const noLifecycle = mirrorOf([priceTwo, priceOne]);
    expect((await at(noLifecycle, ['retiring', '--within', '90d', '--today', '2026-08-31'])).out).not.toContain('Read from');
  });
});

describe('llmcat --help', () => {
  it('answers --help even when a command was also typed', async () => {
    expect((await at(RICH, ['models', '--help'])).out).toContain('llmcat: the keyless CLI');
  });
});

// ---------------------------------------------------------------------------
// the documentation's worked examples, against a real built API
// ---------------------------------------------------------------------------

/**
 * THE GATE THAT WAS MISSING. The API page's examples sat under a heading
 * reading "Examples that run as written" while naming a model whose `api`
 * field is null, so the documented pipeline resolved to `curl null` and printed
 * nothing. The old guard checked only that the `.json` addresses the page
 * printed were real files, which a hardcoded model id sails straight past.
 *
 * This asserts the thing a reader actually does: take the id out of the page,
 * look it up in models.json, and follow its `api` link to a file that exists.
 */
describe('the API page examples resolve against the built API', () => {
  const page = renderApiPage(
    'https://example.invalid',
    undefined,
    undefined,
    exampleModelId(buildThreads(buildFeed(deriveEvents(changes), [])).threads),
  );

  /** Every model id the page's examples name, from the shell blocks. */
  function idsNamedInExamples(html: string): string[] {
    const out = new Set<string>();
    for (const m of html.matchAll(/select\(\.id == &quot;([^&]+)&quot;\)/g)) out.add(m[1] as string);
    for (const m of html.matchAll(/(?:watch|price-history) ([a-z0-9][\w.\-]*\/[\w.\-:]+)/g)) out.add(m[1] as string);
    return [...out];
  }

  it('names at least one model id in its examples', () => {
    expect(idsNamedInExamples(page).length).toBeGreaterThan(0);
  });

  it('every model id it names is in models.json with a non-null api link', () => {
    const models = JSON.parse(fs.readFileSync(path.join(BASE, 'models.json'), 'utf8'));
    const byId = new Map<string, { api: string | null }>(
      (models.models as { id: string; api: string | null }[]).map((m) => [m.id, m]),
    );
    for (const id of idsNamedInExamples(page)) {
      const record = byId.get(id);
      expect(record, `${id} is named in an example but absent from models.json`).toBeDefined();
      expect(record?.api, `${id} is named in an example but its api field is null`).not.toBeNull();
    }
  });

  it('the api link each example follows is a file that exists and has items', () => {
    const models = JSON.parse(fs.readFileSync(path.join(BASE, 'models.json'), 'utf8'));
    const byId = new Map<string, { api: string | null }>(
      (models.models as { id: string; api: string | null }[]).map((m) => [m.id, m]),
    );
    for (const id of idsNamedInExamples(page)) {
      const api = byId.get(id)?.api;
      expect(api).toBeTruthy();
      // the api field is an absolute published URL; the mirror holds the tail
      const tail = String(api).split('/api/v1/')[1] as string;
      const doc = JSON.parse(fs.readFileSync(path.join(BASE, tail), 'utf8'));
      expect(doc.items.length, `${id}'s thread document is empty`).toBeGreaterThan(0);
    }
  });
});

/**
 * The mutation that proved the gate above was vacuous: with the chooser
 * returning null the fixture still passed, because the fixture's only model
 * happened to be the hardcoded fallback id. There is no fallback now, so a
 * chooser that returns nothing produces a page with no model example at all,
 * and that is what these two assert.
 */
describe('the API page without a usable example model', () => {
  const page = renderApiPage('https://example.invalid', undefined, undefined, null);

  it('names no model id at all rather than falling back to a hardcoded one', () => {
    expect(page).not.toMatch(/select\(\.id == &quot;/);
    expect(page).not.toMatch(/(?:watch|price-history) [a-z0-9][\w.\-]*\//);
  });

  it('says why the per-model example is missing', () => {
    expect(page).toContain('omitted rather than written against an id that would not resolve');
  });

  it('refuses an empty string, which is neither an id nor an absence', () => {
    expect(() => renderApiPage('https://example.invalid', undefined, undefined, '')).toThrow();
  });
});

describe('exampleModelId', () => {
  const th = (id: string, count: number) =>
    ({
      entity: { kind: 'model' as const, id: `model/openrouter:${id}`, label: id },
      slug: id.replace('/', '-'),
      events: Array.from({ length: count }, () => ({}) as never),
      firstSeen: null,
      lastActivity: null,
    });

  it('picks the busiest thread, because it is likeliest to still resolve tomorrow', () => {
    expect(exampleModelId([th('a/one', 1), th('b/two', 9), th('c/three', 3)])).toBe('b/two');
  });

  it('breaks a tie on the id so the page is byte-stable across builds', () => {
    expect(exampleModelId([th('z/last', 4), th('a/first', 4)])).toBe('a/first');
  });

  it('returns the catalog id, not the namespaced entity id', () => {
    expect(exampleModelId([th('anthropic/claude-opus-5', 2)])).toBe('anthropic/claude-opus-5');
  });

  it('ignores a model entity from a provider API namespace, which is not a models.json id', () => {
    const apiNamespaced = {
      entity: { kind: 'model' as const, id: 'model/anthropic-api:claude-opus-4-1', label: 'claude-opus-4-1' },
      slug: 'claude-opus-4-1',
      events: Array.from({ length: 99 }, () => ({}) as never),
      firstSeen: null,
      lastActivity: null,
    };
    expect(exampleModelId([apiNamespaced, th('a/one', 1)])).toBe('a/one');
  });

  it('returns null when the archive holds no model thread', () => {
    expect(exampleModelId([])).toBeNull();
  });
});
