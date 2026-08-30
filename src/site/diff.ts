/**
 * Unified diff text to displayable lines. Pure: the argument is the stdout of
 * `git show`, and nothing here runs git.
 *
 * The counts come out of the FULL diff, before truncation, so a page that shows
 * 400 of 23,243 lines still reports 23,243. A count derived from what was
 * rendered would silently shrink with the page budget, and every number on a
 * page has to be the number the archive actually holds.
 *
 * HOW THE HEADER IS SKIPPED, and why it is not a list of prefixes. The first
 * version matched `diff --git `, `index `, `--- `, `+++ `, the mode and rename
 * lines and `\ `. Ten of those twelve arms were dead: none of those lines
 * begins with a diff marker, so the fallback at the bottom of the loop already
 * dropped them. The two that were live were wrong. A removed line whose content
 * begins with `-- ` arrives as `--- `, and an added line whose content begins
 * with `++ ` arrives as `+++ `, so a prefix list silently swallowed real
 * content and left it out of the counts as well. These are text files from
 * documentation sites, where `-- ` is an ordinary way to start a line.
 *
 * Position settles it instead: in a unified diff every header line comes before
 * the first `@@`, and after it every line carries a marker.
 */

import { MAX_DIFF_LINES, MAX_LINE_CHARS, type DiffLine } from './record.js';

export type ParsedDiff = {
  lines: DiffLine[];
  /** True when the diff had more displayable lines than the page budget. */
  truncated: boolean;
  linesAdded: number;
  linesRemoved: number;
};

function cut(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_LINE_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_LINE_CHARS), truncated: true };
}

export function parseUnifiedDiff(raw: string): ParsedDiff {
  const lines: DiffLine[] = [];
  let truncated = false;
  let linesAdded = 0;
  let linesRemoved = 0;
  let inHunk = false;

  for (const line of raw.split('\n')) {
    let kind: DiffLine['kind'];
    let body: string;

    if (line.startsWith('@@')) {
      inHunk = true;
      kind = 'hunk';
      body = line;
    } else if (!inHunk) {
      // git's file header block: `diff --git`, `index`, `--- a/x`, `+++ b/x`,
      // and any mode or rename lines. Never content.
      continue;
    } else if (line.startsWith('+')) {
      kind = 'add';
      body = line.slice(1);
      linesAdded++;
    } else if (line.startsWith('-')) {
      kind = 'remove';
      body = line.slice(1);
      linesRemoved++;
    } else if (line.startsWith(' ')) {
      kind = 'context';
      body = line.slice(1);
    } else {
      // `\ No newline at end of file`, and the trailing empty string that
      // split('\n') leaves behind. Never a content line: git prefixes every one
      // of those with a marker.
      continue;
    }

    // Counting continues past the budget on purpose; only display stops.
    if (lines.length >= MAX_DIFF_LINES) {
      truncated = true;
      continue;
    }
    const c = cut(body);
    lines.push({ kind, text: c.text, truncated: c.truncated });
  }

  return { lines, truncated, linesAdded, linesRemoved };
}
