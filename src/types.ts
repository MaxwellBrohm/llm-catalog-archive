/**
 * Shapes shared across modules, in a file that imports nothing.
 *
 * `Observed` is needed by both `src/fetch.ts`, which does the I/O, and
 * `src/health.ts`, which must stay pure so it can be reasoned about and tested
 * without a network or a filesystem. Declaring it in `fetch.ts` would force
 * `health.ts` to import an I/O module to name its own argument type.
 */

/** Everything the health check and the run need to know about one response. */
export type Observed = {
  status: number;
  body: Uint8Array;
  finalUrl: string;
  redirectCount: number;
  headers: Record<string, string>;
};
