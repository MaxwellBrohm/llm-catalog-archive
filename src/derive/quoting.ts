/**
 * How a third-party value is allowed to appear inside a sentence this project
 * publishes. Pure: no fs, no git, no clock.
 *
 * ONE INVARIANT, AND IT IS THE COPY RULE RATHER THAN TYPOGRAPHY:
 *
 *   every byte a claim form interpolates that this repository did not write is
 *   inside a double-quoted run, and no such byte can end that run.
 *
 * Both halves are load bearing and each one alone is a published defect.
 *
 * WITHOUT THE WRAPPING, a value that is prose becomes prose we composed. The
 * catalog id `stealth/x-1. Anthropic is preparing its next flagship` is a legal
 * OpenRouter id and it was rendered, unquoted, into a sentence under this
 * project's byline with an artifact permalink attached. Nothing about the id
 * being "just an identifier" stops a vendor, or anyone who can open a pull
 * request against huggingface/transformers, from choosing it.
 *
 * WITHOUT THE NEUTRALISING, a value that carries its own double quote closes
 * the run early and everything after it is again prose we composed. The pull
 * request title
 *
 *   Add Foo model support" is real. OpenAI deprecated the Assistants API. The title "
 *
 * did exactly that, and the result was the design spec's own forbidden example,
 * verbatim, on a public page. Titles carrying double quotes are live data: one
 * of the hundred rows in each of the two stored pull-request payloads has one
 * today.
 *
 * WHY THIS IS SAFE TO DO TO THE BYTES. The verbatim value is never lost. It is
 * printed in the fact rows the renderer puts under every sentence, in cells
 * marked as archive values, and the linked artifact at the item's own commit is
 * the bytes themselves. What changes is only the copy of the value that sits
 * inside a sentence, which is the one place a reader could mistake for our own
 * words.
 *
 * WHAT THIS BUYS THE SCAN. The copy-rule detector strips double-quoted runs
 * before looking for a company in front of a verb, because a company name
 * inside a quoted archive value is describing an artifact rather than making a
 * claim. That strip is only sound if a quoted run cannot be escaped and if
 * everything third party is inside one. This function is where both become
 * true, so the detector can be pointed at real stored payloads instead of at
 * six hand-written fixtures.
 */

/**
 * A third-party value, ready to be interpolated into a claim sentence.
 *
 * Newlines, carriage returns and tabs collapse to a single space: a claim is
 * one line on a page, and a value carrying a line break renders as two.
 */
export function quoteValue(value: string): string {
  return `"${value.replace(/[\r\n\t]+/g, ' ').replace(/"/g, "'")}"`;
}

/**
 * A number read out of the archive, or `absent`.
 *
 * NOT quoted, and that is the one deliberate exception to the invariant above.
 * The argument is typed `number | null`, so it cannot carry prose, and a reader
 * comparing `1310720` on the page against `1310720` in the linked artifact
 * should be comparing the same characters rather than the same characters
 * inside quotes. A string that merely looks numeric does not come through here.
 */
export function numberOrAbsent(value: number | null): string {
  return value === null ? 'absent' : String(value);
}

/**
 * A string read out of the archive, quoted, or the bare word `absent`.
 *
 * `absent` is unquoted on purpose: it is this repository's word for a field
 * that was not there, not a value the archive holds, and quoting it would make
 * a missing price indistinguishable from a price whose literal text is
 * "absent".
 */
export function quotedOrAbsent(value: string | null): string {
  return value === null ? 'absent' : quoteValue(value);
}
