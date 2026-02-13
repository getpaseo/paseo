#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

SLEEP_SECONDS="${SLEEP_SECONDS:-600}"
MAX_ITERATIONS="${MAX_ITERATIONS:-0}" # 0 means run forever
CODEX_MODEL="${CODEX_MODEL:-gpt-5.3-codex}"
CODEX_REASONING_EFFORT="${CODEX_REASONING_EFFORT:-medium}"

read -r -d '' PROMPT <<'EOF' || true
1. load the refactor skill
2. check previous commits to see what other agents have worked on
3. identify and work on a single improvement based on the refactor skill (can be a file system reorg, file splitting, refactor, add a new test, harden a test, deflakify a test, fix a test, improve control flow, remove unused code)
4. commit with a description of what was done, your reasoning, and document accomplishments or challenges for the next agent
EOF

iteration=1
while true; do
  if [[ "${MAX_ITERATIONS}" -gt 0 && "${iteration}" -gt "${MAX_ITERATIONS}" ]]; then
    echo "Reached MAX_ITERATIONS=${MAX_ITERATIONS}; exiting."
    exit 0
  fi

  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Starting codex exec iteration ${iteration}"

  cmd=(
    codex exec
    --dangerously-bypass-approvals-and-sandbox
    --cd "${REPO_ROOT}"
  )

  if [[ -n "${CODEX_MODEL}" ]]; then
    cmd+=(--model "${CODEX_MODEL}")
  fi

  cmd+=(-c "model_reasoning_effort=\"${CODEX_REASONING_EFFORT}\"")

  if "${cmd[@]}" "${PROMPT}"; then
    echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Iteration ${iteration} completed successfully"
  else
    status=$?
    echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Iteration ${iteration} failed with exit code ${status}"
  fi

  echo "Sleeping ${SLEEP_SECONDS}s before next iteration..."
  sleep "${SLEEP_SECONDS}"
  iteration=$((iteration + 1))
done
