/**
 * `collect --tier fast|daily`.
 *
 * Fetching is serial. Task 12 adds the politeness pool. Thirteen sources at a
 * 60 second timeout is under fifteen minutes in the worst case and typically
 * well under one, which is comfortably inside a daily slot.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSources, activeSourcesForTier } from './config.js';
import { fetchSource } from './fetch.js';
import { runTier } from './run.js';
import { commitPaths, pushWithRebase } from './git.js';

const cwd = process.cwd();
const i = process.argv.indexOf('--tier');
const tier = i === -1 ? undefined : process.argv[i + 1];
if (tier !== 'fast' && tier !== 'daily') {
  console.error('usage: collect --tier fast|daily');
  process.exit(2);
}

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
  push: () => {
    if (process.env['LCA_NO_PUSH'] !== '1') pushWithRebase(cwd, process.env['LCA_BRANCH'] ?? 'main');
  },
  log: (l) => console.log(l),
});

process.exit(result.exitCode);
