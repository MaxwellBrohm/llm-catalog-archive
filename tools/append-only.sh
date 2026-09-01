#!/usr/bin/env bash
# The append-only ledger guard.
#
# EXTRACTED FROM .github/workflows/append-only.yml SO IT CAN BE TESTED. As
# inline workflow shell it was unreachable from the suite, and two mutations
# proved that mattered: changing `-ne 0` to `-lt 0`, which grep -c can never
# satisfy, and deleting two of the three ledgers from the loops. Both left 2,345
# tests green while disabling the guarantee entirely.
#
# Usage: tools/append-only.sh <base-ref> [repo-dir]
# Exit 0 = every ledger only gained lines. Exit 1 = a violation, or the check
# could not be performed, which is deliberately the same answer: a guard that
# cannot run has not passed.
set -euo pipefail

base="${1:?usage: append-only.sh <base-ref> [repo-dir]}"
cd "${2:-.}"

LEDGERS="meta/corrections.jsonl meta/retractions.jsonl meta/leaks-ledger.jsonl"

# Existence first, because it needs no diff base and the diff below cannot see
# this. Deleting a zero-line file produces no '-' content lines at all, so while
# the ledgers are still empty, git rm would otherwise sail through every check
# underneath.
for f in $LEDGERS; do
  if [ ! -f "$f" ]; then
    echo "::error::$f is missing; the append-only ledgers may not be deleted or renamed"
    exit 1
  fi
done

# A branch-creation push reports an all-zeroes before-sha. There is genuinely no
# prior state to compare against, so skip.
case "$base" in
  *[!0]*) ;;
  *)
    echo "::notice::no prior commit on this branch (before-sha is all zeroes); skipping the ledger diff"
    exit 0
    ;;
esac

# A base that looks like a sha but is unreachable means the commit it named was
# discarded, i.e. history was rewritten. That is one of the ways an append-only
# ledger gets violated, so it must fail rather than skip.
if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  echo "::error::diff base $base is not a reachable commit, which normally means history was force-pushed away; the append-only check could not be performed"
  exit 1
fi

# git's own exit status has to be checked. grep -c prints 0 and exits 1 when it
# matches nothing, so piping a failed diff into it reports "no lines removed"
# exactly as confidently as a clean diff does.
diff_out="$(mktemp)"
trap 'rm -f "$diff_out"' EXIT

for f in $LEDGERS; do
  if ! git diff "$base" HEAD -- "$f" > "$diff_out"; then
    echo "::error::git diff $base HEAD -- $f failed; the append-only check could not be performed"
    exit 1
  fi
  grep_rc=0
  removed=$(grep -c '^-[^-]' "$diff_out") || grep_rc=$?
  if [ "$grep_rc" -gt 1 ]; then
    echo "::error::grep exited $grep_rc while scanning the diff of $f; the append-only check could not be performed"
    exit 1
  fi
  if [ "$removed" -ne 0 ]; then
    echo "::error::$f is append-only; $removed line(s) removed or modified"
    exit 1
  fi
done

echo "every ledger only gained lines"
