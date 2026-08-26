# Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deterministic collector that fetches 16 declared endpoints on two schedules and commits their responses verbatim to git, where git history is the archive.

**Architecture:** Pure functions for every decision (health, change predicate, magnitude guard, status transitions, timestamp derivation), thin I/O shells around them (fetch, git, CLI). The run is a fixed pipeline: fetch, health check, change predicate, magnitude guard, write, commit, push, evaluate counters, exit code. Nothing the collector parses is ever written.

**Tech Stack:** TypeScript (ESM), Node >= 24, vitest, zod for config validation, Stryker for mutation testing, native `fetch` with `redirect: 'manual'`. No HTTP client dependency.

**Spec:** `docs/superpowers/specs/2026-08-26-collector-and-archive-design.md`

**Out of scope for this plan:** the backfill importer (models.dev bundle, kj-9 replay). That is Plan 2 and is gated on spec open question O2.

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include these.

- **R1.** The collector writes response bytes exactly as received. Bytes means the **decoded entity body**: send `Accept-Encoding: gzip`, decode, store decoded. Record `content-encoding` in `headers.json`. No normalizing, parsing, schema, field stripping, re-ordering or pretty-printing at write time.
- **R2.** Auto-published events link the raw artifact. R1 is a precondition for the publishing gate.
- **R3.** Normalization happens in the deriver, at diff time, never at write time.
- **R4.** Parsing is allowed for the health check and the commit decision, and forbidden for the commit content.
- **R5.** One stable path per source, overwritten in place, committed only on change. Scope: `raw/` and `backfill/`. `meta/` files follow the status cadence.
- **R6.** Backfill never shares a path with go-forward capture.
- **R7.** History is never rewritten. No force-push, no rebase of pushed commits, no `git rm` intended as deletion, for the life of the repository.
- **Repository is public**, named `llm-catalog-archive`. Permalinks are `<repo-url>/blob/<commit-sha>/<path>`.
- **Run order is fixed and cannot be implemented in any other sequence:** fetch, health check, change predicate, magnitude guard, write, commit, push, evaluate counters, exit code.
- **A response that fails the health check is never written and never commits.** Last-good bytes are never clobbered by an error page.
- **The status commit is never downstream of the failure evaluation.**
- **User-Agent is `llm-catalog-archive/1.0 (+https://github.com/OWNER/REPO)`** plus a contact address, identical for every source. **Spoofing a browser or feed-reader UA is forbidden.**
- **Concurrency 4, at most one in-flight request per hostname, minimum 1s between consecutive requests to the same host**, in `sources.json` order.
- **Never `git push --force`.** Push is `git pull --rebase` then push, up to 3 attempts.
- **No em dashes** in any file, comment, commit message, or generated string.
- Every non-default `predicate`, `invariants` value and `freshness` setting carries its justification in the source's `notes` field.

---

## Task order, and why the collector ships at Task 5

The archive's value compounds with elapsed time. A day not collected is history
that cannot be recovered, and no later task recovers it. So the order is not
"build the parts, then assemble." It is **get bytes onto disk on a schedule as
early as correctness allows, then improve a collector that is already running.**

`llm-catalog-archive` is committing real snapshots from a GitHub Actions
schedule at the end of **Task 5**. Tasks 6 through 13 improve it in place.

The asymmetry that makes this safe: a wrong snapshot committed by a degraded
collector stays recoverable, because history keeps the good one beside it and
R7 forbids rewriting. A missing day is simply gone. So only the irreversible
things must be right before Task 5 ships, and Task 5 enumerates exactly which
those are and why each one cannot wait.

Three sources ship `status: "pending"` rather than active, because under a byte
predicate each would commit a multi-megabyte blob on every run for reasons that
are not content. They activate in Task 8, when they have a predicate that can
see through their volatility.

### How the run grows

`src/run.ts` is written minimal in Task 5 and gains one decision per task. The
complete final pipeline is given as real code in Task 11.

| Task | Inserts into `runTier` | Where |
|---|---|---|
| 5 | fetch, byte comparison, verbatim write, sidecar, commit, push | the whole thing, minimal |
| 6 | `checkHealth` | between fetch and the change decision; nothing is written unless it allows it |
| 7 | `hasChanged` | replaces the inline byte comparison |
| 8 | the three extractors, and the three sources flip to active | inside `hasChanged` |
| 9 | `checkMagnitude` | between the change decision and the write |
| 10 | `applyOutcome`, `shouldCommitStatus`, `exitCodeFor`, `isStaleGeneration` | status commit always before the exit-code evaluation |
| 11 | nothing new; asserts the assembled order | the ordering tests |

## Standing review contract

**This applies to the review gate of every task, in addition to whatever that
task's own steps say.**

Every failure this project has produced so far is one family: *looks healthy
while being wrong.* A text predicate that was vacuous. A counter that could not
advance. Headers describing a different fetch than the body beside them. A feed
answering 200 with an interstitial. Tests passing is therefore not sufficient
evidence that a task is done, because the characteristic defect here is an
assertion that is true for the wrong reason.

The reviewer must confirm, for **every new predicate, guard, health check and
gating condition** a task introduces:

1. It was **broken on purpose**, the specific test was **watched to fail**, and
   it was restored. The review must name the mutation and the test that went red.
2. Where an assertion claims an **absence** ("this trap is rejected", "no write
   occurs", "no commit is produced"), the fixture was verified to actually
   contain the thing being rejected. An absence-assertion against a fixture that
   has lost its trap passes whether or not the code works.
3. The test failed for the **right reason**. A test that goes red with a
   `TypeError` when a guard is removed is not evidence the guard works.

A task whose review cannot name the mutation it watched fail is not done,
however green the suite is.

## File Structure

| File | Responsibility |
|---|---|
| `src/config.ts` | `sources.json` types, zod schema, loader. The only place source config shape is defined. |
| `src/health.ts` | The five-condition health predicate. Pure. |
| `src/predicates.ts` | `bytes` / `mask` / `extracted` change-decision dispatch. Pure. |
| `src/extractors/arena.ts` | Record tuples from the arena RSC payload, and the label-variant filter. Pure. |
| `src/extractors/xai.ts` | Table-block sort normalization. Pure. |
| `src/extractors/sitemapLoc.ts` | `<loc>` set extraction. Pure. |
| `src/magnitude.ts` | The shrink guard. Pure. |
| `src/status.ts` | `status.json` shape, meaningful-field diff, hysteresis, counters, holds. Pure. |
| `src/headers.ts` | Header capture shape, `origin_date` derivation, cache-skew rejection. Pure. |
| `src/fetch.ts` | HTTP: UA, manual redirects, retries, timeouts, content-length guard. I/O. |
| `src/git.ts` | Stage, commit, pull-rebase, push. I/O. |
| `src/run.ts` | The orchestrated pipeline. Created minimal in Task 5, grown by Tasks 6 to 10, locked in Task 11. |
| `src/cli.ts` | `collect --tier fast\|daily` entrypoint, exit codes. Created in Task 5, extended in Task 12. |
| `test/fixtures/` | Bytes captured 2026-08-26, one file per trap. |
| `.github/workflows/collect-fast.yml`, `collect-daily.yml` | Schedules, concurrency group. |
| `.github/workflows/append-only.yml` | CI check on `meta/*.jsonl`. |

Pure modules never import `src/fetch.ts`, `src/git.ts`, or `node:fs`. A lint test asserts this, because it is the property that makes every decision testable without a network.

---

### Task 1: Scaffold, append-only ledgers, and the CI check

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitattributes`, `.gitignore`
- Create: `meta/corrections.jsonl`, `meta/retractions.jsonl` (empty)
- Create: `.github/workflows/append-only.yml`
- Test: `test/scaffold.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `npm test` runs vitest; `npm run typecheck` runs `tsc --noEmit`

- [ ] **Step 1: Write the failing test**

```ts
// test/scaffold.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

describe('scaffold', () => {
  it('marks raw and backfill as binary so git never rewrites stored bytes', () => {
    const attrs = fs.readFileSync('.gitattributes', 'utf8');
    expect(attrs).toContain('raw/** -text -diff=auto');
    expect(attrs).toContain('backfill/** -text -diff=auto');
  });

  it('ships both append-only ledgers, empty', () => {
    expect(fs.readFileSync('meta/corrections.jsonl', 'utf8')).toBe('');
    expect(fs.readFileSync('meta/retractions.jsonl', 'utf8')).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/scaffold.test.ts`
Expected: FAIL, `ENOENT: no such file or directory, open '.gitattributes'`

- [ ] **Step 3: Create the scaffold**

`package.json`:
```json
{
  "name": "llm-catalog-archive",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "collect": "tsx src/cli.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "mutate": "stryker run"
  },
  "dependencies": { "zod": "^4.4.3" },
  "devDependencies": {
    "@types/node": "^26.1.2",
    "tsx": "^4.23.9",
    "typescript": "^7.0.2",
    "vitest": "^4.0.0",
    "@stryker-mutator/core": "^9.6.1",
    "@stryker-mutator/vitest-runner": "^9.6.1"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "test"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['test/**/*.test.ts'] } });
```

`.gitattributes`:
```
raw/** -text -diff=auto
backfill/** -text -diff=auto
```

`.gitignore`:
```
node_modules/
.stryker-tmp/
```

Create the two ledgers as genuinely empty files:
```bash
mkdir -p meta && : > meta/corrections.jsonl && : > meta/retractions.jsonl
```

- [ ] **Step 4: Install and run tests**

Run: `npm install && npx vitest run test/scaffold.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 5: Add the append-only CI check**

`.github/workflows/append-only.yml`:
```yaml
name: append-only
on: [pull_request, push]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: Ledgers may only gain lines
        run: |
          set -euo pipefail
          base="${{ github.event.before || 'HEAD~1' }}"
          for f in meta/corrections.jsonl meta/retractions.jsonl; do
            removed=$(git diff "$base" HEAD -- "$f" | grep -c '^-[^-]' || true)
            if [ "$removed" -ne 0 ]; then
              echo "::error::$f is append-only; $removed line(s) removed or modified"
              exit 1
            fi
          done
```

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitattributes .gitignore meta/corrections.jsonl meta/retractions.jsonl .github/workflows/append-only.yml test/scaffold.test.ts
git commit -m "chore: scaffold, and two ledgers that may only ever grow"
```

---

---

### Task 2: `sources.json` schema and loader

**Files:**
- Create: `src/config.ts`, `meta/sources.json`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type Source` with fields `id, url, tier, status, path, contentType, expectedRoot, invariants, freshness, predicate, timeoutS, retries, maxRedirects, rateLimit, magnitudeGuard, notes`
  - `type SourcesFile = { version: number; userAgent: string; contact: string; sources: Source[] }`
  - `loadSources(json: unknown): SourcesFile` throws on unknown keys
  - `sourcesForTier(f: SourcesFile, tier: 'fast' | 'daily'): Source[]`
  - `activeSourcesForTier(f: SourcesFile, tier: 'fast' | 'daily'): Source[]` (excludes `status: 'pending'`)

- [ ] **Step 1: Write the failing test**

```ts
// test/config.test.ts
import { describe, it, expect } from 'vitest';
import { loadSources, sourcesForTier, activeSourcesForTier } from '../src/config.js';
import fs from 'node:fs';

const minimal = {
  version: 1,
  userAgent: 'llm-catalog-archive/1.0 (+https://github.com/OWNER/REPO)',
  contact: 'owner@example.com',
  sources: [{
    id: 'openrouter-models',
    url: 'https://openrouter.ai/api/v1/models',
    tier: 'fast',
    status: 'active',
    path: 'raw/openrouter-models/response.json',
    contentType: 'json',
    expectedRoot: null,
    invariants: { minBytes: 400000, requiredKeyPath: 'data', minRecords: 300, canary: null, sizeBand: [0.5, 2.0] },
    freshness: { kind: 'none', maxQuietDays: null },
    predicate: { type: 'bytes' },
    timeoutS: 60, retries: 2, maxRedirects: 3,
    rateLimit: { maxAutoEventsPerDay: 8 },
    magnitudeGuard: { maxShrinkPct: 25 },
    notes: '',
  }],
};

describe('loadSources', () => {
  it('accepts a well formed file', () => {
    expect(loadSources(minimal).sources[0]!.id).toBe('openrouter-models');
  });

  it('rejects an unknown key rather than ignoring it', () => {
    const bad = structuredClone(minimal);
    (bad.sources[0] as Record<string, unknown>).cadence = '15m';
    expect(() => loadSources(bad)).toThrow(/cadence/);
  });

  it('rejects a duplicate id', () => {
    const bad = structuredClone(minimal);
    bad.sources.push(structuredClone(minimal.sources[0]!));
    expect(() => loadSources(bad)).toThrow(/duplicate/i);
  });

  it('rejects a path that does not match the id', () => {
    const bad = structuredClone(minimal);
    bad.sources[0]!.path = 'raw/somewhere-else/response.json';
    expect(() => loadSources(bad)).toThrow(/path/i);
  });

  it('requires a canary for every text source, since parse checks are vacuous there', () => {
    const bad = structuredClone(minimal);
    bad.sources[0]!.contentType = 'text';
    expect(() => loadSources(bad)).toThrow(/canary/i);
  });

  it('splits by tier', () => {
    const f = loadSources(minimal);
    expect(sourcesForTier(f, 'fast')).toHaveLength(1);
    expect(sourcesForTier(f, 'daily')).toHaveLength(0);
    expect(activeSourcesForTier(f, 'fast')).toHaveLength(1);
  });

  it('the shipped meta/sources.json loads and has all 16 sources', () => {
    const f = loadSources(JSON.parse(fs.readFileSync('meta/sources.json', 'utf8')));
    expect(f.sources).toHaveLength(16);
    expect(f.sources.filter((s) => s.status === 'pending').map((s) => s.id).sort())
      .toEqual(['arena-leaderboard', 'openrouter-sitemap', 'xai-llms-txt']);
    expect(sourcesForTier(f, 'fast').map((s) => s.id)).toEqual(['openrouter-models']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL, cannot resolve `../src/config.js`

- [ ] **Step 3: Write `src/config.ts`**

```ts
import { z } from 'zod';

const Invariants = z.strictObject({
  minBytes: z.number().int().nonnegative(),
  requiredKeyPath: z.string().nullable(),
  minRecords: z.number().int().nonnegative().nullable(),
  canary: z.string().nullable(),
  sizeBand: z.tuple([z.number().positive(), z.number().positive()]),
});

const Freshness = z.strictObject({
  kind: z.enum(['feed', 'content', 'none']),
  maxQuietDays: z.number().int().positive().nullable(),
});

const Predicate = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('bytes') }),
  z.strictObject({ type: z.literal('mask'), patterns: z.array(z.string()).min(1) }),
  z.strictObject({ type: z.literal('extracted'), extractor: z.enum(['arena', 'xai', 'sitemapLoc']) }),
]);

const SourceSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  url: z.string().url(),
  tier: z.enum(['fast', 'daily']),
  /**
   * `pending` sources are validated and reported but never fetched.
   *
   * The three volatile sources start pending. Under a byte predicate each
   * would commit a full blob on every run, and at 5.2 MB, 1.46 MB and 617 KB
   * that is hundreds of megabytes of junk in a history R7 forbids rewriting.
   * They flip to `active` in the task that gives them a real predicate.
   */
  status: z.enum(['active', 'pending']),
  path: z.string(),
  contentType: z.enum(['json', 'xml', 'text', 'html']),
  expectedRoot: z.string().nullable(),
  invariants: Invariants,
  freshness: Freshness,
  predicate: Predicate,
  timeoutS: z.number().int().positive(),
  retries: z.number().int().nonnegative(),
  maxRedirects: z.number().int().nonnegative(),
  rateLimit: z.strictObject({ maxAutoEventsPerDay: z.number().int().positive() }),
  magnitudeGuard: z.strictObject({ maxShrinkPct: z.number().min(0).max(100) }),
  notes: z.string(),
});

const FileSchema = z.strictObject({
  version: z.literal(1),
  userAgent: z.string().min(1),
  contact: z.string().min(1),
  sources: z.array(SourceSchema).min(1),
});

export type Source = z.infer<typeof SourceSchema>;
export type SourcesFile = z.infer<typeof FileSchema>;

/**
 * The loader is strict on purpose. An unknown key is a typo that would
 * otherwise be silently ignored, and a silently ignored predicate override is
 * how a source reverts to committing every run without anyone noticing.
 */
export function loadSources(json: unknown): SourcesFile {
  const f = FileSchema.parse(json);

  const seen = new Set<string>();
  for (const s of f.sources) {
    if (seen.has(s.id)) throw new Error(`duplicate source id: ${s.id}`);
    seen.add(s.id);

    if (!s.path.startsWith(`raw/${s.id}/`)) {
      throw new Error(`source ${s.id}: path must live under raw/${s.id}/, got ${s.path}`);
    }
    // "parses as its declared type" is vacuous for text, so a canary stands in.
    if (s.contentType === 'text' && !s.invariants.canary) {
      throw new Error(`source ${s.id}: text sources require invariants.canary`);
    }
    const [lo, hi] = s.invariants.sizeBand;
    if (lo >= hi) throw new Error(`source ${s.id}: sizeBand must be [lo, hi] with lo < hi`);
  }
  return f;
}

export function sourcesForTier(f: SourcesFile, tier: 'fast' | 'daily'): Source[] {
  return f.sources.filter((s) => s.tier === tier);
}

/** What the collector should actually fetch right now. */
export function activeSourcesForTier(f: SourcesFile, tier: 'fast' | 'daily'): Source[] {
  return sourcesForTier(f, tier).filter((s) => s.status === 'active');
}
```

- [ ] **Step 4: Write `meta/sources.json` with all 16 sources**

Transcribe every row from spec section 4. `openrouter-models` is `tier: "fast"`; the other 15 are `tier: "daily"`. **`arena-leaderboard`, `xai-llms-txt` and `openrouter-sitemap` are `status: "pending"`; the other 13 are `status: "active"`.** Non-default predicates, taken from spec section 7:

| id | predicate | notes must say |
|---|---|---|
| `arena-leaderboard` | `{"type":"extracted","extractor":"arena"}` | three per-request volatile regions: provisional userId UUIDv7, a 37 to 41 key posthogFlags map that re-rolls for anonymous visitors, and a Cloudflare __CF$cv$params blob carrying the request's own cf-ray and clock. A mask list keyed on flag names rots as arena ships experiments. |
| `xai-llms-txt` | `{"type":"extracted","extractor":"xai"}` | rows re-permute per request; reordering is not a maskable substring, and the deriver cannot fix it because the commit decision is upstream of the deriver. |
| `openrouter-sitemap` | `{"type":"extracted","extractor":"sitemapLoc"}` | rebuilt several times a day, rewriting about 100 lastmod values independent of content change. |

Every other source is `{"type":"bytes"}`. Canaries for the eight text sources are chosen in Task 3, so leave a placeholder string now and the Task 3 test will force real values.

Freshness: `claude-status` and `openai-status` are `{"kind":"feed","maxQuietDays":120}` with a note that a quiet quarter is good news, not a failure. The sitemaps and text sources are `{"kind":"content","maxQuietDays":90}`. `openrouter-models` is `{"kind":"none","maxQuietDays":null}`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/config.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 6: Commit**

```bash
git add src/config.ts meta/sources.json test/config.test.ts
git commit -m "feat: one strict table drives the collector, and a typo is an error"
```

---

---

### Task 3: Headers, origin timestamps, and cache-generation skew

**Files:**
- Create: `src/headers.ts`
- Test: `test/headers.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type HeaderRecord`
  - `captureHeaders(res: { status: number; headers: Headers }, meta: { fetchedAt: string; finalUrl: string; userAgent: string }): HeaderRecord`
  - `originDateMs(h: HeaderRecord): number | null`
  - `isStaleGeneration(next: HeaderRecord, storedOriginIso: string | null): boolean`

`headers.json` is a **sidecar**: written in the same commit as the body it describes, and only when that body is accepted. Never on an independent schedule. An earlier design put it on the status cadence, which for the fast tier discarded 95 of every 96 daily header states and guaranteed the committed etag was not the etag of the committed body.

- [ ] **Step 1: Write the failing test**

```ts
// test/headers.test.ts
import { describe, it, expect } from 'vitest';
import { captureHeaders, originDateMs, isStaleGeneration, type HeaderRecord } from '../src/headers.js';

const cap = (h: Record<string, string>, status = 200): HeaderRecord =>
  captureHeaders({ status, headers: new Headers(h) },
    { fetchedAt: '2026-08-26T14:00:00.000Z', finalUrl: 'https://x/y', userAgent: 'llm-catalog-archive/1.0' });

const DATE_14 = 'Tue, 26 Aug 2026 14:00:00 GMT';

describe('captureHeaders', () => {
  it('records the declared header set and drops everything else', () => {
    const h = cap({
      etag: 'abc123',
      'last-modified': 'Tue, 26 Aug 2026 13:00:00 GMT',
      date: DATE_14,
      age: '120',
      'cache-control': 'public, max-age=300',
      'cf-cache-status': 'HIT',
      'content-encoding': 'gzip',
      'content-length': '4242',
      'set-cookie': 'sessiontoken=leakme',
    });
    expect(h.etag).toBe('abc123');
    expect(h.age).toBe('120');
    expect(h.contentEncoding).toBe('gzip');
    expect(JSON.stringify(h)).not.toContain('leakme');
  });

  it('nulls absent headers rather than omitting the key', () => {
    const h = cap({});
    expect(h.etag).toBeNull();
    expect('etag' in h).toBe(true);
  });
});

describe('originDateMs', () => {
  it('is date minus age', () => {
    expect(originDateMs(cap({ date: DATE_14, age: '600' }))).toBe(Date.parse('2026-08-26T13:50:00Z'));
  });

  it('is null unless both headers are present', () => {
    expect(originDateMs(cap({ date: DATE_14 }))).toBeNull();
    expect(originDateMs(cap({ age: '600' }))).toBeNull();
  });
});

describe('isStaleGeneration', () => {
  it('rejects a response whose origin is older than what is already stored', () => {
    expect(isStaleGeneration(cap({ date: DATE_14, age: '3600' }), '2026-08-26T13:30:00.000Z')).toBe(true);
  });

  it('accepts a newer origin', () => {
    expect(isStaleGeneration(cap({ date: DATE_14, age: '60' }), '2026-08-26T13:30:00.000Z')).toBe(false);
  });

  it('accepts when either side is unknown, rather than blocking forever', () => {
    expect(isStaleGeneration(cap({}), '2026-08-26T13:30:00.000Z')).toBe(false);
    expect(isStaleGeneration(cap({ date: DATE_14, age: '60' }), null)).toBe(false);
  });

  it('accepts an equal origin, so a re-served identical generation is not a skip', () => {
    expect(isStaleGeneration(cap({ date: DATE_14, age: '1800' }), '2026-08-26T13:30:00.000Z')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/headers.test.ts`
Expected: FAIL, cannot resolve `../src/headers.js`

- [ ] **Step 3: Write `src/headers.ts`**

```ts
export type HeaderRecord = {
  fetchedAt: string;
  finalUrl: string;
  userAgent: string;
  status: number;
  etag: string | null;
  lastModified: string | null;
  date: string | null;
  age: string | null;
  cacheControl: string | null;
  cfCacheStatus: string | null;
  contentEncoding: string | null;
  contentLength: string | null;
};

/**
 * A fixed allowlist, not a dump. Response headers can carry Set-Cookie and
 * other per-request material, and this file is committed to a public archive.
 */
export function captureHeaders(
  res: { status: number; headers: Headers },
  meta: { fetchedAt: string; finalUrl: string; userAgent: string },
): HeaderRecord {
  const g = (k: string) => res.headers.get(k) ?? null;
  return {
    fetchedAt: meta.fetchedAt,
    finalUrl: meta.finalUrl,
    userAgent: meta.userAgent,
    status: res.status,
    etag: g('etag'),
    lastModified: g('last-modified'),
    date: g('date'),
    age: g('age'),
    cacheControl: g('cache-control'),
    cfCacheStatus: g('cf-cache-status'),
    contentEncoding: g('content-encoding'),
    contentLength: g('content-length'),
  };
}

/**
 * When the response was generated at origin, as distinct from when we saw it.
 * Every published timestamp derives from this and never from commit time:
 * OpenRouter serves stale-while-revalidate=3600, so an edge may hand back a
 * response up to about 65 minutes past freshness, which makes capture time an
 * upper bound on change time rather than the change time.
 */
export function originDateMs(h: HeaderRecord): number | null {
  if (h.date === null || h.age === null) return null;
  const d = Date.parse(h.date);
  const a = Number(h.age);
  if (Number.isNaN(d) || !Number.isFinite(a)) return null;
  return d - a * 1000;
}

/**
 * True when this response is an older cache generation than what is stored.
 *
 * Runners are spread across regions with no stable Cloudflare POP, so two
 * adjacent polls can land on edges holding different cache generations. Without
 * this check the archive records A, B, A, B for a value that changed once, and
 * the deriver emits a change event and a reversion event, both with honest
 * artifact links.
 */
export function isStaleGeneration(next: HeaderRecord, storedOriginIso: string | null): boolean {
  if (storedOriginIso === null) return false;
  const nextOrigin = originDateMs(next);
  if (nextOrigin === null) return false;
  const stored = Date.parse(storedOriginIso);
  if (Number.isNaN(stored)) return false;
  return nextOrigin < stored;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/headers.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/headers.ts test/headers.test.ts
git commit -m "feat: when it was made, not when we happened to see it"
```

---

---

### Task 4: The fetch layer

**Files:**
- Create: `src/fetch.ts`
- Test: `test/fetch.test.ts`

**Interfaces:**
- Consumes: `Source` from `src/config.ts`, `Observed` from `src/health.ts`, `HeaderRecord` and `captureHeaders` from `src/headers.ts`
- Produces:
  - `type FetchImpl = (url: string, init: RequestInit) => Promise<Response>`
  - `type FetchOutcome = { ok: true; observed: Observed; headers: HeaderRecord; attempts: number } | { ok: false; error: string; attempts: number }`
  - `fetchSource(source: Source, opts: FetchOpts): Promise<FetchOutcome>` where `FetchOpts = { userAgent: string; nowIso: () => string; fetchImpl?: FetchImpl; sleep?: (ms: number) => Promise<void> }`

`fetchImpl` and `sleep` are injected so every behaviour below is tested without a network and without real delays. The default `fetchImpl` is the global `fetch`.

Redirects are followed manually with `redirect: 'manual'`. The platform default would follow silently and hide the relocation the health check exists to surface.

- [ ] **Step 1: Write the failing test**

```ts
// test/fetch.test.ts
import { describe, it, expect, vi } from 'vitest';
import { fetchSource, type FetchImpl } from '../src/fetch.js';
import type { Source } from '../src/config.js';

const src = (over: Partial<Source> = {}): Source =>
  ({ id: 'x', url: 'https://a.example/f', timeoutS: 5, retries: 2, maxRedirects: 3, ...over } as Source);

const opts = (fetchImpl: FetchImpl) => ({
  userAgent: 'llm-catalog-archive/1.0 (+https://github.com/OWNER/REPO)',
  nowIso: () => '2026-08-26T14:00:00.000Z',
  fetchImpl,
  sleep: async () => {},
});

const res = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, ...init });

describe('fetchSource', () => {
  it('sends the declared UA and asks for gzip', async () => {
    const seen: RequestInit[] = [];
    const impl: FetchImpl = async (_u, i) => { seen.push(i); return res('ok'); };
    await fetchSource(src(), opts(impl));
    const h = new Headers(seen[0]!.headers);
    expect(h.get('user-agent')).toBe('llm-catalog-archive/1.0 (+https://github.com/OWNER/REPO)');
    expect(h.get('accept-encoding')).toContain('gzip');
    expect(seen[0]!.redirect).toBe('manual');
  });

  it('follows redirects manually and reports the final url and hop count', async () => {
    const impl: FetchImpl = async (u) => {
      if (u === 'https://a.example/f') return new Response(null, { status: 301, headers: { location: 'https://b.example/g' } });
      return res('final');
    };
    const out = await fetchSource(src(), opts(impl));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.observed.finalUrl).toBe('https://b.example/g');
    expect(out.observed.redirectCount).toBe(1);
    expect(new TextDecoder().decode(out.observed.body)).toBe('final');
  });

  it('resolves a relative Location against the current url', async () => {
    const impl: FetchImpl = async (u) => {
      if (u === 'https://a.example/f') return new Response(null, { status: 302, headers: { location: '/moved' } });
      return res('final');
    };
    const out = await fetchSource(src(), opts(impl));
    expect(out.ok && out.observed.finalUrl).toBe('https://a.example/moved');
  });

  it('stops at the redirect cap rather than looping', async () => {
    let n = 0;
    const impl: FetchImpl = async () => { n++; return new Response(null, { status: 301, headers: { location: `https://a.example/${n}` } }); };
    const out = await fetchSource(src({ maxRedirects: 3 }), opts(impl));
    expect(out.ok).toBe(false);
    expect(n).toBeLessThanOrEqual(5);
  });

  it('retries a 503 and succeeds', async () => {
    let n = 0;
    const impl: FetchImpl = async () => { n++; return n < 3 ? res('', { status: 503 }) : res('good'); };
    const out = await fetchSource(src({ retries: 2 }), opts(impl));
    expect(out.ok).toBe(true);
    expect(out.attempts).toBe(3);
  });

  it('retries a 429', async () => {
    let n = 0;
    const impl: FetchImpl = async () => { n++; return n < 2 ? res('', { status: 429 }) : res('good'); };
    expect((await fetchSource(src(), opts(impl))).ok).toBe(true);
  });

  it('does not retry a 404, because a missing page will still be missing', async () => {
    let n = 0;
    const impl: FetchImpl = async () => { n++; return res('nope', { status: 404 }); };
    const out = await fetchSource(src(), opts(impl));
    expect(out.ok).toBe(true);
    expect(out.attempts).toBe(1);
    expect(out.ok && out.observed.status).toBe(404);
  });

  it('retries a transport error and reports the failure when retries run out', async () => {
    let n = 0;
    const impl: FetchImpl = async () => { n++; throw new Error('ECONNRESET'); };
    const out = await fetchSource(src({ retries: 2 }), opts(impl));
    expect(out.ok).toBe(false);
    expect(out.attempts).toBe(3);
    expect(!out.ok && out.error).toMatch(/ECONNRESET/);
  });

  // A 25s timeout once truncated a body at 23,404 of 57,859 bytes and produced
  // unparseable JSON rather than an error status. A truncated body that happens
  // to still parse would otherwise be committed as a real change.
  it('treats a body shorter than content-length as a failure, not a success', async () => {
    const impl: FetchImpl = async () => res('short', { headers: { 'content-length': '57859' } });
    const out = await fetchSource(src({ retries: 0 }), opts(impl));
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toMatch(/truncated|content-length/i);
  });

  it('accepts a body when content-length is absent', async () => {
    const impl: FetchImpl = async () => res('fine');
    expect((await fetchSource(src(), opts(impl))).ok).toBe(true);
  });

  it('backs off 2s then 8s between attempts', async () => {
    const waits: number[] = [];
    const impl: FetchImpl = async () => res('', { status: 500 });
    await fetchSource(src({ retries: 2 }), { ...opts(impl), sleep: async (ms) => { waits.push(ms); } });
    expect(waits).toEqual([2000, 8000]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/fetch.test.ts`
Expected: FAIL, cannot resolve `../src/fetch.js`

- [ ] **Step 3: Write `src/fetch.ts`**

```ts
import type { Source } from './config.js';
import type { Observed } from './health.js';
import { captureHeaders, type HeaderRecord } from './headers.js';

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export type FetchOpts = {
  userAgent: string;
  nowIso: () => string;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
};

export type FetchOutcome =
  | { ok: true; observed: Observed; headers: HeaderRecord; attempts: number }
  | { ok: false; error: string; attempts: number };

const BACKOFF_MS = [2000, 8000];
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/** Retry only what a retry can fix. A 404 will still be a 404. */
function retryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

export async function fetchSource(source: Source, opts: FetchOpts): Promise<FetchOutcome> {
  const doFetch = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastError = 'unknown';
  const maxAttempts = source.retries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await sleep(BACKOFF_MS[Math.min(attempt - 2, BACKOFF_MS.length - 1)]!);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), source.timeoutS * 1000);

    try {
      let url = source.url;
      let redirectCount = 0;
      let response: Response | null = null;

      // Manual redirects: the platform default follows silently and would hide
      // the relocation that the health check exists to surface.
      for (;;) {
        const r: Response = await doFetch(url, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'user-agent': opts.userAgent, 'accept-encoding': 'gzip, deflate, br' },
        });
        if (REDIRECT_CODES.has(r.status)) {
          const loc = r.headers.get('location');
          if (loc === null) { response = r; break; }
          if (redirectCount >= source.maxRedirects) {
            clearTimeout(timer);
            return { ok: false, error: `redirect cap ${source.maxRedirects} exceeded at ${url}`, attempts: attempt };
          }
          redirectCount++;
          url = new URL(loc, url).toString();
          continue;
        }
        response = r;
        break;
      }

      const res = response!;
      if (retryableStatus(res.status) && attempt < maxAttempts) {
        lastError = `status ${res.status}`;
        clearTimeout(timer);
        continue;
      }

      const body = new Uint8Array(await res.arrayBuffer());
      clearTimeout(timer);

      const declared = res.headers.get('content-length');
      if (declared !== null && res.headers.get('content-encoding') === null) {
        const want = Number(declared);
        if (Number.isFinite(want) && body.byteLength < want) {
          lastError = `truncated body: got ${body.byteLength} of content-length ${want}`;
          if (attempt < maxAttempts) continue;
          return { ok: false, error: lastError, attempts: attempt };
        }
      }

      const fetchedAt = opts.nowIso();
      return {
        ok: true,
        attempts: attempt,
        observed: { status: res.status, body, finalUrl: url, redirectCount, headers: Object.fromEntries(res.headers) },
        headers: captureHeaders(res, { fetchedAt, finalUrl: url, userAgent: opts.userAgent }),
      };
    } catch (e) {
      clearTimeout(timer);
      lastError = String(e instanceof Error ? e.message : e);
      if (attempt >= maxAttempts) return { ok: false, error: lastError, attempts: attempt };
    }
  }
  return { ok: false, error: lastError, attempts: maxAttempts };
}
```

Note on R1 and encoding: the runtime decompresses `gzip` transparently and `res.arrayBuffer()` yields the **decoded entity body**, which is what R1 requires. `content-encoding` is recorded by `captureHeaders` so the wire form stays reconstructable. The `content-length` guard is skipped when `content-encoding` is present, because that header then describes the compressed length and comparing it to the decoded length would fail on every compressed response.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/fetch.test.ts`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add src/fetch.ts test/fetch.test.ts
git commit -m "feat: identify ourselves, follow moves on purpose, and refuse half a file"
```

---

---

### Task 5: A collector that actually collects

**Files:**
- Create: `src/git.ts`, `src/run.ts`, `src/cli.ts`
- Create: `.github/workflows/collect-daily.yml`
- Test: `test/git.test.ts`, `test/run.test.ts`

**Interfaces:**
- Consumes: `loadSources`, `activeSourcesForTier` from `src/config.ts`; `fetchSource` from `src/fetch.ts`; `captureHeaders` from `src/headers.ts`
- Produces:
  - `git(args: string[], cwd: string): { stdout: string; stderr: string; status: number }`
  - `commitPaths(cwd: string, paths: string[], message: string): boolean`
  - `pushWithRebase(cwd: string, branch: string, attempts?: number): void`
  - `type RunDeps`, `type RunResult`, `runTier(sources, tier, prevStatus, deps): Promise<RunResult>` (minimal shape; Tasks 6 through 10 extend it in place, Task 11 locks the ordering)

**This task is the point of the whole plan, and it is deliberately early.**

The archive's value compounds with elapsed time, and a day not collected is history that cannot be recovered. Everything after this task improves a collector that is already running; nothing after this task recovers a day that was missed while it was not.

**What is allowed to be missing here, and why.** A wrong snapshot committed by a degraded collector stays recoverable, because history keeps the good one beside it and R7 guarantees history is never rewritten. A missing day is simply gone. The asymmetry is the whole argument for shipping this before the health check, the magnitude guard, or the status store exist.

**What is not allowed to be missing here, because it is irreversible:**

| Must be right now | Why it cannot wait |
|---|---|
| `.gitattributes` marking `raw/**` as `-text -diff=auto` (Task 1) | Without it git may normalize line endings on write. The original bytes are then gone, not merely wrong, and R1 is silently violated in a way that looks correct in a working tree. |
| The path layout `raw/<id>/response.*` | Changing it later splits the history of a source across two paths and breaks `git log -p` on either. |
| The headers sidecar, committed with its body | Backfilling provenance onto commits that already exist is impossible under R7, so these commits would carry a permanent hole. |
| A change predicate, even a byte-comparison one | Committing on every run at 15 minute cadence is 35,000 commits a year of noise, permanently, in a history that can never be rewritten. |
| `status: "pending"` on the three volatile sources | `arena-leaderboard` (5.2 MB), `xai-llms-txt` (1.46 MB) and `openrouter-sitemap` (617 KB) each change on every request for reasons that are not content. Under a byte predicate they would commit a full blob daily until Task 8 lands, which at three weeks is a few hundred megabytes of junk that R7 makes permanent. They stay `pending` until their extractors exist. |

**What is knowingly deferred, with the deadline it must be closed by.** There is no `meta/status.json` yet, so there is no daily heartbeat, so the 60 day inactivity disable is not yet defended against. Thirteen active sources produce commits on most days, so the clock will not run out, but **Task 10 must land within 60 days of this task** and the plan is sequenced so it lands within days.

- [ ] **Step 1: Write the failing git test**

```ts
// test/git.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, commitPaths } from '../src/git.js';

let repo: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-'));
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
});

describe('commitPaths', () => {
  it('commits a changed file and reports true', () => {
    fs.mkdirSync(path.join(repo, 'raw/x'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'raw/x/response.json'), '{"a":1}');
    expect(commitPaths(repo, ['raw/x/response.json'], 'x: changed')).toBe(true);
    expect(git(['log', '--oneline'], repo).stdout).toContain('x: changed');
  });

  it('reports false and creates no commit when nothing changed', () => {
    fs.mkdirSync(path.join(repo, 'raw/x'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'raw/x/response.json'), '{"a":1}');
    commitPaths(repo, ['raw/x/response.json'], 'first');
    const before = git(['rev-list', '--count', 'HEAD'], repo).stdout.trim();
    expect(commitPaths(repo, ['raw/x/response.json'], 'second')).toBe(false);
    expect(git(['rev-list', '--count', 'HEAD'], repo).stdout.trim()).toBe(before);
  });

  it('stages only the paths it is given, leaving another session work alone', () => {
    fs.mkdirSync(path.join(repo, 'raw/x'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'raw/x/response.json'), '{"a":1}');
    fs.writeFileSync(path.join(repo, 'UNRELATED.md'), 'someone else was here');
    commitPaths(repo, ['raw/x/response.json'], 'x: changed');
    expect(git(['status', '--porcelain'], repo).stdout).toContain('UNRELATED.md');
  });

  // R1 is the load-bearing rule and this is the only test that can catch it
  // being violated by configuration rather than by code.
  it('stores bytes verbatim through a commit and checkout round trip', () => {
    fs.writeFileSync(path.join(repo, '.gitattributes'), 'raw/** -text -diff=auto\n');
    commitPaths(repo, ['.gitattributes'], 'attrs');
    fs.mkdirSync(path.join(repo, 'raw/y'), { recursive: true });
    const bytes = new Uint8Array([...new TextEncoder().encode('a\r\nb\r\nc'), 0xff]);
    const p = path.join(repo, 'raw/y/response.txt');
    fs.writeFileSync(p, bytes);
    commitPaths(repo, ['raw/y/response.txt'], 'y: changed');
    git(['checkout', '--', 'raw/y/response.txt'], repo);
    expect(new Uint8Array(fs.readFileSync(p))).toEqual(bytes);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/git.test.ts`
Expected: FAIL, cannot resolve `../src/git.js`

- [ ] **Step 3: Write `src/git.ts`**

```ts
import { spawnSync } from 'node:child_process';

export function git(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
}

/**
 * Stage exactly these paths and commit. Returns false when there was nothing
 * to commit, which is the ordinary no-change case and not an error.
 *
 * Paths are staged explicitly rather than with `git add -A`, because more than
 * one process can be working in a tree and sweeping up someone else's files is
 * how an unrelated change ships inside a collector commit.
 */
export function commitPaths(cwd: string, paths: string[], message: string): boolean {
  if (paths.length === 0) return false;
  const add = git(['add', '--', ...paths], cwd);
  if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}`);

  const staged = git(['diff', '--cached', '--name-only', '--', ...paths], cwd);
  if (staged.stdout.trim() === '') return false;

  const c = git(['commit', '-q', '-m', message, '--', ...paths], cwd);
  if (c.status !== 0) throw new Error(`git commit failed: ${c.stderr}`);
  return true;
}

/**
 * Pull with rebase, then push. Never force.
 *
 * A rejected non-fast-forward push must not be resolved by force-pushing:
 * permalinks are commit shas and R7 makes them permanent.
 */
export function pushWithRebase(cwd: string, branch: string, attempts = 3): void {
  let lastErr = '';
  for (let i = 0; i < attempts; i++) {
    const pull = git(['pull', '--rebase', 'origin', branch], cwd);
    if (pull.status !== 0) { lastErr = pull.stderr; continue; }
    const push = git(['push', 'origin', branch], cwd);
    if (push.status === 0) return;
    lastErr = push.stderr;
  }
  throw new Error(`push failed after ${attempts} attempts: ${lastErr}`);
}
```

- [ ] **Step 4: Write the failing run test**

```ts
// test/run.test.ts
import { describe, it, expect } from 'vitest';
import { runTier, type RunDeps } from '../src/run.js';
import type { Source } from '../src/config.js';

const enc = (s: string) => new TextEncoder().encode(s);
const HDR = { fetchedAt: '2026-08-26T14:00:00.000Z', finalUrl: 'https://a.example/f', userAgent: 'ua', status: 200,
  etag: null, lastModified: null, date: null, age: null, cacheControl: null, cfCacheStatus: null,
  contentEncoding: null, contentLength: null };

const source = (over: Partial<Source> = {}): Source => ({
  id: 'a', url: 'https://a.example/f', tier: 'daily', path: 'raw/a/response.txt', status: 'active',
  contentType: 'text', expectedRoot: null,
  invariants: { minBytes: 1, requiredKeyPath: null, minRecords: null, canary: 'CANARY', sizeBand: [0.1, 10] },
  freshness: { kind: 'none', maxQuietDays: null },
  predicate: { type: 'bytes' }, timeoutS: 5, retries: 0, maxRedirects: 3,
  rateLimit: { maxAutoEventsPerDay: 8 }, magnitudeGuard: { maxShrinkPct: 25 }, notes: '',
  ...over,
} as Source);

function deps(over: Partial<RunDeps> = {}, files: Record<string, Uint8Array> = {}) {
  const trace: string[] = [];
  const d: RunDeps = {
    cwd: '/tmp/fake',
    nowIso: () => '2026-08-26T14:00:00.000Z',
    fetchOne: async () => { trace.push('fetch'); return { ok: true as const, attempts: 1,
      observed: { status: 200, body: enc('CANARY\nline2'), finalUrl: 'https://a.example/f', redirectCount: 0, headers: {} },
      headers: HDR }; },
    readFile: (p) => files[p] ?? null,
    writeFile: (p, b) => { trace.push(`write:${p}`); files[p] = b; },
    commitPaths: (paths) => { trace.push(`commit:${paths.join(',')}`); return true; },
    push: () => { trace.push('push'); },
    log: () => {},
    ...over,
  };
  return Object.assign(d, { files, trace });
}

describe('runTier, minimal', () => {
  it('writes the body verbatim and commits it with its headers sidecar', async () => {
    const d = deps();
    await runTier([source()], 'daily', null, d);
    expect(d.files['raw/a/response.txt']).toEqual(enc('CANARY\nline2'));
    const c = d.trace.find((t) => t.startsWith('commit:'))!;
    expect(c).toContain('raw/a/response.txt');
    expect(c).toContain('raw/a/headers.json');
  });

  it('does not commit when the bytes are unchanged', async () => {
    const d = deps({}, { 'raw/a/response.txt': enc('CANARY\nline2') });
    await runTier([source()], 'daily', null, d);
    expect(d.trace.some((t) => t.startsWith('write:raw/a/response.txt'))).toBe(false);
  });

  it('skips a source marked pending, so a volatile source cannot pollute history early', async () => {
    const d = deps();
    await runTier([source({ status: 'pending' })], 'daily', null, d);
    expect(d.trace.some((t) => t === 'fetch')).toBe(false);
  });

  it('one failing source does not stop the others', async () => {
    let n = 0;
    const d = deps({ fetchOne: async () => {
      n++;
      if (n === 1) throw new Error('boom');
      return { ok: true as const, attempts: 1,
        observed: { status: 200, body: enc('CANARY\nb'), finalUrl: 'https://b.example/f', redirectCount: 0, headers: {} },
        headers: HDR };
    } });
    await runTier([source({ id: 'a' }), source({ id: 'b', url: 'https://b.example/f', path: 'raw/b/response.txt' })], 'daily', null, d);
    expect(d.files['raw/b/response.txt']).toEqual(enc('CANARY\nb'));
  });

  it('pushes once, after all commits', async () => {
    const d = deps();
    await runTier([source()], 'daily', null, d);
    expect(d.trace.filter((t) => t === 'push')).toHaveLength(1);
    expect(d.trace.lastIndexOf('push')).toBeGreaterThan(d.trace.findIndex((t) => t.startsWith('commit:')));
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `npx vitest run test/run.test.ts`
Expected: FAIL, cannot resolve `../src/run.js`

- [ ] **Step 6: Write the minimal `src/run.ts`**

```ts
import type { Source } from './config.js';
import type { FetchOutcome } from './fetch.js';
import type { StatusFile } from './status.js';

export type RunDeps = {
  cwd: string;
  nowIso: () => string;
  fetchOne: (s: Source) => Promise<FetchOutcome>;
  readFile: (p: string) => Uint8Array | null;
  writeFile: (p: string, b: Uint8Array) => void;
  commitPaths: (paths: string[], message: string) => boolean;
  push: () => void;
  log: (line: string) => void;
};

export type RunResult = { exitCode: number; status: StatusFile | null; trace: string[] };

const headersPathFor = (s: Source) => `raw/${s.id}/headers.json`;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * MINIMAL SHAPE. Tasks 6 through 10 insert the health check, the full predicate
 * dispatch, the magnitude guard and the status store into this pipeline, and
 * Task 11 locks the resulting order with tests that assert it.
 *
 * It ships in this state on purpose: a day not collected cannot be recovered,
 * while a wrong snapshot stays recoverable beside the right one in history.
 */
export async function runTier(
  sources: Source[],
  _tier: 'fast' | 'daily',
  _prevStatus: StatusFile | null,
  deps: RunDeps,
): Promise<RunResult> {
  const trace: string[] = [];

  for (const s of sources) {
    if (s.status !== 'active') { deps.log(`${s.id}: pending, skipped`); continue; }

    try {
      const got = await deps.fetchOne(s);
      if (!got.ok) { deps.log(`${s.id}: fetch failed after ${got.attempts} attempts: ${got.error}`); continue; }

      const stored = deps.readFile(s.path);
      if (stored !== null && sameBytes(got.observed.body, stored)) continue;

      // Verbatim. The bytes written are the bytes received, always.
      deps.writeFile(s.path, got.observed.body);
      deps.writeFile(headersPathFor(s), new TextEncoder().encode(JSON.stringify(got.headers, null, 2) + '\n'));
      deps.commitPaths([s.path, headersPathFor(s)], `${s.id}: changed (${got.observed.body.byteLength} bytes, HTTP ${got.observed.status})`);
      trace.push(`changed:${s.id}`);
      deps.log(`${s.id}: changed, ${got.observed.body.byteLength} bytes`);
    } catch (e) {
      // One unreachable source must never stop the other twelve.
      deps.log(`${s.id}: threw: ${String(e instanceof Error ? e.message : e)}`);
    }
  }

  deps.push();
  return { exitCode: 0, status: null, trace };
}
```

- [ ] **Step 7: Write `src/cli.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { loadSources, activeSourcesForTier } from './config.js';
import { fetchSource } from './fetch.js';
import { runTier } from './run.js';
import { commitPaths, pushWithRebase } from './git.js';

const cwd = process.cwd();
const i = process.argv.indexOf('--tier');
const tier = i === -1 ? undefined : process.argv[i + 1];
if (tier !== 'fast' && tier !== 'daily') { console.error('usage: collect --tier fast|daily'); process.exit(2); }

const readFile = (p: string): Uint8Array | null => {
  const abs = path.join(cwd, p);
  return fs.existsSync(abs) ? new Uint8Array(fs.readFileSync(abs)) : null;
};
const writeFile = (p: string, b: Uint8Array): void => {
  const abs = path.join(cwd, p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, b);
};

const file = loadSources(JSON.parse(fs.readFileSync(path.join(cwd, 'meta/sources.json'), 'utf8')));

const result = await runTier(activeSourcesForTier(file, tier), tier, null, {
  cwd,
  nowIso: () => new Date().toISOString(),
  fetchOne: (s) => fetchSource(s, { userAgent: file.userAgent, nowIso: () => new Date().toISOString() }),
  readFile,
  writeFile,
  commitPaths: (paths, message) => commitPaths(cwd, paths, message),
  push: () => { if (process.env.LCA_NO_PUSH !== '1') pushWithRebase(cwd, process.env.LCA_BRANCH ?? 'main'); },
  log: (l) => console.log(l),
});

process.exit(result.exitCode);
```

Fetching is serial here. Task 12 adds the politeness pool. Thirteen sources at a 60 second timeout is under fifteen minutes in the worst case and typically well under one, which is comfortably inside a daily slot.

- [ ] **Step 8: Run the whole suite**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 9: Dry run against the real world, without pushing**

```bash
LCA_NO_PUSH=1 npx tsx src/cli.ts --tier daily
git status --porcelain
git log --oneline -20
ls -la raw/*/
```

Expected: thirteen `raw/<id>/response.*` files with their `headers.json` sidecars, one commit per source, and the three `pending` sources absent with a "pending, skipped" log line each. Read every log line before continuing. Then confirm the no-change path:

```bash
LCA_NO_PUSH=1 npx tsx src/cli.ts --tier daily
git log --oneline -3
```

Expected: **no new commits.** If this produces commits, a source is changing on every request for a reason that is not content, and it must be marked `pending` before this ships rather than after, because those commits are permanent.

- [ ] **Step 10: Create the repository and go live**

```bash
gh repo create llm-catalog-archive --public --source=. --remote=origin --push
```

`.github/workflows/collect-daily.yml`:
```yaml
name: collect-daily
on:
  schedule: [{ cron: '20 0 * * *' }]
  workflow_dispatch:
concurrency: { group: collector-archive, cancel-in-progress: false }
permissions: { contents: write }
jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      - run: npm ci
      - name: Identify the committer
        run: |
          git config user.name 'llm-catalog-archive[bot]'
          git config user.email 'llm-catalog-archive@users.noreply.github.com'
      - run: npx tsx src/cli.ts --tier daily
        env: { LCA_BRANCH: main }
```

Then trigger it by hand and confirm it commits from CI, not just locally:

```bash
gh workflow run collect-daily.yml
sleep 90 && gh run list --workflow=collect-daily.yml --limit 1
git fetch origin && git log --oneline origin/main -5
```

**Do not proceed to Task 6 until a commit made by the workflow itself appears on `origin/main`.** Everything after this improves a running collector; this step is the difference between a running collector and a repository.

- [ ] **Step 11: Commit**

```bash
git add src/git.ts src/run.ts src/cli.ts test/git.test.ts test/run.test.ts .github/workflows/collect-daily.yml
git commit -m "feat: start collecting, because a missed day cannot be recovered"
```

---

### Task 6: Fixtures and the health predicate

**Files:**
- Create: `src/health.ts`, `test/fixtures/*` , `test/fixtures/README.md`
- Modify: `meta/sources.json` (real canary values)
- Test: `test/health.test.ts`

**Interfaces:**
- Consumes: `Source` from `src/config.ts`
- Produces:
  - `type HealthState = 'ok' | 'relocated' | 'failed' | 'stale'`
  - `type HealthVerdict = { state: HealthState; writeAllowed: boolean; countsAsFailure: boolean; reason: string | null }`
  - `type Observed = { status: number; body: Uint8Array; finalUrl: string; redirectCount: number; headers: Record<string, string> }`
  - `checkHealth(source: Source, obs: Observed, prev: { bytes: number | null }, nowMs: number): HealthVerdict`

The four states matter and are not interchangeable. `ok` and `relocated` allow the write; `failed` and `stale` do not. Only `failed` increments the consecutive-failure counter, because a provider with a genuinely quiet quarter must not produce a daily failure email, which is how alerting channels get muted.

- [ ] **Step 1: Capture the fixtures**

Each is a real captured response, not a synthetic. Run from the repo root:

```bash
mkdir -p test/fixtures
UA='llm-catalog-archive/1.0 (+https://github.com/OWNER/REPO)'
c() { curl -sS -m 60 -A "$UA" "$2" -o "test/fixtures/$1"; echo "$1 $(wc -c < test/fixtures/$1)"; }

c healthy-claude-llms.txt      https://platform.claude.com/llms.txt
c healthy-openrouter.json      https://openrouter.ai/api/v1/models
c healthy-anthropic-sitemap.xml https://www.anthropic.com/sitemap.xml
c trap-cohere-xhtml.xml        https://cohere.com/blog/rss.xml
c trap-qwen-stale.xml          https://qwenlm.github.io/blog/index.xml
c trap-anthropic-catchall.html https://alignment.anthropic.com/feed.xml
c trap-anthropic-404path.html  https://alignment.anthropic.com/zzz-not-a-real-path-9999
c trap-pytorch-tags.atom       https://github.com/pytorch/pytorch/releases.atom
c trap-neuron-403.html         https://www.theneurondaily.com/feed
curl -sS -m 60 -A "$UA" https://platform.openai.com/docs/llms.txt -o test/fixtures/trap-openai-redirect-stub.txt
```

Two must be verified rather than assumed, because both are the reason a fixture exists:

```bash
cmp -s test/fixtures/trap-anthropic-catchall.html test/fixtures/trap-anthropic-404path.html \
  && echo "OK: catch-all confirmed, a nonsense path returns the identical body" \
  || echo "STOP: catch-all no longer reproduces, re-derive this fixture"
wc -c test/fixtures/trap-openai-redirect-stub.txt   # expect ~81
```

If `trap-neuron-403.html` is no longer a Cloudflare page, hand-write `test/fixtures/trap-interstitial.html` containing the literal strings `Just a moment` and `__CF$cv$params` and use that instead. Record in `test/fixtures/README.md`, for every fixture: the URL, the capture date, the byte count, and the single property the fixture exists to prove. A fixture whose property has silently stopped being true is a test that proves nothing.

- [ ] **Step 2: Write the failing test**

```ts
// test/health.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { checkHealth, type Observed } from '../src/health.js';
import type { Source } from '../src/config.js';

const fx = (n: string) => new Uint8Array(fs.readFileSync(`test/fixtures/${n}`));

function src(over: Partial<Source> = {}): Source {
  return {
    id: 'x', url: 'https://example.com/f', tier: 'daily', path: 'raw/x/response.txt',
    contentType: 'text', expectedRoot: null,
    invariants: { minBytes: 1000, requiredKeyPath: null, minRecords: null, canary: '# Claude Docs', sizeBand: [0.5, 2.0] },
    freshness: { kind: 'none', maxQuietDays: null },
    predicate: { type: 'bytes' }, timeoutS: 60, retries: 2, maxRedirects: 3,
    rateLimit: { maxAutoEventsPerDay: 8 }, magnitudeGuard: { maxShrinkPct: 25 }, notes: '',
    ...over,
  } as Source;
}
const obs = (body: Uint8Array, over: Partial<Observed> = {}): Observed =>
  ({ status: 200, body, finalUrl: 'https://example.com/f', redirectCount: 0, headers: {}, ...over });

const NOW = Date.parse('2026-08-26T12:00:00Z');

describe('checkHealth', () => {
  it('passes a healthy text source carrying its canary', () => {
    const v = checkHealth(src(), obs(fx('healthy-claude-llms.txt')), { bytes: 63000 }, NOW);
    expect(v.state).toBe('ok');
    expect(v.writeAllowed).toBe(true);
  });

  it('fails a non-2xx', () => {
    const v = checkHealth(src(), obs(fx('healthy-claude-llms.txt'), { status: 503 }), { bytes: 63000 }, NOW);
    expect(v.state).toBe('failed');
    expect(v.writeAllowed).toBe(false);
  });

  // The trap that motivated the whole health section: a challenge page served at 200.
  it('refuses to write an interstitial even when it would otherwise pass', () => {
    const v = checkHealth(src({ invariants: { ...src().invariants, minBytes: 100, canary: 'Neuron' } }),
      obs(fx('trap-neuron-403.html'), { status: 200 }), { bytes: 6000 }, NOW);
    expect(v.writeAllowed).toBe(false);
    expect(v.reason).toMatch(/interstitial/i);
  });

  it('fails a text source whose canary has vanished', () => {
    const v = checkHealth(src({ invariants: { ...src().invariants, canary: 'THIS STRING IS NOT PRESENT' } }),
      obs(fx('healthy-claude-llms.txt')), { bytes: 63000 }, NOW);
    expect(v.state).toBe('failed');
    expect(v.reason).toMatch(/canary/i);
  });

  it('fails an 81-byte redirect body on size, which no parse check would catch', () => {
    const v = checkHealth(src(), obs(fx('trap-openai-redirect-stub.txt')), { bytes: 34432 }, NOW);
    expect(v.state).toBe('failed');
    expect(v.reason).toMatch(/min_?bytes|size/i);
  });

  it('fails a body outside the size band in either direction', () => {
    const big = new Uint8Array(200000).fill(65);
    const s = src({ invariants: { ...src().invariants, minBytes: 10, canary: null }, contentType: 'html' });
    expect(checkHealth(s, obs(big), { bytes: 1000 }, NOW).state).toBe('failed');
    expect(checkHealth(s, obs(new Uint8Array(10).fill(65)), { bytes: 1000 }, NOW).state).toBe('failed');
  });

  // Parsing is not enough: this file is accepted by an XML parser and is not a feed.
  it('fails the cohere XHTML that a parser accepts, on expectedRoot', () => {
    const s = src({ contentType: 'xml', expectedRoot: 'rss', invariants: { ...src().invariants, canary: null, minBytes: 100 } });
    const v = checkHealth(s, obs(fx('trap-cohere-xhtml.xml')), { bytes: 1000000 }, NOW);
    expect(v.state).toBe('failed');
    expect(v.reason).toMatch(/root/i);
  });

  it('marks a 337-day-stale feed stale, not failed, so it never drives the exit code', () => {
    const s = src({ contentType: 'xml', expectedRoot: 'rss', freshness: { kind: 'feed', maxQuietDays: 60 },
                    invariants: { ...src().invariants, canary: null, minBytes: 100 } });
    const v = checkHealth(s, obs(fx('trap-qwen-stale.xml')), { bytes: 100000 }, NOW);
    expect(v.state).toBe('stale');
    expect(v.writeAllowed).toBe(false);
    expect(v.countsAsFailure).toBe(false);
  });

  it('marks a moved URL relocated, allows the write, and says so', () => {
    const v = checkHealth(src(), obs(fx('healthy-claude-llms.txt'), { finalUrl: 'https://elsewhere.example/f', redirectCount: 1 }), { bytes: 63000 }, NOW);
    expect(v.state).toBe('relocated');
    expect(v.writeAllowed).toBe(true);
    expect(v.reason).toContain('elsewhere.example');
  });

  it('fails when the redirect budget is exhausted', () => {
    const v = checkHealth(src(), obs(fx('healthy-claude-llms.txt'), { redirectCount: 4 }), { bytes: 63000 }, NOW);
    expect(v.state).toBe('failed');
    expect(v.reason).toMatch(/redirect/i);
  });

  it('checks a json required key path and record floor', () => {
    const s = src({ contentType: 'json', invariants: { minBytes: 10, requiredKeyPath: 'data', minRecords: 300, canary: null, sizeBand: [0.5, 2.0] } });
    const ok = checkHealth(s, obs(fx('healthy-openrouter.json')), { bytes: 687878 }, NOW);
    expect(ok.state).toBe('ok');
    const collapsed = new TextEncoder().encode(JSON.stringify({ data: [1, 2, 3] }));
    const bad = checkHealth({ ...s, invariants: { ...s.invariants, sizeBand: [0.0001, 100] } }, obs(collapsed), { bytes: 687878 }, NOW);
    expect(bad.state).toBe('failed');
    expect(bad.reason).toMatch(/records/i);
  });

  it('does not apply the size band on the first ever fetch', () => {
    const v = checkHealth(src(), obs(fx('healthy-claude-llms.txt')), { bytes: null }, NOW);
    expect(v.state).toBe('ok');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/health.test.ts`
Expected: FAIL, cannot resolve `../src/health.js`

- [ ] **Step 4: Write `src/health.ts`**

```ts
import type { Source } from './config.js';

export type HealthState = 'ok' | 'relocated' | 'failed' | 'stale';

export type HealthVerdict = {
  state: HealthState;
  /** ok and relocated write. failed and stale do not. */
  writeAllowed: boolean;
  /** only `failed` advances the consecutive-failure counter. */
  countsAsFailure: boolean;
  reason: string | null;
};

export type Observed = {
  status: number;
  body: Uint8Array;
  finalUrl: string;
  redirectCount: number;
  headers: Record<string, string>;
};

/**
 * Strings that appear in bot-challenge and block pages. A challenge page can
 * carry a source's canary by accident (the canary is often a word from the
 * site's own chrome), so this list is checked independently rather than being
 * folded into the canary check.
 */
const INTERSTITIAL = ['__CF$cv$params', 'cf-mitigated', 'Just a moment', 'Enable JavaScript and cookies to continue', 'Attention Required!'];

const fail = (reason: string): HealthVerdict => ({ state: 'failed', writeAllowed: false, countsAsFailure: true, reason });

export function checkHealth(source: Source, obs: Observed, prev: { bytes: number | null }, nowMs: number): HealthVerdict {
  if (obs.status < 200 || obs.status >= 300) return fail(`status ${obs.status}`);
  if (obs.redirectCount > source.maxRedirects) return fail(`redirect budget exhausted (${obs.redirectCount} > ${source.maxRedirects})`);

  const text = new TextDecoder('utf-8', { fatal: false }).decode(obs.body);
  const inv = source.invariants;

  if (obs.body.byteLength < inv.minBytes) return fail(`below min_bytes (${obs.body.byteLength} < ${inv.minBytes})`);

  // Size band is relative to the last accepted snapshot, so it cannot apply to the first fetch.
  if (prev.bytes !== null && prev.bytes > 0) {
    const [lo, hi] = inv.sizeBand;
    const ratio = obs.body.byteLength / prev.bytes;
    if (ratio < lo || ratio > hi) return fail(`size ratio ${ratio.toFixed(3)} outside band [${lo}, ${hi}]`);
  }

  for (const marker of INTERSTITIAL) {
    if (text.includes(marker)) return fail(`interstitial marker present: ${marker}`);
  }

  if (inv.canary !== null && !text.includes(inv.canary)) return fail(`canary absent: ${JSON.stringify(inv.canary)}`);

  if (source.contentType === 'json') {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (e) { return fail(`json parse failed: ${String(e)}`); }
    if (inv.requiredKeyPath !== null) {
      const v = (parsed as Record<string, unknown> | null)?.[inv.requiredKeyPath];
      if (v === undefined) return fail(`required key path absent: ${inv.requiredKeyPath}`);
      if (inv.minRecords !== null) {
        if (!Array.isArray(v) || v.length < inv.minRecords) {
          return fail(`records below floor (${Array.isArray(v) ? v.length : 'not an array'} < ${inv.minRecords})`);
        }
      }
    }
  }

  if (source.contentType === 'xml') {
    // Deliberately not a full parser. The cohere trap is 1MB of XHTML that a
    // real XML parser ACCEPTS, so the root element is the discriminating check,
    // and a parser would have said yes.
    const root = text.replace(/^﻿/, '').match(/<\?xml[^>]*\?>\s*(?:<!--[\s\S]*?-->\s*)*<([A-Za-z_][\w.:-]*)/);
    if (!root) return fail('no xml root element found');
    const name = root[1]!.replace(/^.*:/, '');
    if (source.expectedRoot !== null && name !== source.expectedRoot) {
      return fail(`root element is <${name}>, expected <${source.expectedRoot}>`);
    }
  }

  if (source.freshness.kind === 'feed' && source.freshness.maxQuietDays !== null) {
    const newest = newestFeedDate(text);
    if (newest === null) return fail('feed carries no parseable item date');
    const days = (nowMs - newest) / 86_400_000;
    if (days > source.freshness.maxQuietDays) {
      // Stale, not failed. A quiet quarter on an incident feed is good news, and
      // a daily failure email for good news is how an alerting channel gets muted.
      return { state: 'stale', writeAllowed: false, countsAsFailure: false, reason: `newest item ${Math.round(days)} days old` };
    }
  }

  if (obs.finalUrl !== source.url) {
    return { state: 'relocated', writeAllowed: true, countsAsFailure: false, reason: `final url is ${obs.finalUrl}, declared ${source.url}` };
  }

  return { state: 'ok', writeAllowed: true, countsAsFailure: false, reason: null };
}

/** Newest of every published/updated/pubDate/dc:date in the document, or null. */
export function newestFeedDate(text: string): number | null {
  let newest: number | null = null;
  const re = /<(?:published|updated|pubDate|dc:date)>([^<]+)<\//g;
  for (const m of text.matchAll(re)) {
    const t = Date.parse(m[1]!.trim());
    if (!Number.isNaN(t) && (newest === null || t > newest)) newest = t;
  }
  return newest;
}
```

- [ ] **Step 5: Fill in real canary values**

For each of the eight text sources, pick a heading that has been stable for months and put it in `meta/sources.json`. Verify each is actually present:

```bash
for f in test/fixtures/healthy-*.txt; do grep -c '^# ' "$f"; done
```

Choose from the top-level headings, not from anything version-numbered or dated. A canary containing a model name or a date will expire.

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/health.test.ts`
Expected: PASS, 12 tests

- [ ] **Step 7: Commit**

```bash
git add src/health.ts test/health.test.ts test/fixtures meta/sources.json
git commit -m "feat: a 200 is not a yes, and a parser saying yes is not either"
```

---

---

### Task 7: Change predicates, bytes and mask

**Files:**
- Create: `src/predicates.ts`
- Test: `test/predicates.test.ts`

**Interfaces:**
- Consumes: `Source` from `src/config.ts`
- Produces: `hasChanged(source: Source, next: Uint8Array, prev: Uint8Array | null): boolean`

R1 governs what is written. It does not govern whether to write, so this module may look inside the response. The bytes handed to the writer are always the untouched ones.

- [ ] **Step 1: Write the failing test**

```ts
// test/predicates.test.ts
import { describe, it, expect } from 'vitest';
import { hasChanged } from '../src/predicates.js';
import type { Source } from '../src/config.js';

const enc = (s: string) => new TextEncoder().encode(s);
const src = (predicate: Source['predicate']): Source => ({ predicate } as Source);

describe('hasChanged', () => {
  it('is true when there is nothing stored yet', () => {
    expect(hasChanged(src({ type: 'bytes' }), enc('a'), null)).toBe(true);
  });

  it('bytes: identical bodies do not commit', () => {
    expect(hasChanged(src({ type: 'bytes' }), enc('same'), enc('same'))).toBe(false);
  });

  it('bytes: one differing byte commits', () => {
    expect(hasChanged(src({ type: 'bytes' }), enc('same'), enc('sam3'))).toBe(true);
  });

  it('mask: ignores declared volatile regions', () => {
    const s = src({ type: 'mask', patterns: ['"userId":"[0-9a-f-]+"'] });
    expect(hasChanged(s, enc('x"userId":"01a03e6c-bb55"y'), enc('x"userId":"01a03e6d-abfb"y'))).toBe(false);
  });

  it('mask: still sees a real change beside a masked one', () => {
    const s = src({ type: 'mask', patterns: ['"userId":"[0-9a-f-]+"'] });
    expect(hasChanged(s, enc('rank:1 "userId":"aa-bb"'), enc('rank:2 "userId":"cc-dd"'))).toBe(true);
  });

  it('mask: a pattern that matches nothing degrades to bytes rather than passing everything', () => {
    const s = src({ type: 'mask', patterns: ['NEVER_MATCHES_ANYTHING'] });
    expect(hasChanged(s, enc('a'), enc('b'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/predicates.test.ts`
Expected: FAIL, cannot resolve `../src/predicates.js`

- [ ] **Step 3: Write `src/predicates.ts`**

```ts
import type { Source } from './config.js';

const dec = new TextDecoder('utf-8', { fatal: false });

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Whether this response is worth a commit. Never mutates or returns bytes:
 * the caller writes `next` unchanged whatever this says.
 */
export function hasChanged(source: Source, next: Uint8Array, prev: Uint8Array | null): boolean {
  if (prev === null) return true;
  const p = source.predicate;

  if (p.type === 'bytes') return !sameBytes(next, prev);

  if (p.type === 'mask') {
    const mask = (u: Uint8Array) => {
      let s = dec.decode(u);
      for (const pat of p.patterns) s = s.replace(new RegExp(pat, 'g'), '<MASKED>');
      return s;
    };
    return mask(next) !== mask(prev);
  }

  // Task 8 replaces this branch. Throwing rather than falling back to `bytes`
  // is deliberate: a silent fallback is exactly how a 5MB source reverts to
  // committing every run without anyone noticing.
  throw new Error(`extracted predicate not yet implemented: ${p.extractor}`);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/predicates.test.ts`
Expected: PASS, 6 tests. The `extracted` branch throws for now and Task 5 replaces it; no test in this task exercises it.

- [ ] **Step 5: Commit**

```bash
git add src/predicates.ts test/predicates.test.ts
git commit -m "feat: decide whether to write by looking, and write what arrived"
```

---

---

### Task 8: The three extractors, and the codename filter

**Files:**
- Create: `src/extractors/arena.ts`, `src/extractors/xai.ts`, `src/extractors/sitemapLoc.ts`
- Modify: `src/predicates.ts` (replace the throwing branch), `meta/sources.json` (flip the three volatile sources to `status: "active"`)
- Test: `test/extractors.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `extractArena(html: string): ArenaRecord[]` where `ArenaRecord = { publicName: string; displayName: string; rating: string | null; votes: string | null }`
  - `isLabelVariant(publicName: string, displayName: string): boolean`
  - `normalizeXai(text: string): string`
  - `extractLocSet(xml: string): string[]`

- [ ] **Step 1: Capture the extractor fixtures**

```bash
UA='llm-catalog-archive/1.0 (+https://github.com/OWNER/REPO)'
curl -sS -m 90 -A "$UA" https://arena.ai/leaderboard      -o test/fixtures/arena-a.html
sleep 300
curl -sS -m 90 -A "$UA" https://arena.ai/leaderboard      -o test/fixtures/arena-b.html
curl -sS -m 90 -A "$UA" https://docs.x.ai/llms.txt        -o test/fixtures/xai-a.txt
sleep 5
curl -sS -m 90 -A "$UA" https://docs.x.ai/llms.txt        -o test/fixtures/xai-b.txt
curl -sS -m 90 -A "$UA" https://openrouter.ai/sitemap.xml -o test/fixtures/or-sitemap.xml
cmp -s test/fixtures/arena-a.html test/fixtures/arena-b.html && echo "STOP: arena fetches identical, re-capture further apart" || echo "OK: arena differs, as expected"
cmp -s test/fixtures/xai-a.txt test/fixtures/xai-b.txt && echo "STOP: xai fetches identical, the permutation may have been fixed upstream" || echo "OK: xai differs, as expected"
```

Both `cmp` checks must print OK. If either prints STOP, the fixture cannot prove the property the test asserts, and the test would pass vacuously.

- [ ] **Step 2: Write the failing test**

```ts
// test/extractors.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { extractArena, isLabelVariant } from '../src/extractors/arena.js';
import { normalizeXai } from '../src/extractors/xai.js';
import { extractLocSet } from '../src/extractors/sitemapLoc.js';
import { hasChanged } from '../src/predicates.js';
import type { Source } from '../src/config.js';

const f = (n: string) => fs.readFileSync(`test/fixtures/${n}`, 'utf8');
const b = (n: string) => new Uint8Array(fs.readFileSync(`test/fixtures/${n}`));

describe('extractArena', () => {
  it('finds over 500 records, using the backslash-escaped form', () => {
    // The bare `"publicName":"` form matches ZERO times: the payload is an
    // escaped RSC flight chunk. Getting this wrong silently yields no records.
    expect(f('arena-a.html')).not.toContain('"publicName":"');
    expect(extractArena(f('arena-a.html')).length).toBeGreaterThan(500);
  });

  it('is stable across two fetches that differ as raw bytes', () => {
    expect(b('arena-a.html')).not.toEqual(b('arena-b.html'));
    expect(extractArena(f('arena-a.html'))).toEqual(extractArena(f('arena-b.html')));
  });

  it('makes the arena predicate quiet across those same two fetches', () => {
    const s = { predicate: { type: 'extracted', extractor: 'arena' } } as Source;
    expect(hasChanged(s, b('arena-b.html'), b('arena-a.html'))).toBe(false);
  });

  it('still sees a genuine record change', () => {
    const s = { predicate: { type: 'extracted', extractor: 'arena' } } as Source;
    const tampered = new TextEncoder().encode(f('arena-a.html').replace('\\"publicName\\":\\"', '\\"publicName\\":\\"zzz-'));
    expect(hasChanged(s, tampered, b('arena-a.html'))).toBe(true);
  });
});

describe('isLabelVariant', () => {
  // Enumerates the VARIANT shape. Everything else is a reveal. The inverse
  // (guessing what a codename looks like) misses anonymous-0410, k2, cold_brew,
  // onyx-v1-4, lo-bah-png and may-alpha, all of which are real reveals.
  it.each([
    ['grok-4.6', 'grok-4.6-high'],
    ['glm-5.3', 'glm-5.3 (max)'],
    ['gpt-5.4-no-system-prompt', 'gpt-5.4'],
    ['claude-sonnet-5', 'claude-sonnet-5-high'],
    ['deepseek-v4-flash', 'deepseek-v4-flash-20260731'],
    ['trinity-large', 'trinity-large-preview'],
    ['inkling-small-rc-3', 'inkling-small'],
  ])('classifies %s -> %s as a label variant', (p, d) => {
    expect(isLabelVariant(p, d)).toBe(true);
  });

  it.each([
    ['kiteki', 'qwen3.5-max-preview'],
    ['deep-octo', 'minimax-m2.7'],
    ['significant-otter', 'gemma-4-26b-a4b'],
    ['thunbergia-alpha', 'qwen3.8-max'],
    ['august26-chatbot1', 'nvidia-nemotron-3.5-lightning-30b-a3b-nvfp4'],
    ['anonymous-0410', 'openhard-1.0-search-non-reasoning-0410'],
    ['cold_brew', 'muse-video'],
    ['onyx-v1-4', 'muse-glimmer'],
    ['lo-bah-png', 'mai-image-2.6-preview'],
    ['may-alpha', 'qwen3.7-plus-preview'],
  ])('classifies %s -> %s as a genuine reveal', (p, d) => {
    expect(isLabelVariant(p, d)).toBe(false);
  });

  it('reveals are the majority of differing rows in the live fixture', () => {
    const diff = extractArena(f('arena-a.html')).filter((r) => r.publicName !== r.displayName);
    const reveals = diff.filter((r) => !isLabelVariant(r.publicName, r.displayName));
    expect(diff.length).toBeGreaterThanOrEqual(40);
    expect(reveals.length / diff.length).toBeGreaterThan(0.5);
  });
});

describe('normalizeXai', () => {
  it('collapses two permuted fetches to the same string', () => {
    expect(b('xai-a.txt')).not.toEqual(b('xai-b.txt'));
    expect(normalizeXai(f('xai-a.txt'))).toBe(normalizeXai(f('xai-b.txt')));
  });

  it('keeps a real content change visible', () => {
    expect(normalizeXai(f('xai-a.txt') + '\n| new-model | 1 | 2 |\n')).not.toBe(normalizeXai(f('xai-a.txt')));
  });

  it('sorts rows only inside table blocks, so prose order survives', () => {
    const doc = '# B heading\n\nsecond para\n\n# A heading\n\nfirst para\n';
    expect(normalizeXai(doc)).toBe(doc);
  });
});

describe('extractLocSet', () => {
  it('returns a sorted loc set and ignores lastmod entirely', () => {
    const locs = extractLocSet(f('or-sitemap.xml'));
    expect(locs.length).toBeGreaterThan(1000);
    expect([...locs]).toEqual([...locs].sort());
    const churned = f('or-sitemap.xml').replace(/<lastmod>[^<]*<\/lastmod>/g, '<lastmod>2099-01-01T00:00:00.000Z</lastmod>');
    expect(extractLocSet(churned)).toEqual(locs);
  });

  it('sees an added url', () => {
    const added = f('or-sitemap.xml').replace('</urlset>', '<url><loc>https://openrouter.ai/zzz-new</loc></url></urlset>');
    expect(extractLocSet(added).length).toBe(extractLocSet(f('or-sitemap.xml')).length + 1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/extractors.test.ts`
Expected: FAIL, cannot resolve `../src/extractors/arena.js`

- [ ] **Step 4: Write `src/extractors/arena.ts`**

```ts
export type ArenaRecord = { publicName: string; displayName: string; rating: string | null; votes: string | null };

/**
 * The leaderboard is embedded in a Next.js RSC flight payload, so every quote
 * is backslash-escaped. Matching the bare `"publicName":"` form returns ZERO
 * records and looks like an empty leaderboard rather than a bug.
 */
const PUBLIC = /\\"publicName\\":\\"(.*?)\\"/g;
const DISPLAY = /\\"displayName\\":\\"(.*?)\\"/g;
const RATING = /\\"rating\\":([0-9.]+)/g;
const VOTES = /\\"votes\\":([0-9]+)/g;

const all = (re: RegExp, s: string) => [...s.matchAll(re)].map((m) => m[1]!);

export function extractArena(html: string): ArenaRecord[] {
  const pub = all(PUBLIC, html);
  const disp = all(DISPLAY, html);
  const rating = all(RATING, html);
  const votes = all(VOTES, html);

  // An undocumented framework payload will change shape without notice, and a
  // silent drop to zero records would make the predicate report "no change"
  // forever. Fail loudly instead.
  if (pub.length < 500) throw new Error(`arena payload yielded only ${pub.length} records; extraction shape has changed`);
  if (pub.length !== disp.length) throw new Error(`arena publicName/displayName count mismatch: ${pub.length} vs ${disp.length}`);

  return pub.map((publicName, i) => ({
    publicName,
    displayName: disp[i]!,
    rating: rating[i] ?? null,
    votes: votes[i] ?? null,
  }));
}

const SUFFIXES = ['high', 'low', 'medium', 'xhigh', 'thinking', 'preview', 'max', 'no-system-prompt'];

/** Split on non-alphanumerics, drop the noise words a variant adds. */
function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().split(/[^a-z0-9.]+/).filter((t) => t.length > 1 && !SUFFIXES.includes(t) && !/^\d{8}$/.test(t)),
  );
}

/**
 * A row is a LABEL VARIANT iff the two names share a meaningful token: a
 * suffix addition, a trailing date, or a parenthetical. Everything else is a
 * genuine codename reveal.
 *
 * The filter is written this way round on purpose. Measured on the live
 * payload, reveals are about 39 of 61 differing rows, so guessing the reveal
 * shape (nonsense word, animal name, month-year-chatbotN) suppresses roughly
 * thirty real reveals per cycle, which is a false-negative rate on the single
 * most distinctive signal the archive produces.
 */
export function isLabelVariant(publicName: string, displayName: string): boolean {
  if (publicName === displayName) return true;
  const a = tokens(publicName);
  const b = tokens(displayName);
  if (a.size === 0 || b.size === 0) return false;
  for (const t of a) if (b.has(t)) return true;
  return false;
}
```

- [ ] **Step 5: Write `src/extractors/xai.ts`**

```ts
/**
 * docs.x.ai/llms.txt re-permutes rows inside markdown tables on every request:
 * three fetches gave three md5s at an identical 1,465,407 bytes, while
 * `sort | md5` was identical every time.
 *
 * Sorting the WHOLE file would also work for equality, and is wrong: it would
 * destroy the deriver's ability to see a legitimate section reorder. Only
 * contiguous table-body runs are sorted.
 */
export function normalizeXai(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let block: string[] = [];

  const isRow = (l: string) => l.trimStart().startsWith('|');
  const isSeparator = (l: string) => /^\s*\|[\s:|-]+\|\s*$/.test(l);

  const flush = () => {
    if (block.length > 1) out.push(...block.slice().sort());
    else out.push(...block);
    block = [];
  };

  for (const line of lines) {
    // A header row and its separator anchor the table; only the body is sorted.
    if (isRow(line) && !isSeparator(line)) { block.push(line); continue; }
    flush();
    out.push(line);
  }
  flush();
  return out.join('\n');
}
```

Note the header row is swept into the sorted block by this implementation. That is acceptable for an equality predicate and is why the test asserts round-trip equality rather than exact output. If a later task needs the header preserved in place, anchor on the separator line.

- [ ] **Step 6: Write `src/extractors/sitemapLoc.ts`**

```ts
/**
 * openrouter.ai/sitemap.xml is rebuilt several times a day and each rebuild
 * stamps roughly 100 <lastmod> values with a fresh millisecond timestamp
 * independent of any content change. Keying on the <loc> set alone reduces the
 * source to add/remove detection, which is all it can honestly support.
 */
export function extractLocSet(xml: string): string[] {
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!.trim());
  return [...new Set(locs)].sort();
}
```

- [ ] **Step 7: Replace the throwing branch in `src/predicates.ts`**

```ts
import { extractArena } from './extractors/arena.js';
import { normalizeXai } from './extractors/xai.js';
import { extractLocSet } from './extractors/sitemapLoc.js';
```

and replace the `throw` with:

```ts
  const project = (u: Uint8Array): string => {
    const s = dec.decode(u);
    if (p.extractor === 'arena') return JSON.stringify(extractArena(s));
    if (p.extractor === 'xai') return normalizeXai(s);
    return JSON.stringify(extractLocSet(s));
  };
  return project(next) !== project(prev);
}
```

- [ ] **Step 8: Run tests**

Run: `npx vitest run test/extractors.test.ts test/predicates.test.ts`
Expected: PASS, all tests

- [ ] **Step 9: Activate the three volatile sources**

They have been `status: "pending"` since Task 2 precisely so they could not
commit a full blob per run under a byte predicate. Flip all three to `"active"`
in `meta/sources.json`, then prove the predicates hold before letting them near
the archive:

```bash
LCA_NO_PUSH=1 npx tsx src/cli.ts --tier daily
LCA_NO_PUSH=1 npx tsx src/cli.ts --tier daily
git log --oneline -6
```

Expected: the first run commits three new sources, the second commits nothing
at all. If the second run commits, an extractor is not covering every volatile
region and that source goes straight back to `pending`. Under R7 those commits
cannot be removed later.

- [ ] **Step 10: Commit**

```bash
git add src/extractors test/extractors.test.ts src/predicates.ts
git commit -m "feat: three sources that change every request without changing"
```

---

---

### Task 9: The magnitude guard

**Files:**
- Create: `src/magnitude.ts`
- Test: `test/magnitude.test.ts`

**Interfaces:**
- Consumes: `Source` from `src/config.ts`
- Produces:
  - `type GuardVerdict = { hold: boolean; reason: string | null; prevCount: number; nextCount: number }`
  - `countUnits(contentType: Source['contentType'], body: Uint8Array): number`
  - `checkMagnitude(source: Source, next: Uint8Array, prev: Uint8Array | null): GuardVerdict`

Deliberately separate from the health check. Health catches **known** unhealthy shapes: the traps in the fixture list, the canary, the denylist. It cannot catch an unknown one, and the next failure will not be a Cloudflare page. This is the general case, of which "the doc index shrank from 616 entries to 4 and every check said fine" is one instance.

A hold is not a source failure: the run exits zero and does not increment the failure counter.

- [ ] **Step 1: Write the failing test**

```ts
// test/magnitude.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { checkMagnitude, countUnits } from '../src/magnitude.js';
import type { Source } from '../src/config.js';

const enc = (s: string) => new TextEncoder().encode(s);
const src = (contentType: Source['contentType'], maxShrinkPct = 25): Source =>
  ({ contentType, magnitudeGuard: { maxShrinkPct }, invariants: { requiredKeyPath: 'data' } } as Source);

describe('countUnits', () => {
  it('counts json array entries under the required key', () => {
    expect(countUnits('json', enc(JSON.stringify({ data: [1, 2, 3] })))).toBe(3);
  });
  it('counts lines for text', () => {
    expect(countUnits('text', enc('a\nb\nc'))).toBe(3);
  });
  it('counts elements for xml', () => {
    expect(countUnits('xml', enc('<urlset><url><loc>a</loc></url><url><loc>b</loc></url></urlset>'))).toBe(2);
  });
});

describe('checkMagnitude', () => {
  it('never holds the first ever snapshot', () => {
    expect(checkMagnitude(src('text'), enc('a\nb'), null).hold).toBe(false);
  });

  it('does not hold growth, however large', () => {
    const prev = enc(Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n'));
    const next = enc(Array.from({ length: 5000 }, (_, i) => `l${i}`).join('\n'));
    expect(checkMagnitude(src('text'), next, prev).hold).toBe(false);
  });

  it('does not hold a shrink inside the threshold', () => {
    const prev = enc(Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n'));
    const next = enc(Array.from({ length: 80 }, (_, i) => `l${i}`).join('\n'));
    expect(checkMagnitude(src('text'), next, prev).hold).toBe(false);
  });

  it('holds a shrink past the threshold and says by how much', () => {
    const prev = enc(Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n'));
    const next = enc(Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n'));
    const v = checkMagnitude(src('text'), next, prev);
    expect(v.hold).toBe(true);
    expect(v.prevCount).toBe(100);
    expect(v.nextCount).toBe(50);
    expect(v.reason).toMatch(/50(\.0)?%/);
  });

  // The scenario the guard exists for, at real scale.
  it('holds the 616-entry doc index collapsing to 4', () => {
    const prev = enc(Array.from({ length: 616 }, (_, i) => `- [Page ${i}](https://x/${i}.md)`).join('\n'));
    const next = enc('- [A](https://x/a.md)\n- [B](https://x/b.md)\n- [C](https://x/c.md)\n- [D](https://x/d.md)');
    expect(checkMagnitude(src('text'), next, prev).hold).toBe(true);
  });

  it('holds a json catalog collapsing from 417 to 3', () => {
    const prev = enc(JSON.stringify({ data: Array.from({ length: 417 }, (_, i) => ({ id: i })) }));
    const next = enc(JSON.stringify({ data: [{ id: 1 }, { id: 2 }, { id: 3 }] }));
    expect(checkMagnitude(src('json'), next, prev).hold).toBe(true);
  });

  it('a zero previous count cannot divide by zero', () => {
    expect(checkMagnitude(src('text'), enc(''), enc('')).hold).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/magnitude.test.ts`
Expected: FAIL, cannot resolve `../src/magnitude.js`

- [ ] **Step 3: Write `src/magnitude.ts`**

```ts
import type { Source } from './config.js';

export type GuardVerdict = { hold: boolean; reason: string | null; prevCount: number; nextCount: number };

const dec = new TextDecoder('utf-8', { fatal: false });

/** Entries for structured sources, lines for text. */
export function countUnits(contentType: Source['contentType'], body: Uint8Array, requiredKeyPath: string | null = 'data'): number {
  const s = dec.decode(body);
  if (contentType === 'json') {
    try {
      const parsed = JSON.parse(s) as unknown;
      const v = requiredKeyPath === null ? parsed : (parsed as Record<string, unknown> | null)?.[requiredKeyPath];
      if (Array.isArray(v)) return v.length;
      if (v && typeof v === 'object') return Object.keys(v).length;
      return 0;
    } catch { return 0; }
  }
  if (contentType === 'xml') {
    const loc = (s.match(/<loc>/g) ?? []).length;
    if (loc > 0) return loc;
    return (s.match(/<(?:item|entry|url)\b/g) ?? []).length;
  }
  return s.split('\n').filter((l) => l.length > 0).length;
}

/**
 * Growth is not guarded. A source doubling is a story; a source vanishing is
 * usually a bug, and the asymmetry is deliberate.
 */
export function checkMagnitude(source: Source, next: Uint8Array, prev: Uint8Array | null): GuardVerdict {
  const key = source.invariants?.requiredKeyPath ?? 'data';
  const nextCount = countUnits(source.contentType, next, key);
  if (prev === null) return { hold: false, reason: null, prevCount: 0, nextCount };

  const prevCount = countUnits(source.contentType, prev, key);
  if (prevCount === 0) return { hold: false, reason: null, prevCount, nextCount };

  const shrinkPct = ((prevCount - nextCount) / prevCount) * 100;
  if (shrinkPct > source.magnitudeGuard.maxShrinkPct) {
    return {
      hold: true,
      reason: `would remove ${shrinkPct.toFixed(1)}% of units (${prevCount} -> ${nextCount}), above max_shrink_pct ${source.magnitudeGuard.maxShrinkPct}`,
      prevCount,
      nextCount,
    };
  }
  return { hold: false, reason: null, prevCount, nextCount };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/magnitude.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/magnitude.ts test/magnitude.test.ts
git commit -m "feat: the next bad snapshot will not be a Cloudflare page"
```

---

---

### Task 10: The status store

**Files:**
- Create: `src/status.ts`
- Test: `test/status.test.ts`

**Interfaces:**
- Consumes: `HealthState` from `src/health.ts`
- Produces:
  - `type SourceStatus`, `type StatusFile`, `type Outcome`
  - `applyOutcome(prev: SourceStatus | undefined, o: Outcome, nowIso: string): SourceStatus`
  - `meaningfulFields(s: SourceStatus): unknown`
  - `shouldCommitStatus(prev: StatusFile | null, next: StatusFile, isDailyRun: boolean): boolean`
  - `exitCodeFor(f: StatusFile, ids: string[], threshold: number): number`

**This task fixes the defect that made the alert eight days late.** Runners are ephemeral, so the counter lives only in the committed file. An earlier design committed on transitions only, so the counter could never advance past 1: fail at 00:15 and commit 1; fail at 00:30, read 1, compute 2, not a transition, nothing commits, and the 2 dies with the runner; 00:45 reads 1 again.

The fix is to commit whenever the **meaningful** fields differ, ignoring the pure heartbeat clock. During an outage the counter moves, so content differs, so it commits every run and advances. In steady health nothing meaningful moves and it commits once a day.

Ignoring the heartbeat is the load-bearing half. A `lastAttemptAt` that ticks every run makes every field comparison trivially true, which is commit-every-run wearing a comparison's clothes.

- [ ] **Step 1: Write the failing test**

```ts
// test/status.test.ts
import { describe, it, expect } from 'vitest';
import { applyOutcome, meaningfulFields, shouldCommitStatus, exitCodeFor, type StatusFile, type SourceStatus } from '../src/status.js';

const T = (n: number) => new Date(Date.parse('2026-08-26T00:00:00Z') + n * 900000).toISOString();
const okOutcome = { health: 'ok' as const, countsAsFailure: false, httpStatus: 200, bytes: 100, changed: false, originDate: null, held: null };
const failOutcome = { ...okOutcome, health: 'failed' as const, countsAsFailure: true, httpStatus: 503, bytes: null };
const file = (sources: Record<string, SourceStatus>): StatusFile => ({ version: 1, updatedAt: T(0), sources });

describe('applyOutcome', () => {
  it('resets the counter on success', () => {
    const s0 = applyOutcome(undefined, failOutcome, T(0));
    const s1 = applyOutcome(s0, failOutcome, T(1));
    const s2 = applyOutcome(s1, okOutcome, T(2));
    expect(s1.consecutiveFailures).toBe(2);
    expect(s2.consecutiveFailures).toBe(0);
  });

  it('a stale verdict does not advance the failure counter', () => {
    const s = applyOutcome(undefined, { ...okOutcome, health: 'stale', countsAsFailure: false }, T(0));
    expect(s.consecutiveFailures).toBe(0);
    expect(s.health).toBe('stale');
  });

  it('a hold does not advance the failure counter and is recorded', () => {
    const s = applyOutcome(undefined, { ...okOutcome, held: { at: T(0), reason: 'would remove 91.0 pct of units' } }, T(0));
    expect(s.consecutiveFailures).toBe(0);
    expect(s.held?.reason).toMatch(/91/);
  });

  it('becomes failing only at two consecutive failures, and recovers on the first success', () => {
    const s1 = applyOutcome(undefined, failOutcome, T(0));
    expect(s1.failing).toBe(false);
    const s2 = applyOutcome(s1, failOutcome, T(1));
    expect(s2.failing).toBe(true);
    const s3 = applyOutcome(s2, okOutcome, T(2));
    expect(s3.failing).toBe(false);
  });
});

describe('shouldCommitStatus', () => {
  it('commits unconditionally on the daily run', () => {
    const f = file({ a: applyOutcome(undefined, okOutcome, T(0)) });
    expect(shouldCommitStatus(f, f, true)).toBe(true);
  });

  it('does not commit when only the heartbeat moved', () => {
    const a = applyOutcome(undefined, okOutcome, T(0));
    const b = applyOutcome(a, okOutcome, T(1));
    expect(b.lastAttemptAt).not.toBe(a.lastAttemptAt);
    expect(shouldCommitStatus(file({ a }), file({ a: b }), false)).toBe(false);
  });

  it('commits when the failure counter moves, so an outage advances it every run', () => {
    const a = applyOutcome(undefined, failOutcome, T(0));
    const b = applyOutcome(a, failOutcome, T(1));
    expect(shouldCommitStatus(file({ a }), file({ a: b }), false)).toBe(true);
  });

  it('commits when byte count changes', () => {
    const a = applyOutcome(undefined, okOutcome, T(0));
    const b = applyOutcome(a, { ...okOutcome, bytes: 999 }, T(1));
    expect(shouldCommitStatus(file({ a }), file({ a: b }), false)).toBe(true);
  });

  it('commits when a source appears or disappears', () => {
    const a = applyOutcome(undefined, okOutcome, T(0));
    expect(shouldCommitStatus(file({}), file({ a }), false)).toBe(true);
    expect(shouldCommitStatus(file({ a }), file({}), false)).toBe(true);
  });

  it('commits when there is no committed copy at all', () => {
    expect(shouldCommitStatus(null, file({ a: applyOutcome(undefined, okOutcome, T(0)) }), false)).toBe(true);
  });
});

describe('meaningfulFields', () => {
  it('omits the heartbeat and keeps everything that drives a decision', () => {
    const s = applyOutcome(undefined, okOutcome, T(0));
    const m = JSON.stringify(meaningfulFields(s));
    expect(m).not.toContain('lastAttemptAt');
    for (const k of ['consecutiveFailures', 'health', 'failing', 'httpStatus', 'bytes', 'lastSuccessAt', 'lastChangeAt']) {
      expect(m).toContain(k);
    }
  });
});

describe('exitCodeFor', () => {
  it('is zero while under the threshold', () => {
    let s = applyOutcome(undefined, failOutcome, T(0));
    s = applyOutcome(s, failOutcome, T(1));
    expect(exitCodeFor(file({ a: s }), ['a'], 8)).toBe(0);
  });

  it('is non-zero at the threshold', () => {
    let s: SourceStatus | undefined;
    for (let i = 0; i < 8; i++) s = applyOutcome(s, failOutcome, T(i));
    expect(exitCodeFor(file({ a: s! }), ['a'], 8)).toBe(1);
  });

  it('ignores sources outside this tier', () => {
    let s: SourceStatus | undefined;
    for (let i = 0; i < 8; i++) s = applyOutcome(s, failOutcome, T(i));
    expect(exitCodeFor(file({ other: s! }), ['a'], 8)).toBe(0);
  });

  it('a stale source never trips the exit code, at any count', () => {
    let s: SourceStatus | undefined;
    for (let i = 0; i < 40; i++) s = applyOutcome(s, { ...okOutcome, health: 'stale', countsAsFailure: false }, T(i));
    expect(exitCodeFor(file({ a: s! }), ['a'], 8)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/status.test.ts`
Expected: FAIL, cannot resolve `../src/status.js`

- [ ] **Step 3: Write `src/status.ts`**

```ts
import type { HealthState } from './health.js';

export type Outcome = {
  health: HealthState;
  countsAsFailure: boolean;
  httpStatus: number | null;
  bytes: number | null;
  changed: boolean;
  originDate: string | null;
  held: { at: string; reason: string } | null;
};

export type SourceStatus = {
  /** Heartbeat only. Deliberately excluded from meaningfulFields. */
  lastAttemptAt: string;
  lastSuccessAt: string | null;
  lastChangeAt: string | null;
  consecutiveFailures: number;
  /** Hysteresis state, not a raw counter read. */
  failing: boolean;
  health: HealthState;
  httpStatus: number | null;
  bytes: number | null;
  originDate: string | null;
  held: { at: string; reason: string } | null;
};

export type StatusFile = { version: 1; updatedAt: string; sources: Record<string, SourceStatus> };

/** A source is FAILING at two consecutive failures, and OK on the first success. */
const FAILING_AT = 2;

export function applyOutcome(prev: SourceStatus | undefined, o: Outcome, nowIso: string): SourceStatus {
  const consecutiveFailures = o.countsAsFailure ? (prev?.consecutiveFailures ?? 0) + 1 : 0;
  return {
    lastAttemptAt: nowIso,
    lastSuccessAt: o.health === 'ok' || o.health === 'relocated' ? nowIso : (prev?.lastSuccessAt ?? null),
    lastChangeAt: o.changed ? nowIso : (prev?.lastChangeAt ?? null),
    consecutiveFailures,
    failing: consecutiveFailures >= FAILING_AT,
    health: o.health,
    httpStatus: o.httpStatus,
    bytes: o.bytes ?? (prev?.bytes ?? null),
    originDate: o.originDate ?? (prev?.originDate ?? null),
    held: o.held ?? null,
  };
}

/**
 * Everything a decision reads, and nothing that ticks on its own.
 *
 * lastAttemptAt is excluded because it moves every run by construction. Leave
 * it in and every comparison is trivially true.
 */
export function meaningfulFields(s: SourceStatus): unknown {
  const { lastAttemptAt: _ignored, ...rest } = s;
  return rest;
}

export function shouldCommitStatus(prev: StatusFile | null, next: StatusFile, isDailyRun: boolean): boolean {
  if (isDailyRun) return true;
  if (prev === null) return true;

  const a = Object.keys(prev.sources).sort();
  const b = Object.keys(next.sources).sort();
  if (a.join(' ') !== b.join(' ')) return true;

  for (const id of b) {
    if (JSON.stringify(meaningfulFields(prev.sources[id]!)) !== JSON.stringify(meaningfulFields(next.sources[id]!))) {
      return true;
    }
  }
  return false;
}

/**
 * Each job evaluates its OWN tier. Putting the check only in the daily job
 * meant a totally dead fast tier produced no email for up to 24 hours.
 */
export function exitCodeFor(f: StatusFile, ids: string[], threshold: number): number {
  for (const id of ids) {
    const s = f.sources[id];
    if (s && s.consecutiveFailures >= threshold) return 1;
  }
  return 0;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/status.test.ts`
Expected: PASS, 14 tests

- [ ] **Step 5: Commit**

```bash
git add src/status.ts test/status.test.ts
git commit -m "feat: a counter that lives in a file only advances if the file is written"
```

---

---

### Task 11: The run, completed and order-locked

**Files:**
- Modify: `src/run.ts` (created minimal in Task 5, extended by Tasks 6 to 10; this task assembles the final shape)
- Modify: `test/run.test.ts` (Task 5's minimal tests stay; this task adds the ordering and gating tests)

**Interfaces:**
- Consumes: everything from Tasks 2 through 10
- Produces:
  - `type RunDeps = { cwd: string; nowIso: () => string; fetchOne: (s: Source) => Promise<FetchOutcome>; readFile: (p: string) => Uint8Array | null; writeFile: (p: string, b: Uint8Array) => void; commitPaths: (paths: string[], message: string) => boolean; push: () => void; log: (line: string) => void }`
  - `type RunResult = { exitCode: number; status: StatusFile; trace: string[] }`
  - `runTier(sources: Source[], tier: 'fast' | 'daily', prevStatus: StatusFile | null, deps: RunDeps): Promise<RunResult>`

Task 5 shipped a minimal `runTier`, and Tasks 6 through 10 inserted the health check, the predicate dispatch, the magnitude guard and the status store into it. This task assembles the final ordering and locks it with tests that assert it.

**The order is the deliverable.** fetch, health check, change predicate, magnitude guard, write, commit, push, evaluate counters, exit code. Two orderings in particular are wrong in ways that look fine:

- Writing before the health check lets an error page clobber a good artifact.
- Evaluating counters before committing status means the unconditional daily commit does not happen precisely when sources are failing, which re-arms the 60-day inactivity disable that the whole liveness design exists to prevent.

`trace` exists so the tests can assert the order rather than trusting it.

- [ ] **Step 1: Write the failing test**

```ts
// test/run.test.ts
import { describe, it, expect } from 'vitest';
import { runTier, type RunDeps } from '../src/run.js';
import type { Source } from '../src/config.js';
import type { StatusFile } from '../src/status.js';

const enc = (s: string) => new TextEncoder().encode(s);

const source = (over: Partial<Source> = {}): Source => ({
  id: 'a', url: 'https://a.example/f', tier: 'daily', path: 'raw/a/response.txt',
  contentType: 'text', expectedRoot: null,
  invariants: { minBytes: 1, requiredKeyPath: null, minRecords: null, canary: 'CANARY', sizeBand: [0.1, 10] },
  freshness: { kind: 'none', maxQuietDays: null },
  predicate: { type: 'bytes' }, timeoutS: 5, retries: 0, maxRedirects: 3,
  rateLimit: { maxAutoEventsPerDay: 8 }, magnitudeGuard: { maxShrinkPct: 25 }, notes: '',
  ...over,
} as Source);

function deps(over: Partial<RunDeps> = {}, files: Record<string, Uint8Array> = {}): RunDeps & { files: Record<string, Uint8Array>; trace: string[] } {
  const trace: string[] = [];
  const d = {
    cwd: '/tmp/fake',
    nowIso: () => '2026-08-26T14:00:00.000Z',
    fetchOne: async () => { trace.push('fetch'); return { ok: true as const, attempts: 1,
      observed: { status: 200, body: enc('CANARY\nline2\nline3'), finalUrl: 'https://a.example/f', redirectCount: 0, headers: {} },
      headers: { fetchedAt: '2026-08-26T14:00:00.000Z', finalUrl: 'https://a.example/f', userAgent: 'ua', status: 200,
                 etag: null, lastModified: null, date: null, age: null, cacheControl: null, cfCacheStatus: null,
                 contentEncoding: null, contentLength: null } }; },
    readFile: (p: string) => files[p] ?? null,
    writeFile: (p: string, b: Uint8Array) => { trace.push(`write:${p}`); files[p] = b; },
    commitPaths: (paths: string[]) => { trace.push(`commit:${paths.join(',')}`); return true; },
    push: () => { trace.push('push'); },
    log: () => {},
    ...over,
  };
  return Object.assign(d, { files, trace });
}

describe('runTier ordering', () => {
  it('fetches, writes, commits, pushes, in that order', async () => {
    const d = deps();
    await runTier([source()], 'daily', null, d);
    const order = d.trace.filter((t) => /^(fetch|write|commit|push)/.test(t)).map((t) => t.split(':')[0]);
    expect(order.indexOf('fetch')).toBeLessThan(order.indexOf('write'));
    expect(order.indexOf('write')).toBeLessThan(order.indexOf('commit'));
    expect(order.lastIndexOf('commit')).toBeLessThan(order.indexOf('push'));
  });

  it('commits the body and its headers sidecar together, in one commit', async () => {
    const d = deps();
    await runTier([source()], 'daily', null, d);
    const bodyCommit = d.trace.find((t) => t.startsWith('commit:') && t.includes('raw/a/response.txt'));
    expect(bodyCommit).toBeDefined();
    expect(bodyCommit).toContain('raw/a/headers.json');
  });
});

describe('runTier gating', () => {
  it('does not write when the health check fails, and leaves the stored bytes alone', async () => {
    const files = { 'raw/a/response.txt': enc('CANARY\ngood\nold\nbytes') };
    const d = deps({ fetchOne: async () => ({ ok: true as const, attempts: 1,
      observed: { status: 200, body: enc('Just a moment please'), finalUrl: 'https://a.example/f', redirectCount: 0, headers: {} },
      headers: { fetchedAt: 'x', finalUrl: 'https://a.example/f', userAgent: 'ua', status: 200, etag: null, lastModified: null,
                 date: null, age: null, cacheControl: null, cfCacheStatus: null, contentEncoding: null, contentLength: null } }) }, files);
    const r = await runTier([source()], 'daily', null, d);
    expect(d.trace.some((t) => t.startsWith('write:raw/a/response.txt'))).toBe(false);
    expect(files['raw/a/response.txt']).toEqual(enc('CANARY\ngood\nold\nbytes'));
    expect(r.status.sources.a!.consecutiveFailures).toBe(1);
  });

  it('does not write when nothing changed', async () => {
    const files = { 'raw/a/response.txt': enc('CANARY\nline2\nline3') };
    const d = deps({}, files);
    await runTier([source()], 'daily', null, d);
    expect(d.trace.some((t) => t.startsWith('write:raw/a/response.txt'))).toBe(false);
  });

  it('holds a collapse for review instead of committing it, and still exits zero', async () => {
    const big = enc(['CANARY', ...Array.from({ length: 200 }, (_, i) => `l${i}`)].join('\n'));
    const files = { 'raw/a/response.txt': big };
    const d = deps({ fetchOne: async () => ({ ok: true as const, attempts: 1,
      observed: { status: 200, body: enc('CANARY\nonly\nfour\nlines'), finalUrl: 'https://a.example/f', redirectCount: 0, headers: {} },
      headers: { fetchedAt: 'x', finalUrl: 'https://a.example/f', userAgent: 'ua', status: 200, etag: null, lastModified: null,
                 date: null, age: null, cacheControl: null, cfCacheStatus: null, contentEncoding: null, contentLength: null } }) }, files);
    const r = await runTier([source()], 'daily', null, d);
    expect(d.trace.some((t) => t.startsWith('write:raw/a/response.txt'))).toBe(false);
    expect(r.status.sources.a!.held?.reason).toMatch(/remove/);
    expect(r.status.sources.a!.consecutiveFailures).toBe(0);
    expect(r.exitCode).toBe(0);
  });
});

describe('runTier resilience', () => {
  it('commits status before evaluating the exit code, so a failing run still writes its heartbeat', async () => {
    const d = deps({ fetchOne: async () => ({ ok: false as const, error: 'ECONNRESET', attempts: 3 }) });
    const prev: StatusFile = { version: 1, updatedAt: 'x', sources: {
      a: { lastAttemptAt: 'x', lastSuccessAt: null, lastChangeAt: null, consecutiveFailures: 7, failing: true,
           health: 'failed', httpStatus: null, bytes: null, originDate: null, held: null } } };
    const r = await runTier([source()], 'daily', prev, d);
    expect(d.trace.some((t) => t.includes('meta/status.json'))).toBe(true);
    expect(r.exitCode).toBe(1);
  });

  it('one failing source does not stop the others from being collected', async () => {
    let n = 0;
    const d = deps({ fetchOne: async () => {
      n++;
      if (n === 1) throw new Error('boom');
      return { ok: true as const, attempts: 1,
        observed: { status: 200, body: enc('CANARY\nb'), finalUrl: 'https://b.example/f', redirectCount: 0, headers: {} },
        headers: { fetchedAt: 'x', finalUrl: 'https://b.example/f', userAgent: 'ua', status: 200, etag: null, lastModified: null,
                   date: null, age: null, cacheControl: null, cfCacheStatus: null, contentEncoding: null, contentLength: null } };
    } });
    const r = await runTier([source({ id: 'a' }), source({ id: 'b', url: 'https://b.example/f', path: 'raw/b/response.txt' })], 'daily', null, d);
    expect(r.status.sources.a!.consecutiveFailures).toBe(1);
    expect(r.status.sources.b!.health).toBe('ok');
  });

  it('skips an older cache generation without counting it as a failure', async () => {
    const files = { 'raw/a/response.txt': enc('CANARY\nstored') };
    const prev: StatusFile = { version: 1, updatedAt: 'x', sources: {
      a: { lastAttemptAt: 'x', lastSuccessAt: 'x', lastChangeAt: 'x', consecutiveFailures: 0, failing: false,
           health: 'ok', httpStatus: 200, bytes: 13, originDate: '2026-08-26T13:30:00.000Z', held: null } } };
    const d = deps({ fetchOne: async () => ({ ok: true as const, attempts: 1,
      observed: { status: 200, body: enc('CANARY\nolder generation'), finalUrl: 'https://a.example/f', redirectCount: 0, headers: {} },
      headers: { fetchedAt: 'x', finalUrl: 'https://a.example/f', userAgent: 'ua', status: 200, etag: null, lastModified: null,
                 date: 'Tue, 26 Aug 2026 14:00:00 GMT', age: '3600', cacheControl: null, cfCacheStatus: 'HIT',
                 contentEncoding: null, contentLength: null } }) }, files);
    const r = await runTier([source()], 'daily', prev, d);
    expect(d.trace.some((t) => t.startsWith('write:raw/a/response.txt'))).toBe(false);
    expect(r.status.sources.a!.consecutiveFailures).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/run.test.ts`
Expected: FAIL, cannot resolve `../src/run.js`

- [ ] **Step 3: Assemble the final `src/run.ts`**

This is the complete pipeline. It replaces the minimal version from Task 5 and the incremental edits from Tasks 6 to 10, and it is the authoritative listing.

```ts
import type { Source } from './config.js';
import { checkHealth } from './health.js';
import { hasChanged } from './predicates.js';
import { checkMagnitude } from './magnitude.js';
import { isStaleGeneration, originDateMs } from './headers.js';
import { applyOutcome, shouldCommitStatus, exitCodeFor, type StatusFile, type SourceStatus, type Outcome } from './status.js';
import type { FetchOutcome } from './fetch.js';

export type RunDeps = {
  cwd: string;
  nowIso: () => string;
  fetchOne: (s: Source) => Promise<FetchOutcome>;
  readFile: (p: string) => Uint8Array | null;
  writeFile: (p: string, b: Uint8Array) => void;
  commitPaths: (paths: string[], message: string) => boolean;
  push: () => void;
  log: (line: string) => void;
};

export type RunResult = { exitCode: number; status: StatusFile; trace: string[] };

const THRESHOLD = { fast: 8, daily: 3 } as const;

const headersPathFor = (s: Source) => `raw/${s.id}/headers.json`;

export async function runTier(
  sources: Source[],
  tier: 'fast' | 'daily',
  prevStatus: StatusFile | null,
  deps: RunDeps,
): Promise<RunResult> {
  const now = deps.nowIso();
  const nextSources: Record<string, SourceStatus> = { ...(prevStatus?.sources ?? {}) };
  const trace: string[] = [];

  for (const s of sources) {
    const prev = prevStatus?.sources[s.id];
    const stored = deps.readFile(s.path);
    let outcome: Outcome;

    try {
      // 1. fetch
      const got = await deps.fetchOne(s);
      if (!got.ok) {
        outcome = { health: 'failed', countsAsFailure: true, httpStatus: null, bytes: null, changed: false, originDate: null, held: null };
        deps.log(`${s.id}: fetch failed after ${got.attempts} attempts: ${got.error}`);
      } else {
        // 2. health check. Nothing is written unless this allows it.
        const verdict = checkHealth(s, got.observed, { bytes: stored?.byteLength ?? null }, Date.parse(now));
        if (verdict.reason !== null) deps.log(`${s.id}: ${verdict.state}: ${verdict.reason}`);

        if (!verdict.writeAllowed) {
          outcome = { health: verdict.state, countsAsFailure: verdict.countsAsFailure, httpStatus: got.observed.status,
                      bytes: null, changed: false, originDate: prev?.originDate ?? null, held: null };
        } else {
          const originMs = originDateMs(got.headers);
          const originIso = originMs === null ? null : new Date(originMs).toISOString();

          // 2b. an older cache generation is a skip, never a failure and never a write.
          if (isStaleGeneration(got.headers, prev?.originDate ?? null)) {
            deps.log(`${s.id}: skipped, older cache generation (${originIso})`);
            outcome = { health: verdict.state, countsAsFailure: false, httpStatus: got.observed.status,
                        bytes: stored?.byteLength ?? null, changed: false, originDate: prev?.originDate ?? null, held: null };
          } else if (!hasChanged(s, got.observed.body, stored)) {
            // 3. change predicate
            outcome = { health: verdict.state, countsAsFailure: false, httpStatus: got.observed.status,
                        bytes: got.observed.body.byteLength, changed: false, originDate: originIso, held: null };
          } else {
            // 4. magnitude guard
            const guard = checkMagnitude(s, got.observed.body, stored);
            if (guard.hold) {
              deps.log(`${s.id}: HELD for review: ${guard.reason}`);
              outcome = { health: verdict.state, countsAsFailure: false, httpStatus: got.observed.status,
                          bytes: stored?.byteLength ?? null, changed: false, originDate: prev?.originDate ?? null,
                          held: { at: now, reason: guard.reason! } };
            } else {
              // 5. write, verbatim, plus its sidecar. 6. commit, together.
              deps.writeFile(s.path, got.observed.body);
              deps.writeFile(headersPathFor(s), new TextEncoder().encode(JSON.stringify(got.headers, null, 2) + '\n'));
              deps.commitPaths([s.path, headersPathFor(s)], `${s.id}: changed (${got.observed.body.byteLength} bytes, HTTP ${got.observed.status})`);
              trace.push(`changed:${s.id}`);
              outcome = { health: verdict.state, countsAsFailure: false, httpStatus: got.observed.status,
                          bytes: got.observed.body.byteLength, changed: true, originDate: originIso, held: null };
            }
          }
        }
      }
    } catch (e) {
      // One source's failure must never abort the others.
      deps.log(`${s.id}: threw: ${String(e instanceof Error ? e.message : e)}`);
      outcome = { health: 'failed', countsAsFailure: true, httpStatus: null, bytes: null, changed: false, originDate: null, held: null };
    }

    nextSources[s.id] = applyOutcome(prev, outcome, now);
  }

  const nextStatus: StatusFile = { version: 1, updatedAt: now, sources: nextSources };

  // 7. Commit status BEFORE evaluating the exit code. Reversing these means the
  // unconditional daily commit does not happen precisely when sources are
  // failing, which re-arms the 60-day inactivity disable.
  if (shouldCommitStatus(prevStatus, nextStatus, tier === 'daily')) {
    deps.writeFile('meta/status.json', new TextEncoder().encode(JSON.stringify(nextStatus, null, 2) + '\n'));
    deps.commitPaths(['meta/status.json'], tier === 'daily' ? `status: daily heartbeat ${now.slice(0, 10)}` : 'status: source state changed');
  }

  // 8. push
  deps.push();

  // 9. exit code, over this tier's sources only
  const exitCode = exitCodeFor(nextStatus, sources.map((s) => s.id), THRESHOLD[tier]);
  return { exitCode, status: nextStatus, trace };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/run.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Run the whole suite**

Run: `npm test && npm run typecheck`
Expected: PASS, everything

- [ ] **Step 6: Commit**

```bash
git add src/run.ts test/run.test.ts
git commit -m "feat: the order is the design, so the test asserts the order"
```

---

---

### Task 12: Politeness, the fast tier, and the dead-man's switch

**Files:**
- Create: `src/pool.ts`
- Modify: `src/cli.ts` (add the pool, the status file, and the heartbeat ping)
- Create: `.github/workflows/collect-fast.yml`
- Modify: `.github/workflows/collect-daily.yml` (add the heartbeat secret)
- Test: `test/pool.test.ts`

**Interfaces:**
- Consumes: `runTier` from `src/run.ts`, `fetchSource` from `src/fetch.ts`, `loadSources` from `src/config.ts`
- Produces:
  - `mapPolitely<T, R>(items: T[], fn: (t: T) => Promise<R>, o: { concurrency: number; hostOf: (t: T) => string; minHostGapMs: number; sleep?: (ms: number) => Promise<void>; nowMs?: () => number }): Promise<R[]>`
  - `src/cli.ts` runs `collect --tier fast|daily` and exits with `RunResult.exitCode`

Concurrency is 4, at most one in-flight request per hostname, and a minimum 1s gap between consecutive requests to the same host. The daily tier has three `openrouter.ai` URLs and two `platform.claude.com` URLs, and 15 sources at 60s timeouts is the difference between about 15 minutes serial and about 1 minute parallel, which decides whether the 00:20 run is still in flight at 00:30.

- [ ] **Step 1: Write the failing test**

```ts
// test/pool.test.ts
import { describe, it, expect } from 'vitest';
import { mapPolitely } from '../src/pool.js';

type Job = { host: string; id: number };
const jobs = (spec: [string, number][]): Job[] => spec.map(([host, id]) => ({ host, id }));

describe('mapPolitely', () => {
  it('preserves input order in the results', async () => {
    const out = await mapPolitely(jobs([['a', 1], ['b', 2], ['c', 3]]), async (j) => j.id,
      { concurrency: 4, hostOf: (j) => j.host, minHostGapMs: 0, sleep: async () => {} });
    expect(out).toEqual([1, 2, 3]);
  });

  it('never exceeds the concurrency cap', async () => {
    let inFlight = 0, peak = 0;
    await mapPolitely(jobs(Array.from({ length: 20 }, (_, i) => [`h${i}`, i] as [string, number])), async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--; return 0;
    }, { concurrency: 4, hostOf: (j) => j.host, minHostGapMs: 0, sleep: async () => {} });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('never runs two requests to the same host at once', async () => {
    const live = new Set<string>();
    let violations = 0;
    await mapPolitely(jobs([['a', 1], ['a', 2], ['a', 3], ['b', 4]]), async (j) => {
      if (live.has(j.host)) violations++;
      live.add(j.host);
      await new Promise((r) => setTimeout(r, 5));
      live.delete(j.host);
      return j.id;
    }, { concurrency: 4, hostOf: (j) => j.host, minHostGapMs: 0, sleep: async () => {} });
    expect(violations).toBe(0);
  });

  it('waits the declared gap between consecutive requests to one host', async () => {
    const waits: number[] = [];
    await mapPolitely(jobs([['a', 1], ['a', 2]]), async () => 0,
      { concurrency: 4, hostOf: (j) => j.host, minHostGapMs: 1000, sleep: async (ms) => { waits.push(ms); }, nowMs: () => 0 });
    expect(waits.some((w) => w > 0)).toBe(true);
  });

  it('a rejected job does not sink the batch', async () => {
    const out = await mapPolitely(jobs([['a', 1], ['b', 2]]), async (j) => {
      if (j.id === 1) throw new Error('boom');
      return j.id;
    }, { concurrency: 2, hostOf: (j) => j.host, minHostGapMs: 0, sleep: async () => {} });
    expect(out[0]).toBeInstanceOf(Error);
    expect(out[1]).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pool.test.ts`
Expected: FAIL, cannot resolve `../src/pool.js`

- [ ] **Step 3: Write `src/pool.ts`**

```ts
export type PolitenessOpts<T> = {
  concurrency: number;
  hostOf: (t: T) => string;
  minHostGapMs: number;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
};

/**
 * Bounded-concurrency map with a per-host serialisation and gap.
 *
 * Results keep input order. A rejected job resolves to its Error rather than
 * rejecting the batch, because one unreachable source must never stop the
 * other fifteen from being collected.
 */
export async function mapPolitely<T, R>(items: T[], fn: (t: T) => Promise<R>, o: PolitenessOpts<T>): Promise<(R | Error)[]> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nowMs = o.nowMs ?? (() => Date.now());

  const results = new Array<R | Error>(items.length);
  const hostBusy = new Set<string>();
  const hostLastAt = new Map<string, number>();
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      // Take the first item whose host is free, so a busy host does not stall
      // a worker that could be fetching somewhere else.
      let idx = -1;
      for (let i = next; i < items.length; i++) {
        if (results[i] !== undefined) continue;
        const h = o.hostOf(items[i]!);
        if (!hostBusy.has(h)) { idx = i; break; }
      }
      if (idx === -1) {
        if (next >= items.length && hostBusy.size === 0) return;
        await sleep(5);
        continue;
      }
      while (next < items.length && results[next] !== undefined) next++;

      const item = items[idx]!;
      const host = o.hostOf(item);
      hostBusy.add(host);
      results[idx] = null as unknown as R; // claim the slot

      const last = hostLastAt.get(host);
      if (last !== undefined) {
        const wait = o.minHostGapMs - (nowMs() - last);
        if (wait > 0) await sleep(wait);
      }

      try {
        results[idx] = await fn(item);
      } catch (e) {
        results[idx] = e instanceof Error ? e : new Error(String(e));
      } finally {
        hostLastAt.set(host, nowMs());
        hostBusy.delete(host);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, () => worker()));
  return results;
}
```

- [ ] **Step 4: Extend `src/cli.ts`**

Replace Task 5's serial fetch loop with the pool, read and pass `meta/status.json`, and add the heartbeat ping.

```ts
import fs from 'node:fs';
import path from 'node:path';
import { loadSources, sourcesForTier } from './config.js';
import { fetchSource } from './fetch.js';
import { runTier } from './run.js';
import { commitPaths, pushWithRebase } from './git.js';
import { mapPolitely } from './pool.js';
import type { StatusFile } from './status.js';

const cwd = process.cwd();
const tierArg = process.argv.includes('--tier') ? process.argv[process.argv.indexOf('--tier') + 1] : undefined;
if (tierArg !== 'fast' && tierArg !== 'daily') {
  console.error('usage: collect --tier fast|daily');
  process.exit(2);
}
const tier = tierArg;

const readFile = (p: string): Uint8Array | null => {
  const abs = path.join(cwd, p);
  return fs.existsSync(abs) ? new Uint8Array(fs.readFileSync(abs)) : null;
};
const writeFile = (p: string, b: Uint8Array): void => {
  const abs = path.join(cwd, p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, b);
};

const file = loadSources(JSON.parse(fs.readFileSync(path.join(cwd, 'meta/sources.json'), 'utf8')));
const sources = sourcesForTier(file, tier);

const raw = readFile('meta/status.json');
const prevStatus: StatusFile | null = raw ? (JSON.parse(new TextDecoder().decode(raw)) as StatusFile) : null;

// Fetch every source first, politely and in parallel, then hand the results to
// the pipeline so the ordering guarantees in run.ts stay purely sequential.
const fetched = await mapPolitely(sources, (s) => fetchSource(s, { userAgent: file.userAgent, nowIso: () => new Date().toISOString() }), {
  concurrency: 4,
  hostOf: (s) => new URL(s.url).host,
  minHostGapMs: 1000,
});
const byId = new Map(sources.map((s, i) => [s.id, fetched[i]!]));

const result = await runTier(sources, tier, prevStatus, {
  cwd,
  nowIso: () => new Date().toISOString(),
  fetchOne: async (s) => {
    const r = byId.get(s.id);
    if (r === undefined || r instanceof Error) {
      return { ok: false as const, error: r instanceof Error ? r.message : 'not fetched', attempts: 0 };
    }
    return r;
  },
  readFile,
  writeFile,
  commitPaths: (paths, message) => commitPaths(cwd, paths, message),
  push: () => { if (process.env.LCA_NO_PUSH !== '1') pushWithRebase(cwd, process.env.LCA_BRANCH ?? 'main'); },
  log: (l) => console.log(l),
});

// The dead-man's switch. Pinged only on a run that got this far, so the ABSENCE
// of a ping is the alarm. The in-repo exit code covers source failure; this
// covers collector death, and neither covers the other.
const ping = process.env.LCA_HEARTBEAT_URL;
if (ping) {
  try { await fetch(ping, { method: 'POST' }); } catch (e) { console.log(`heartbeat ping failed: ${String(e)}`); }
}

process.exit(result.exitCode);
```

- [ ] **Step 5: Write the workflows**

`.github/workflows/collect-fast.yml`:
```yaml
name: collect-fast
on:
  schedule: [{ cron: '*/15 * * * *' }]
  workflow_dispatch:
concurrency: { group: collector-archive, cancel-in-progress: false }
permissions: { contents: write }
jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      - run: npm ci
      - name: Identify the committer
        run: |
          git config user.name 'llm-catalog-archive[bot]'
          git config user.email 'llm-catalog-archive@users.noreply.github.com'
      - run: npx tsx src/cli.ts --tier fast
        env:
          LCA_BRANCH: main
          LCA_HEARTBEAT_URL: ${{ secrets.LCA_HEARTBEAT_URL }}
```

`.github/workflows/collect-daily.yml` already exists from Task 5; add `LCA_HEARTBEAT_URL` to its `env` block. **The `concurrency.group` string must be identical in both files**; that is the only thing that serialises them against each other, and the 00:20 daily run overlaps the 00:15 and 00:30 fast runs by construction.

- [ ] **Step 6: Run tests and a dry run**

Run: `npx vitest run test/pool.test.ts && npm test && npm run typecheck`
Expected: PASS

Then a real dry run that fetches but never pushes:
```bash
LCA_NO_PUSH=1 npx tsx src/cli.ts --tier daily
git status --porcelain
git log --oneline -5
```
Expected: `raw/<id>/response.*` and `raw/<id>/headers.json` files created, one commit per source, `meta/status.json` committed once, exit code 0. Read the log lines for any `relocated` or `HELD` reports and resolve each before proceeding.

- [ ] **Step 7: Commit**

```bash
git add src/pool.ts src/cli.ts test/pool.test.ts .github/workflows/collect-fast.yml .github/workflows/collect-daily.yml
git commit -m "feat: fetch politely, and let the absence of a ping be the alarm"
```

---

---

### Task 13: CI invariants and the mutation pass

**Files:**
- Create: `stryker.config.json`, `.github/workflows/ci.yml`
- Test: `test/invariants.test.ts`

**Interfaces:**
- Consumes: everything
- Produces: no runtime interface; this task produces confidence

- [ ] **Step 1: Write the invariant tests**

```ts
// test/invariants.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadSources } from '../src/config.js';
import { hasChanged } from '../src/predicates.js';

const file = loadSources(JSON.parse(fs.readFileSync('meta/sources.json', 'utf8')));

describe('config and spec agree', () => {
  it('every source in the spec table has exactly one entry, and vice versa', () => {
    const spec = fs.readFileSync('docs/superpowers/specs/2026-08-26-collector-and-archive-design.md', 'utf8');
    for (const s of file.sources) expect(spec).toContain(s.url);
    expect(new Set(file.sources.map((s) => s.id)).size).toBe(file.sources.length);
  });

  it('every non-default predicate carries its justification', () => {
    for (const s of file.sources) {
      if (s.predicate.type !== 'bytes') expect(s.notes.length, `${s.id} notes`).toBeGreaterThan(40);
    }
  });

  it('every text source has a canary', () => {
    for (const s of file.sources) if (s.contentType === 'text') expect(s.invariants.canary, s.id).toBeTruthy();
  });
});

describe('pure modules stay pure', () => {
  // This is the property that makes every decision testable without a network.
  it('no pure module imports fetch, git, or node:fs', () => {
    const pure = ['config', 'health', 'predicates', 'magnitude', 'status', 'headers', 'pool',
                  'extractors/arena', 'extractors/xai', 'extractors/sitemapLoc'];
    for (const m of pure) {
      const src = fs.readFileSync(path.join('src', `${m}.ts`), 'utf8');
      expect(src, m).not.toMatch(/from '\.\/(fetch|git)\.js'/);
      expect(src, m).not.toMatch(/from 'node:(fs|child_process)'/);
    }
  });
});

describe('arena stays quiet across back-to-back fetches', () => {
  // If arena injects another per-request token, this fails loudly instead of
  // silently reverting the source to a 5MB commit every run.
  it('two captured fetches compare equal under the arena predicate', () => {
    const a = new Uint8Array(fs.readFileSync('test/fixtures/arena-a.html'));
    const b = new Uint8Array(fs.readFileSync('test/fixtures/arena-b.html'));
    const s = file.sources.find((x) => x.id === 'arena-leaderboard')!;
    expect(hasChanged(s, b, a)).toBe(false);
  });
});
```

- [ ] **Step 2: Add the CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - name: A body commit must carry its headers sidecar
        run: |
          set -euo pipefail
          for sha in $(git log --format=%H -50); do
            files=$(git show --name-only --format= "$sha")
            for f in $files; do
              case "$f" in
                raw/*/response.*)
                  d=$(dirname "$f")
                  echo "$files" | grep -qx "$d/headers.json" || { echo "::error::$sha changed $f without $d/headers.json"; exit 1; }
                  ;;
              esac
            done
          done
      - name: No em dashes anywhere
        run: |
          # The character is written as an escape on purpose: a literal one here
          # would be found by the very check it configures.
          if grep -rIlP '\x{2014}' --exclude-dir=node_modules --exclude-dir=.git \
               --exclude-dir=raw --exclude-dir=backfill --exclude-dir=test . ; then
            echo "::error::em dash found"; exit 1
          fi
```

- [ ] **Step 3: Run the invariants**

Run: `npx vitest run test/invariants.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 4: Configure and run mutation testing**

`stryker.config.json`:
```json
{
  "$schema": "https://raw.githubusercontent.com/stryker-mutator/stryker-js/master/packages/api/schema/stryker-schema.json",
  "packageManager": "npm",
  "testRunner": "vitest",
  "reporters": ["html", "clear-text", "progress"],
  "mutate": ["src/health.ts", "src/predicates.ts", "src/magnitude.ts", "src/status.ts", "src/headers.ts", "src/extractors/*.ts"],
  "thresholds": { "high": 90, "low": 80, "break": 75 },
  "timeoutMS": 60000
}
```

Run: `npm run mutate`

- [ ] **Step 5: Kill the survivors, by hand, one at a time**

A test that has never been watched failing is not evidence. For every surviving mutant, either write the test that kills it or record in `test/README.md` why the mutation is genuinely equivalent.

Pay closest attention to the assertions that claim an **absence**, because those are the ones that pass vacuously:

- `checkHealth` rejects the interstitial. Break it on purpose: delete the `INTERSTITIAL` loop, confirm the test goes red, restore it. Then confirm the fixture genuinely contains a marker (`grep -c '__CF\$cv\$params\|Just a moment' test/fixtures/trap-neuron-403.html`). If the fixture has no marker, the test proves nothing whether or not the code works.
- The magnitude guard holds a collapse. Set `maxShrinkPct` to 100 and confirm the hold tests go red.
- `shouldCommitStatus` ignores the heartbeat. Delete the destructuring in `meaningfulFields` and confirm the "does not commit when only the heartbeat moved" test goes red. This is the exact defect that made the alert eight days late, so its test must be watched failing.
- The arena extractor's escaped regex. Change `\\"publicName\\"` to `"publicName"` and confirm the record-count test goes red rather than returning an empty list that some other assertion tolerates.
- `runTier` does not write on an unhealthy response. Move the `writeFile` call above the health check and confirm the gating test goes red.

- [ ] **Step 6: Commit**

```bash
git add stryker.config.json .github/workflows/ci.yml test/invariants.test.ts test/README.md
git commit -m "test: watch every assertion fail before believing it"
```

---

---

## Self-Review

**Spec coverage.** Every numbered section of the spec maps to a task:

| Spec section | Tasks |
|---|---|
| 2, rules R1 to R7 | 1 (gitattributes, ledgers), 5 (verbatim write, explicit staging, no force push), 7 (the predicate never mutates), 13 (round-trip and purity tests) |
| 3 and 3.1, layout and `sources.json` | 1, 2 |
| 4, source inventory and health | 2, 6 |
| 5, schedule and the shared concurrency group | 5 (daily), 12 (fast, pool) |
| 6, the run order | 5 (minimal), 11 (locked) |
| 6.1, the magnitude guard | 9 |
| 7, change predicates and the codename filter | 7, 8 |
| 8, liveness, status, alerting | 10 (store, counters, exit codes), 12 (dead-man's switch) |
| 9, headers and origin timestamps | 3, 5 (sidecar), 10 (skew rule) |
| 11, permalinks and the append-only ledgers | 1, 13 |
| 13, testing | every task, and 13 |

**Deliberately not covered here**, and each already tracked as a spec open question rather than silently dropped:

| Spec item | Where it goes |
|---|---|
| Section 10, backfill (models.dev bundle, kj-9 replay) | Plan 2, gated on O2 |
| Section 11, auto-tier rate limit and the shared-lastmod rule | Sub-project D. A1 stores `rateLimit.maxAutoEventsPerDay` in config so D has somewhere to read it, but A1 publishes nothing and so cannot rate-limit publishing. |
| Section 11, correction and retraction record schemas | Sub-project D. Task 1 creates the empty append-only files and the CI check, which is the part that must exist from commit one. |
| O1 re-hash, O3 models.dev window, O4 arena cadence, O5 Gemini, O7 size budget, O8 GITHUB_TOKEN activity | Operational follow-ups, not code. O4 in particular needs arena polled hourly for two weeks, which is a `cron` change plus a measurement, not a task. |

**Two gaps I am flagging rather than papering over.**

Task 12 fetches every source before `runTier` consumes the results, so the
per-source pipeline inside `runTier` stays sequential and its ordering
guarantees hold, but the fetch phase as a whole then precedes the first health
check. Correctness is unaffected, since nothing is written until `runTier` runs.
It is worth knowing when reading the code: "fetch, then health check" is true
per source, and the fetches are batched.

Between Task 5 and Task 10 there is no `meta/status.json`, therefore no daily
heartbeat, therefore no defence against GitHub's 60 day inactivity disable.
Thirteen active sources produce commits on most days so the clock will not run
out, but it is a real temporary hole and Task 5 states the deadline explicitly:
**Task 10 must land within 60 days of Task 5.** The sequencing puts it within
days.

**Placeholder scan.** No TBD, no "add error handling", no "similar to Task N", no "write tests for the above". Every code step carries real code. Two values are deliberately left for the implementer to fill from live data, both with the command that produces them and a test that fails until they are right: the eight canary strings in Task 3 Step 5, and the `OWNER/REPO` in the User-Agent.

**Type consistency.** `Source` gains a `status` field in Task 2 that Tasks 5 and 8 both read, and it is the only field added to a type after its defining task. `Source`, `Observed`, `HealthState`, `HealthVerdict`, `HeaderRecord`, `Outcome`, `SourceStatus`, `StatusFile`, `FetchOutcome`, `GuardVerdict` and `RunDeps` are each defined in exactly one module and imported everywhere else. `checkHealth`, `hasChanged`, `checkMagnitude`, `applyOutcome`, `shouldCommitStatus`, `exitCodeFor`, `captureHeaders`, `originDateMs`, `isStaleGeneration`, `fetchSource`, `commitPaths`, `pushWithRebase`, `mapPolitely` and `runTier` keep the same names and signatures from the task that defines them through every later use.
