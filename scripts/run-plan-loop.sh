#!/usr/bin/env bash
set -euo pipefail

PLAN_FILE=${1:-plan.md}
if [[ ! -f "$PLAN_FILE" ]]; then
  echo "Plan file not found: $PLAN_FILE" >&2
  exit 1
fi

REPO_ROOT=$(cd "$(dirname "$PLAN_FILE")" && pwd)
PLAN_PATH="$REPO_ROOT/$(basename "$PLAN_FILE")"
IMPLEMENT_PROMPT=$(cat <<EOF2
You are Codex working in $REPO_ROOT.
1. Read the checklist at $PLAN_PATH.
2. Implement the very first unchecked task (top-most "- [ ]" entry) completely. Do not skip around.
3. After finishing the work, update $PLAN_PATH:
   - Change that task marker to "- [x]".
   - Under that list item add an indented bullet summarizing the work/tests/follow-ups.
4. Stop immediately after completing that single task.
EOF2
)
REVIEW_PROMPT=$(cat <<EOF3
You are Codex acting as a reviewer.
1. Read $PLAN_PATH and inspect the repository.
2. Review the work completed in the prior step: hunt for duplicate code, missing types, bugs, regressions, or corners that were cut.
3. If something is wrong, fix it or add new checklist items describing the follow-up.
4. Reorder or uncheck tasks when needed and always add context lines so we know what changed.
5. Stop after updating $PLAN_PATH with your findings (new tasks, reopened ones, etc.).
EOF3
)

iteration=1
while grep -q '\- \[ \]' "$PLAN_PATH"; do
  echo "=== Iteration $iteration: implement next task ==="
  codex exec --dangerously-bypass-approvals-and-sandbox -C "$REPO_ROOT" "$IMPLEMENT_PROMPT"

  echo "=== Iteration $iteration: review & adjust plan ==="
  codex exec --dangerously-bypass-approvals-and-sandbox -C "$REPO_ROOT" "$REVIEW_PROMPT"

  iteration=$((iteration + 1))
done

echo "All tasks in $PLAN_PATH are complete."
