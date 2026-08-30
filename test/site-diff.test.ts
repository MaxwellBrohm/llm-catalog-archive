import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff } from '../src/site/diff.js';
import { MAX_DIFF_LINES, MAX_LINE_CHARS } from '../src/site/record.js';

/** The real shape of `git show --format= --unified=3 <sha> -- <path>`. */
const REAL = [
  'diff --git a/raw/openai-llms-txt/response.txt b/raw/openai-llms-txt/response.txt',
  'index 3d62d09..3d55f13 100644',
  '--- a/raw/openai-llms-txt/response.txt',
  '+++ b/raw/openai-llms-txt/response.txt',
  '@@ -17,12 +17,7 @@ Each entry has a Markdown twin at `/api/docs/<slug>.md`.',
  ' ',
  ' ## Assistants',
  '-- [Assistants API deep dive](https://x/deep-dive.md): A detailed guide.',
  '-- [Assistants API tools](https://x/tools.md): Learn about the tools.',
  '+- [Assistants migration guide](https://x/migration.md): Migrate.',
  ' ',
  ' ## Bots',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('counts added lines from the whole diff', () => {
    expect(parseUnifiedDiff(REAL).linesAdded).toBe(1);
  });

  it('counts removed lines from the whole diff', () => {
    expect(parseUnifiedDiff(REAL).linesRemoved).toBe(2);
  });

  // The `--- a/x` and `+++ b/x` header pair is one line starting with '-' and
  // one starting with '+'. Counting them would report 2 and 3 above.
  it('does not count the file header pair as a removal and an addition', () => {
    const counts = parseUnifiedDiff(REAL);
    expect([counts.linesAdded, counts.linesRemoved]).toEqual([1, 2]);
  });

  it('drops the file header lines from the displayed diff', () => {
    const texts = parseUnifiedDiff(REAL).lines.map((l) => l.text);
    expect(texts).not.toContain('--- a/raw/openai-llms-txt/response.txt');
  });

  it('keeps the hunk header, which carries the line numbers', () => {
    expect(parseUnifiedDiff(REAL).lines[0]).toEqual({
      kind: 'hunk',
      text: '@@ -17,12 +17,7 @@ Each entry has a Markdown twin at `/api/docs/<slug>.md`.',
      truncated: false,
    });
  });

  it('strips the marker from a removed line so the gutter carries it instead', () => {
    expect(parseUnifiedDiff(REAL).lines[3]).toEqual({
      kind: 'remove',
      text: '- [Assistants API deep dive](https://x/deep-dive.md): A detailed guide.',
      truncated: false,
    });
  });

  it('strips the marker from an added line', () => {
    expect(parseUnifiedDiff(REAL).lines[5]).toEqual({
      kind: 'add',
      text: '- [Assistants migration guide](https://x/migration.md): Migrate.',
      truncated: false,
    });
  });

  it('strips the single leading space from a context line', () => {
    expect(parseUnifiedDiff(REAL).lines[2]).toEqual({
      kind: 'context',
      text: '## Assistants',
      truncated: false,
    });
  });

  it('produces exactly the displayable lines and nothing else', () => {
    expect(parseUnifiedDiff(REAL).lines).toHaveLength(8);
  });

  it('does not truncate a diff inside the budget', () => {
    expect(parseUnifiedDiff(REAL).truncated).toBe(false);
  });

  it('cuts a line longer than the character budget', () => {
    const long = `@@ -0,0 +1 @@\n+${'x'.repeat(MAX_LINE_CHARS + 50)}\n`;
    expect(parseUnifiedDiff(long).lines[1]?.text).toHaveLength(MAX_LINE_CHARS);
  });

  it('marks a cut line as truncated', () => {
    const long = `@@ -0,0 +1 @@\n+${'x'.repeat(MAX_LINE_CHARS + 50)}\n`;
    expect(parseUnifiedDiff(long).lines[1]?.truncated).toBe(true);
  });

  it('leaves a line exactly at the character budget uncut', () => {
    const exact = `@@ -0,0 +1 @@\n+${'x'.repeat(MAX_LINE_CHARS)}\n`;
    expect(parseUnifiedDiff(exact).lines[1]?.truncated).toBe(false);
  });

  it('stops displaying at the line budget', () => {
    const many = ['@@ -0,0 +1 @@', ...Array.from({ length: MAX_DIFF_LINES + 20 }, (_, i) => `+line ${i}`)].join('\n');
    expect(parseUnifiedDiff(many).lines).toHaveLength(MAX_DIFF_LINES);
  });

  it('flags a diff that ran past the line budget', () => {
    const many = ['@@ -0,0 +1 @@', ...Array.from({ length: MAX_DIFF_LINES + 20 }, (_, i) => `+line ${i}`)].join('\n');
    expect(parseUnifiedDiff(many).truncated).toBe(true);
  });

  // The counts are the archive's numbers, not the page's. A count that stopped
  // with the display would under-report every first capture.
  it('keeps counting past the line budget', () => {
    const many = ['@@ -0,0 +1 @@', ...Array.from({ length: MAX_DIFF_LINES + 20 }, (_, i) => `+line ${i}`)].join('\n');
    expect(parseUnifiedDiff(many).linesAdded).toBe(MAX_DIFF_LINES + 20);
  });

  it('reports an empty diff as no lines', () => {
    expect(parseUnifiedDiff('')).toEqual({ lines: [], truncated: false, linesAdded: 0, linesRemoved: 0 });
  });

  it('does not count the no-newline marker as a removal', () => {
    const marker = '@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n';
    expect(parseUnifiedDiff(marker).linesRemoved).toBe(1);
  });

  it('counts a first capture as all additions and no removals', () => {
    const added = '@@ -0,0 +1,2 @@\n+one\n+two\n';
    expect([parseUnifiedDiff(added).linesAdded, parseUnifiedDiff(added).linesRemoved]).toEqual([2, 0]);
  });
});

/**
 * The header block, and the content that looks exactly like it.
 *
 * A removed line whose own text begins with `-- ` arrives as `--- `, and an
 * added line whose text begins with `++ ` arrives as `+++ `. A prefix list
 * cannot tell those from git's `--- a/x` and `+++ b/x`, and these are
 * documentation files where a line can begin with anything.
 */
describe('parseUnifiedDiff: header lines against content that mimics them', () => {
  const MIMIC = ['@@ -1,2 +1,2 @@', '--- a note that was removed', '+++ a note that was added', ' kept'].join('\n');

  it('counts a removed line whose own text begins with two dashes', () => {
    expect(parseUnifiedDiff(MIMIC).linesRemoved).toBe(1);
  });

  it('counts an added line whose own text begins with two pluses', () => {
    expect(parseUnifiedDiff(MIMIC).linesAdded).toBe(1);
  });

  it('displays the removed line rather than mistaking it for a file header', () => {
    expect(parseUnifiedDiff(MIMIC).lines[1]).toEqual({
      kind: 'remove',
      text: '-- a note that was removed',
      truncated: false,
    });
  });

  it('displays the added line rather than mistaking it for a file header', () => {
    expect(parseUnifiedDiff(MIMIC).lines[2]).toEqual({
      kind: 'add',
      text: '++ a note that was added',
      truncated: false,
    });
  });

  const FULL_HEADER = [
    'diff --git a/raw/x/response.txt b/raw/x/response.txt',
    'old mode 100644',
    'new mode 100755',
    'new file mode 100644',
    'deleted file mode 100644',
    'similarity index 96%',
    'rename from raw/old/response.txt',
    'rename to raw/x/response.txt',
    'index 3d62d09..3d55f13 100644',
    '--- a/raw/x/response.txt',
    '+++ b/raw/x/response.txt',
    '@@ -1 +1 @@',
    '-before',
    '+after',
    '',
  ].join('\n');

  it('displays only the two content lines out of a full header block', () => {
    expect(parseUnifiedDiff(FULL_HEADER).lines.map((l) => l.text)).toEqual(['@@ -1 +1 @@', 'before', 'after']);
  });

  it('counts one addition across a full header block', () => {
    expect(parseUnifiedDiff(FULL_HEADER).linesAdded).toBe(1);
  });

  it('counts one removal across a full header block', () => {
    expect(parseUnifiedDiff(FULL_HEADER).linesRemoved).toBe(1);
  });

  it('reads nothing at all from a diff with no hunk', () => {
    expect(parseUnifiedDiff('diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n').lines).toEqual([]);
  });
});
