/**
 * Personal data, out of the RENDERED diff and only out of the rendered diff.
 * Pure: the argument is one line of stored text.
 *
 * WHY THIS IS NOT A VIOLATION OF R1. R1 governs the ARCHIVE: bytes are stored
 * verbatim, and R7 keeps them. This module governs the PUBLICATION, which is a
 * rendering of those bytes and has never been a byte-for-byte echo of them: it
 * already truncates long lines, escapes HTML and declines to print a date whose
 * precision it cannot support. Declining to republish a stranger's email
 * address on a public page is the same kind of refusal, and it costs a reader
 * nothing, because every diff sits beside a permalink to the exact artifact at
 * the exact commit, where the unredacted bytes are.
 *
 * WHY IT REDACTS EVERY ADDRESS RATHER THAN THE PERSONAL ONES. Telling a role
 * address from a personal one is a judgement (`noreply@anthropic.com` is
 * plainly a role, `claude@jperla.com` is plainly a person, and a good few sit
 * between). A heuristic that is right most of the time still publishes a
 * private address whenever it is wrong, and the cost of being wrong is not
 * symmetric with the cost of redacting a role address that nobody needed to
 * read in a diff. So the rule is uniform and has no exceptions to get wrong.
 *
 * WHAT BROUGHT IT. `modelsdev-commits` is an Atom feed of commits to
 * models.dev, and an Atom commit entry carries `<email>` for every author and
 * every `Co-authored-by:` trailer. Nine distinct addresses reached the built
 * site through the rendered diff, four of them personal. The About page had a
 * disclosure about user-generated content that named two OTHER sources, whose
 * author fields are stored but never rendered, and did not name this one.
 */

/**
 * Deliberately broader than RFC 5322. A rendering filter should over-match: a
 * false positive costs one redacted string in a diff, a false negative
 * publishes somebody's address.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export const EMAIL_PLACEHOLDER = '[email redacted]';

/** How many addresses `redactLine` would mask. Used to report, and to test. */
export function countEmails(text: string): number {
  return text.match(EMAIL)?.length ?? 0;
}

/** One line of stored text, with every email address masked. */
export function redactLine(text: string): string {
  return text.replace(EMAIL, EMAIL_PLACEHOLDER);
}
