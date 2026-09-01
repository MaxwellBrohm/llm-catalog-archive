#!/usr/bin/env node
/**
 * llmcat: the CLI over the static JSON API. ONE FILE, ZERO DEPENDENCIES.
 *
 * WHY THIS IS THE DISTRIBUTION ANSWER AND NOT A NICE-TO-HAVE. Show HN
 * explicitly excludes "newsletters, lists, and other reading material" and
 * requires something people can run. The publication is what a reader stays
 * for; this is how the first thousand of them arrive. That is also why it has
 * no dependencies and no build step: `npx github:MaxwellBrohm/llm-catalog-archive`
 * fetches this repository and runs this file directly under Node's own
 * TypeScript type stripping, so there is nothing between reading the README and
 * running the command.
 *
 * IT READS THE PUBLISHED API AND NOTHING ELSE. No git, no local archive, no
 * private endpoint. Every number it prints came out of a file anybody can curl,
 * which means a user can check any line of its output against the artifact
 * permalink printed beside it. `--api` points it at a local mirror instead,
 * which is also how it is tested.
 *
 * WHAT IT WILL NOT DO. It never joins an OpenRouter catalog id to a provider's
 * own API model name. `anthropic/claude-opus-4.1` and `claude-opus-4-1-20250805`
 * are different strings issued by different parties, and `retiring` says so
 * rather than guessing, because a wrong answer to "does my model retire inside
 * my planning horizon" is worse than no answer.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_API = 'https://maxwellbrohm.github.io/llm-catalog-archive/api/v1';

export type Args = {
  command: string;
  positionals: string[];
  flags: Map<string, string | true>;
};

/**
 * `--flag value`, `--flag=value` and bare `--flag`. Nothing clever.
 *
 * A bare flag is `true` rather than the empty string so `--json` and
 * `--models ""` are distinguishable: the second is a user who passed an empty
 * list and should be told their list is empty, not silently given everything.
 */
export function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(body, next);
      i++;
    } else {
      flags.set(body, true);
    }
  }
  return { command: positionals[0] ?? 'help', positionals: positionals.slice(1), flags };
}

/**
 * `90d`, `12w`, `6m`, `1y` or a bare number of days, to days.
 *
 * A month is 30 days and a year is 365, stated here rather than implied: this
 * is a planning horizon, not a calendar, and a horizon that silently meant 31
 * days in March would put a retirement date on the wrong side of the line one
 * month in twelve. Returns null on anything else, which the caller reports as a
 * usage error rather than defaulting to a window nobody asked for.
 */
export function parseWindowDays(value: string): number | null {
  const m = /^(\d+)\s*(d|w|m|y|day|days|week|weeks|month|months|year|years)?$/i.exec(value.trim());
  if (m === null) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? 'd').toLowerCase()[0];
  if (unit === 'w') return n * 7;
  if (unit === 'm') return n * 30;
  if (unit === 'y') return n * 365;
  return n;
}

const MS_PER_DAY = 86400000;

/**
 * Whole days from `today` to `day`, negative when `day` is already past.
 *
 * Both are parsed as UTC midnight, so the answer never depends on the machine's
 * timezone. A retirement date is a calendar date in the provider's own
 * document, and rendering it against a local clock would move it by one day for
 * half the planet.
 */
export function daysUntil(day: string, today: string): number | null {
  const a = Date.parse(`${day}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / MS_PER_DAY);
}

/** True when the value has the shape of an OpenRouter catalog id. */
export function looksLikeCatalogId(value: string): boolean {
  return value.includes('/');
}

export type Retirement = {
  provider: string;
  model: string;
  floor_date: string | null;
  floor_text: string;
  replacement: string | null;
  replacement_source: string | null;
};

export type RetiringRow = {
  model: string;
  /** `inside` the window, `outside` it, `undated`, or `unknown` to the archive. */
  status: 'inside' | 'outside' | 'undated' | 'unknown';
  days: number | null;
  record: Retirement | null;
  note: string | null;
};

/**
 * The killer query, as a pure function so it can be asserted without a clock.
 *
 * `wanted` empty means every floor the archive holds, which is what makes the
 * command useful before a user has a dependency list to hand.
 *
 * A floor already in the past counts as INSIDE the window. It is not a
 * near-miss, it is the case the query exists to catch, and a horizon that
 * silently excluded it would report "nothing retiring" to the one caller who
 * most needs an answer.
 */
export function retiringRows(
  retirements: Retirement[],
  wanted: string[],
  windowDays: number,
  today: string,
): RetiringRow[] {
  const byModel = new Map(retirements.map((r) => [r.model, r]));
  const names = wanted.length > 0 ? wanted : retirements.map((r) => r.model);
  const rows: RetiringRow[] = [];
  for (const name of names) {
    const record = byModel.get(name) ?? null;
    if (record === null) {
      rows.push({
        model: name,
        status: 'unknown',
        days: null,
        record: null,
        note: looksLikeCatalogId(name)
          ? 'no retirement floor is recorded under this name. It has the shape of an OpenRouter catalog id, and retirement floors are published in the provider\'s own API model namespace. This archive does not join the two.'
          : 'no retirement floor is recorded under this name in the archive.',
      });
      continue;
    }
    if (record.floor_date === null) {
      rows.push({
        model: name,
        status: 'undated',
        days: null,
        record,
        note: `the table's cell holds no parseable date: ${record.floor_text}`,
      });
      continue;
    }
    const days = daysUntil(record.floor_date, today);
    if (days === null) {
      rows.push({ model: name, status: 'undated', days: null, record, note: 'the recorded date could not be read as a date' });
      continue;
    }
    rows.push({
      model: name,
      status: days <= windowDays ? 'inside' : 'outside',
      days,
      record,
      note: null,
    });
  }
  rows.sort((a, b) => {
    const ka = a.days ?? Number.POSITIVE_INFINITY;
    const kb = b.days ?? Number.POSITIVE_INFINITY;
    if (ka !== kb) return ka - kb;
    return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
  });
  return rows;
}

/** Left-aligned fixed-width columns. No dependency, no box drawing. */
export function table(rows: string[][]): string {
  if (rows.length === 0) return '';
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  // Every cell padded, including the last, and the row trimmed once at the end.
  // A special case for the final column would be a branch no output can tell
  // apart from this, because trimEnd already removes what it would have saved.
  return rows
    .map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd())
    .join('\n');
}

/**
 * One API document, from the network or from a local mirror.
 *
 * A base that is not an http(s) URL is read off the filesystem, so `--api
 * build/site/api/v1` works against a clone and needs no server. That is not a
 * test affordance bolted on: the archive is a public git repository, and a user
 * who cares about availability should mirror it rather than depend on us.
 */
export async function readDoc(base: string, rel: string): Promise<unknown> {
  if (/^https?:\/\//i.test(base)) {
    const url = `${base.replace(/\/+$/, '')}/${rel}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }
  const file = path.resolve(base, rel);
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function asArray(value: unknown, field: string): unknown[] {
  const holder = value as Record<string, unknown> | null;
  const got = holder === null ? undefined : holder[field];
  return Array.isArray(got) ? got : [];
}

function str(row: unknown, field: string): string {
  const v = (row as Record<string, unknown>)[field];
  return typeof v === 'string' ? v : '';
}

export function stampOf(row: unknown): string {
  const t = (row as Record<string, unknown>)['timestamp'] as Record<string, unknown> | null | undefined;
  if (t === null || t === undefined) return 'no timestamp';
  const value = typeof t['value'] === 'string' ? t['value'] : '';
  const field = typeof t['field'] === 'string' ? t['field'] : '';
  // The field is printed, always. origin_date is when the provider generated
  // the bytes and observed_at is when the collector saw them, and a column that
  // silently mixed the two would be the exact conflation the archive refuses.
  return `${value} (${field})`;
}

export const HELP = `llmcat: the keyless CLI over the llm-catalog-archive JSON API.

  llmcat models [--lab <lab>] [--limit <n>]
      The current OpenRouter catalog state, one row per model.

  llmcat watch <model-id> [--interval <seconds>] [--once]
      Every derived item attached to one model, newest first, then poll for
      more. --once prints the history and exits.

  llmcat price-history <model-id>
      Every listed-price change for one model, oldest first.

  llmcat retiring --within 90d [--models a,b,c] [--file <path>] [--today <YYYY-MM-DD>]
      Which of the models you depend on have a retirement floor inside your
      planning horizon, and what the provider's own table recommends instead.
      Exits 1 when anything is inside the window, so it works as a CI gate.
      Model names are the provider's own API model names, not catalog ids.

  llmcat leaks [--tier confirmed-artifact|credible|unconfirmed]
      The leaks desk. The tier is about the artifact, not about confidence.

Global flags:
  --json          print the API records instead of a table
  --api <base>    read from another base URL, or from a local directory
  --help          this text

Every record the API serves carries the permalink of the raw artifact it was
derived from, at the full sha of the commit that changed it. Check anything.
`;

async function cmdModels(args: Args, base: string, out: (s: string) => void): Promise<number> {
  const doc = await readDoc(base, 'models.json');
  const lab = args.flags.get('lab');
  const limitFlag = args.flags.get('limit');
  let models = asArray(doc, 'models');
  if (typeof lab === 'string') {
    const prefix = `${lab}/`;
    models = models.filter((m) => str(m, 'id').startsWith(prefix) || str(m, 'id').startsWith(`~${prefix}`));
  }
  if (typeof limitFlag === 'string') {
    const n = Number(limitFlag);
    if (Number.isFinite(n) && n > 0) models = models.slice(0, n);
  }
  if (args.flags.has('json')) {
    out(JSON.stringify(models, null, 2));
    return 0;
  }
  const source = (doc as Record<string, unknown>)['source'] as Record<string, unknown> | null;
  out(table([
    ['MODEL', 'CONTEXT', 'TOP PROVIDER', 'PROMPT', 'COMPLETION', 'ITEMS'],
    ...models.map((m) => {
      const pricing = ((m as Record<string, unknown>)['pricing'] ?? {}) as Record<string, unknown>;
      const ctx = (m as Record<string, unknown>)['context_length'];
      const top = (m as Record<string, unknown>)['top_provider_context_length'];
      return [
        str(m, 'id'),
        ctx === null || ctx === undefined ? 'absent' : String(ctx),
        top === null || top === undefined ? 'absent' : String(top),
        typeof pricing['prompt'] === 'string' ? pricing['prompt'] : 'absent',
        typeof pricing['completion'] === 'string' ? pricing['completion'] : 'absent',
        String((m as Record<string, unknown>)['events'] ?? 0),
      ];
    }),
  ]));
  out('');
  out(`${models.length} model(s). Catalog state as stored at ${source === null ? 'an unknown commit' : stampOf(source)}.`);
  if (source !== null) out(`artifact: ${String(source['artifact'] ?? '')}`);
  return 0;
}

/** The per-model endpoint for a catalog id, or null when nothing attaches to it. */
async function modelEndpoint(base: string, id: string): Promise<{ api: string | null; found: boolean }> {
  const doc = await readDoc(base, 'models.json');
  for (const m of asArray(doc, 'models')) {
    if (str(m, 'id') !== id) continue;
    const slug = str(m, 'slug');
    // `api` null in the record means no derived item attaches to this model, so
    // no per-model file was generated. Building the path from the slug anyway
    // would turn "nothing has happened to this model" into a 404, which is the
    // one thing this project refuses to let a quiet result look like.
    const api = (m as Record<string, unknown>)['api'];
    // The slug, not the absolute URL, so a local mirror resolves too.
    return { api: typeof api === 'string' && slug !== '' ? `models/${slug}.json` : null, found: true };
  }
  return { api: null, found: false };
}

function itemLines(items: unknown[]): string[][] {
  return items.map((i) => [stampOf(i), str(i, 'type'), str(i, 'sentence')]);
}

async function cmdWatch(args: Args, base: string, out: (s: string) => void): Promise<number> {
  const id = args.positionals[0];
  if (id === undefined) {
    out('usage: llmcat watch <model-id>');
    return 2;
  }
  const { api, found } = await modelEndpoint(base, id);
  if (!found) {
    out(`${id} is not in the current catalog state this API serves.`);
    if (!looksLikeCatalogId(id)) out('Model ids in this catalog are vendor-prefixed, for example anthropic/claude-opus-5.');
    return 1;
  }
  if (api === null) {
    out(`${id} is in the catalog and no derived item attaches to it yet, so it has no history endpoint.`);
    return 0;
  }
  const doc = await readDoc(base, api);
  const items = asArray(doc, 'items');
  if (args.flags.has('json')) {
    out(JSON.stringify(doc, null, 2));
    return 0;
  }
  out(table(itemLines(items)));
  out('');
  out(`${items.length} item(s) for ${id}.`);
  if (args.flags.has('once')) return 0;

  const intervalFlag = args.flags.get('interval');
  const seconds = typeof intervalFlag === 'string' && Number(intervalFlag) > 0 ? Number(intervalFlag) : 300;
  const seen = new Set(items.map((i) => str(i, 'id')));
  out(`watching, polling every ${seconds}s. Ctrl-C to stop.`);
  // A plain loop rather than setInterval: an interval that fires again while a
  // slow fetch is still running would interleave two polls and print the same
  // item twice.
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    const next = asArray(await readDoc(base, api), 'items');
    const fresh = next.filter((i) => !seen.has(str(i, 'id')));
    for (const item of fresh) {
      seen.add(str(item, 'id'));
      out(`${stampOf(item)}  ${str(item, 'sentence')}`);
      out(`  ${str(item, 'artifact')}`);
    }
  }
}

async function cmdPriceHistory(args: Args, base: string, out: (s: string) => void): Promise<number> {
  const id = args.positionals[0];
  if (id === undefined) {
    out('usage: llmcat price-history <model-id>');
    return 2;
  }
  const { api, found } = await modelEndpoint(base, id);
  if (!found) {
    out(`${id} is not in the current catalog state this API serves.`);
    return 1;
  }
  if (api === null) {
    out(`${id} is in the catalog and no derived item attaches to it yet.`);
    return 0;
  }
  const items = asArray(await readDoc(base, api), 'items').filter((i) => str(i, 'type') === 'price_changed');
  // Oldest first: a price history read newest first is a history you have to
  // reverse in your head before it means anything.
  const ordered = [...items].reverse();
  if (args.flags.has('json')) {
    out(JSON.stringify(ordered, null, 2));
    return 0;
  }
  if (ordered.length === 0) {
    out(`No listed-price change for ${id} is derivable from the archive.`);
    return 0;
  }
  out(table([
    ['WHEN', 'FIELD', 'FROM', 'TO', 'ARTIFACT'],
    ...ordered.map((i) => {
      const f = ((i as Record<string, unknown>)['fields'] ?? {}) as Record<string, unknown>;
      return [
        stampOf(i),
        String(f['field'] ?? ''),
        String(f['from'] ?? 'absent'),
        String(f['to'] ?? 'absent'),
        str(i, 'artifact'),
      ];
    }),
  ]));
  return 0;
}

async function cmdLeaks(args: Args, base: string, out: (s: string) => void): Promise<number> {
  const doc = await readDoc(base, 'leaks.json');
  const tier = args.flags.get('tier');
  let items = asArray(doc, 'items');
  if (typeof tier === 'string') items = items.filter((i) => str(i, 'tier') === tier);
  if (args.flags.has('json')) {
    out(JSON.stringify(items, null, 2));
    return 0;
  }
  out(table([
    ['WHEN', 'TIER', 'TYPE', 'SUBJECT'],
    ...items.map((i) => [stampOf(i), str(i, 'tier'), str(i, 'type'), str(i, 'subject')]),
  ]));
  out('');
  out(`${items.length} item(s). The tier is about the artifact, not about confidence.`);
  // Refusals beside the count, always: a signal that stopped parsing and a week
  // with no reveals both produce zero items, and only one of them is a failure.
  const refusals = asArray(doc, 'refusals');
  out(`${refusals.length} refusal(s): changes the desk read and declined to derive from.`);
  for (const r of refusals) out(`  ${str(r, 'source_id')} at ${str(r, 'sha').slice(0, 7)}: ${str(r, 'reason')}`);
  return 0;
}

/** The model names to check: --models, --file, or every floor in the archive. */
async function wantedModels(args: Args): Promise<string[]> {
  const inline = args.flags.get('models');
  const file = args.flags.get('file');
  const names: string[] = [];
  if (typeof inline === 'string') names.push(...inline.split(','));
  if (typeof file === 'string') names.push(...(await fs.readFile(file, 'utf8')).split('\n'));
  return names.map((n) => n.trim()).filter((n) => n !== '');
}

async function cmdRetiring(args: Args, base: string, out: (s: string) => void): Promise<number> {
  const withinFlag = args.flags.get('within');
  const within = typeof withinFlag === 'string' ? parseWindowDays(withinFlag) : 90;
  if (within === null) {
    out(`--within: cannot read ${String(withinFlag)} as a window. Try 90d, 12w, 6m or 1y.`);
    return 2;
  }
  const todayFlag = args.flags.get('today');
  const today = typeof todayFlag === 'string' ? todayFlag : new Date().toISOString().slice(0, 10);
  const doc = await readDoc(base, 'retirements.json');
  const retirements = asArray(doc, 'retirements') as Retirement[];
  const rows = retiringRows(retirements, await wantedModels(args), within, today);

  if (args.flags.has('json')) {
    out(JSON.stringify({ today, within_days: within, rows }, null, 2));
    return rows.some((r) => r.status === 'inside') ? 1 : 0;
  }

  const inside = rows.filter((r) => r.status === 'inside');
  out(`Retirement floors within ${within} day(s) of ${today}.`);
  out('');
  if (inside.length === 0) {
    out('None of the names checked has a retirement floor inside that window.');
  } else {
    out(table([
      ['MODEL', 'FLOOR', 'DAYS', 'RECOMMENDED REPLACEMENT'],
      ...inside.map((r) => [
        r.model,
        r.record?.floor_date ?? '',
        r.days === null ? '' : r.days < 0 ? `${-r.days} past` : String(r.days),
        r.record?.replacement ?? 'none recorded',
      ]),
    ]));
    out('');
    out('A recommended replacement is what that provider\'s own deprecation-history table names. It is not a claim that the two models are equivalent.');
  }

  const other = rows.filter((r) => r.status !== 'inside');
  if (other.length > 0) {
    out('');
    out('Not inside the window:');
    for (const r of other) {
      if (r.status === 'outside') out(`  ${r.model}: floor ${r.record?.floor_date ?? ''}, ${String(r.days)} day(s) out`);
      else out(`  ${r.model}: ${r.note ?? r.status}`);
    }
  }
  const source = (doc as Record<string, unknown>)['source'] as Record<string, unknown> | null;
  if (source !== null) {
    out('');
    out(`Read from ${String(source['artifact'] ?? '')}`);
  }
  // Nonzero when something is inside the horizon, so this is usable as a gate
  // in CI rather than only as something a human reads.
  return inside.length > 0 ? 1 : 0;
}

export async function run(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.has('help') || args.command === 'help') {
    out(HELP);
    return 0;
  }
  const apiFlag = args.flags.get('api');
  const base = typeof apiFlag === 'string' ? apiFlag : DEFAULT_API;
  switch (args.command) {
    case 'models':
      return cmdModels(args, base, out);
    case 'watch':
      return cmdWatch(args, base, out);
    case 'price-history':
      return cmdPriceHistory(args, base, out);
    case 'leaks':
      return cmdLeaks(args, base, out);
    case 'retiring':
      return cmdRetiring(args, base, out);
    default:
      out(`unknown command: ${args.command}`);
      out(HELP);
      return 2;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await run(process.argv.slice(2));
}
