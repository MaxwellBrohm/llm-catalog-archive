// No status import: `src/status.ts` does not exist until Task 10, and this
// minimal run has no status store. Task 10 widens `RunResult.status`.
import type { Source } from './config.js';
import type { FetchOutcome } from './fetch.js';
import { checkHealth } from './health.js';
import { buildSidecar } from './headers.js';

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

export type RunResult = { exitCode: number; status: null; trace: string[] };

const headersPathFor = (s: Source) => `raw/${s.id}/headers.json`;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The pipeline, in the one order it can have:
 *
 *   fetch -> health check -> change predicate -> write -> commit -> push
 *
 * A response that fails the health check is never written and never committed,
 * so the last-good bytes on disk are never clobbered by a challenge page, a
 * soft 404 or a redirect stub. The health check reads the size of the stored
 * artifact to compute its band, which is why the stored bytes are loaded
 * before the verdict rather than after it; reading is not writing and the
 * order above still holds.
 *
 * Tasks 7 through 10 insert the full predicate dispatch, the magnitude guard
 * and the status store; Task 11 locks the resulting order with tests.
 */
export async function runTier(
  sources: Source[],
  _tier: 'fast' | 'daily',
  _prevStatus: null,
  deps: RunDeps,
): Promise<RunResult> {
  const trace: string[] = [];

  for (const s of sources) {
    // The caller already filters on status, and this repeats it on purpose. The
    // three volatile sources change on every request for reasons that are not
    // content, so a byte predicate would commit megabytes daily into a history
    // R7 forbids rewriting. Two locks, because only one of them is permanent.
    if (s.status !== 'active') {
      deps.log(`${s.id}: pending, skipped`);
      continue;
    }

    try {
      const got = await deps.fetchOne(s);
      if (!got.ok) {
        deps.log(`${s.id}: fetch failed after ${got.attempts} attempts: ${got.error}`);
        continue;
      }

      const stored = deps.readFile(s.path);

      const health = checkHealth(
        s,
        got.observed,
        { bytes: stored === null ? null : stored.byteLength },
        Date.parse(deps.nowIso()),
      );
      if (!health.writeAllowed) {
        // Not written, not committed. The bytes already in the archive are the
        // last ones that passed, and an error page served at 200 must not be
        // the thing that replaces them in a history R7 forbids rewriting.
        deps.log(`${s.id}: ${health.state}, not written: ${health.reason}`);
        trace.push(`${health.state}:${s.id}`);
        continue;
      }
      if (health.state === 'relocated') {
        // Writable, and worth saying out loud: the bytes are good and it is the
        // url in meta/sources.json that has gone stale.
        deps.log(`${s.id}: relocated, ${health.reason}`);
      }

      if (stored !== null && sameBytes(got.observed.body, stored)) continue;

      // Verbatim. The bytes written are the bytes received, always.
      deps.writeFile(s.path, got.observed.body);
      deps.writeFile(
        headersPathFor(s),
        new TextEncoder().encode(JSON.stringify(buildSidecar(got.headers), null, 2) + '\n'),
      );
      deps.commitPaths(
        [s.path, headersPathFor(s)],
        `${s.id}: changed (${got.observed.body.byteLength} bytes, HTTP ${got.observed.status})`,
      );
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
