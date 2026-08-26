// No status import: `src/status.ts` does not exist until Task 10, and this
// minimal run has no status store. Task 10 widens `RunResult.status`.
import type { Source } from './config.js';
import type { FetchOutcome } from './fetch.js';
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
