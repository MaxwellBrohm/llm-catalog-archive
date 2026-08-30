import { defineConfig } from 'vitest/config';
/**
 * The suite Stryker runs. Identical to vitest.config.ts except that
 * test/cli.test.ts and test/site-cli.test.ts are excluded: they shell out to
 * `tsx src/cli.ts` and `tsx src/site-cli.ts`, and a
 * subprocess cannot see Stryker's in-process mutant switch, so those tests can
 * neither kill a mutant nor run fast enough to be worth executing 850 times.
 * src/cli.ts and src/site-cli.ts are therefore mutation-tested by hand, not by
 * Stryker.
 */
export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'], exclude: ['test/cli.test.ts', 'test/site-cli.test.ts', 'node_modules/**'] },
});
