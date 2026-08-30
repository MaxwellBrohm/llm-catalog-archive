/**
 * Literals for the site tests. Not a test file: vitest only collects
 * `test/**\/*.test.ts`.
 *
 * These are the real bytes of the first content change the archive holds,
 * commit a0a9e12, so a rendering assertion that passes here is an assertion
 * about a page a reader can actually open.
 */

import type { ArtifactChange, ChangeRecord, SidecarView } from '../src/site/record.js';

export const SHA = 'a0a9e12e5287b8ce564e6de63a280498413484cf';
export const OTHER_SHA = '0e91a0fbf78e6302670dc61a8c28502e418d01a1';

export const sidecar = (over: Partial<SidecarView> = {}): SidecarView => ({
  observedAt: '2026-08-28T11:23:40.960Z',
  originDate: '2026-08-28T08:08:22.000Z',
  status: 200,
  finalUrl: 'https://developers.openai.com/api/docs/llms.txt',
  etag: 'W/"2aa51de06cc463589d265a6e160614ea"',
  lastModified: 'Fri, 28 Aug 2026 08:08:22 GMT',
  date: 'Fri, 28 Aug 2026 11:23:40 GMT',
  age: '11718',
  cacheControl: 'public, max-age=0, must-revalidate',
  cfCacheStatus: null,
  contentEncoding: 'br',
  contentLength: null,
  ...over,
});

export const artifact = (over: Partial<ArtifactChange> = {}): ArtifactChange => ({
  sourceId: 'openai-llms-txt',
  path: 'raw/openai-llms-txt/response.txt',
  kind: 'modified',
  linesAdded: 1,
  linesRemoved: 6,
  bytes: 33743,
  sidecar: sidecar(),
  diff: [
    { kind: 'hunk', text: '@@ -17,12 +17,7 @@', truncated: false },
    { kind: 'context', text: '## Assistants', truncated: false },
    { kind: 'remove', text: '- [Assistants API deep dive](https://x/deep-dive.md)', truncated: false },
    { kind: 'add', text: '- [Assistants migration guide](https://x/migration.md)', truncated: false },
  ],
  diffTruncated: false,
  ...over,
});

export const record = (over: Partial<ChangeRecord> = {}): ChangeRecord => ({
  sha: SHA,
  subject: 'openai-llms-txt: changed (33743 bytes, HTTP 200)',
  artifacts: [artifact()],
  retraction: null,
  ...over,
});
