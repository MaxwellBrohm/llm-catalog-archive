#!/usr/bin/env bash
# Undo tools/ledger-probe.sh: point the desk back at main and delete the branch.
#
# Separate from the setup script because the probe happens between them, and a
# single script that did both would have to guess when the person is finished.
# It asserts the restore took, for the same reason the setup asserts the
# override took: an unverified restore leaves the desk writing to a branch that
# is about to be deleted, which loses rows silently.
set -euo pipefail

url="${1:?usage: ledger-probe-end.sh <desk-url> <desk-key> [branch]}"
key="${2:?usage: ledger-probe-end.sh <desk-url> <desk-key> [branch]}"
branch="${3:-ledger-probe}"

netlify env:unset LEDGER_BRANCH --context production
netlify deploy --prod --dir public --functions netlify/functions | grep -E 'Deploy complete|Error' || true

seen="$(curl -fsS "$url/api/health?k=$key" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ledger"]["path"])')"
if [ "$seen" != "main:meta/posted.jsonl" ]; then
  echo "ABORT: the desk still reports '$seen'. Do NOT delete $branch yet." >&2
  exit 1
fi
echo "restored: $seen"

repo="$(git remote get-url origin | sed -E 's#.*github\.com[:/]##; s#\.git$##')"
gh api "repos/$repo/git/refs/heads/$branch" -X DELETE >/dev/null 2>&1 || true
echo "deleted $branch"
