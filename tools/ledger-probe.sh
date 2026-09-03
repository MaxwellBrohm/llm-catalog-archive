#!/usr/bin/env bash
# Exercise the desk's ledger write against a scratch branch, never against main.
#
# THIS EXISTS BECAUSE THE PROCEDURE FAILED WHEN IT WAS A PROCEDURE. Testing the
# write by hand means setting LEDGER_BRANCH, redeploying, and checking that the
# deployed function actually picked it up. That worked once. The second time,
# `netlify env:set` did not apply, its output had been suppressed with
# >/dev/null, the health check was skipped because it had passed before, and a
# false row went into a public append-only ledger claiming a post that never
# happened.
#
# Two safeguards existed and neither was consulted, which is what a safeguard
# made of memory is worth. The health assertion below is not optional and not
# skippable: if the deployed function does not report the scratch branch, this
# script exits before anything can be written.
#
# Usage: tools/ledger-probe.sh <desk-url> <desk-key> [branch]
set -euo pipefail

url="${1:?usage: ledger-probe.sh <desk-url> <desk-key> [branch]}"
key="${2:?usage: ledger-probe.sh <desk-url> <desk-key> [branch]}"
branch="${3:-ledger-probe}"

if [ "$branch" = "main" ]; then
  echo "refusing: the whole point is to not write to main" >&2
  exit 1
fi

say() { printf '%s\n' "$*"; }

say "1. creating $branch from main"
repo="$(git remote get-url origin | sed -E 's#.*github\.com[:/]##; s#\.git$##')"
gh api "repos/$repo/git/refs/heads/$branch" -X DELETE >/dev/null 2>&1 || true
gh api "repos/$repo/git/refs" -f "ref=refs/heads/$branch" \
  -f "sha=$(git rev-parse origin/main)" >/dev/null

# Output is NOT suppressed. The run that caused this file hid exactly this line.
say "2. pointing the deployed function at $branch"
netlify env:set LEDGER_BRANCH "$branch" --context production
netlify deploy --prod --dir public --functions netlify/functions | grep -E 'Deploy complete|Error' || true

say "3. asserting the deployed function agrees, before anything is written"
seen="$(curl -fsS "$url/api/health?k=$key" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ledger"]["path"])')"
if [ "$seen" != "$branch:meta/posted.jsonl" ]; then
  say "ABORT: the desk reports its ledger as '$seen', not '$branch:meta/posted.jsonl'."
  say "Nothing was written. Put the override back before retrying:"
  say "  netlify env:unset LEDGER_BRANCH --context production && netlify deploy --prod ..."
  exit 1
fi
say "   confirmed: $seen"
say
say "Ready. Exercise the desk now, then run tools/ledger-probe-end.sh to restore."
