#!/usr/bin/env bash
set -euo pipefail

MAX_ITERATIONS="${MAX_ITERATIONS:-20}"
SLEEP_BETWEEN="${SLEEP_BETWEEN:-5}"

GREEN='\033[0;32m' YELLOW='\033[1;33m' NC='\033[0m'
log()  { echo -e "${GREEN}[fix-tests]${NC} $*"; }
warn() { echo -e "${YELLOW}[fix-tests]${NC} $*"; }

if [ "$(git branch --show-current)" = "main" ]; then
  BRANCH="fix-tests-$(date +%s)"
  log "Creating branch $BRANCH"
  git checkout -b "$BRANCH"
fi

read -r -d '' AGENT_PROMPT << 'PROMPT' || true
Find ONE failing test across the entire repo and fix it.

The objective: get CI green on GitHub Actions. The build has been red for ages and it's embarrassing. Not all tests can run in GH Actions but MOST of them should.

Use --bail 1 / --max-failures 1 / fail-fast ALWAYS. Do not run the whole suite. Find the first failure FAST.

Auth is fully configured: CLAUDE_CODE_OAUTH_TOKEN and OPENAI_API_KEY are set. OpenCode uses free models needing no auth. All three providers work. There is zero reason to check for auth or skip tests based on environment.

Work across all packages — server unit tests, server e2e, daemon tests, app unit tests, Playwright browser e2e, CLI integration tests. All of them.

When a test fails:
- Outdated (tests removed/renamed APIs) → fix or delete if unnecessary
- Flaky (races, timing) → make it deterministic
- Too slow → make it fast or delete

Do NOT weaken tests. Do NOT add conditionals. Do NOT introduce mocks — we use real environment on purpose because we want to test the REAL thing. Do NOT add auth gating or skip conditions. Do NOT implement new features to make a test pass. You are here to fix tests, not build features. If a test expects unimplemented behavior, delete it.

While you're in a file, improve it:
- Refactor repeated code RUTHLESSLY. Extract shared helpers across test files.
- Simplify complex tests. Tests should read almost like plain English.

Test philosophy for this project:
- What we love: general e2e tests that test as close to the user as possible. CLI tests against a real daemon. E2E tests against a real daemon. Playwright browser tests. These are the most valuable.
- Unit tests are for pure functions and specific provider functionality.
- If a test doesn't add real value, delete it. Don't preserve tests for coverage theater.

Resource hygiene:
- Many tests spawn temporary daemons or do heavy setup. Pay attention to cleanup.
- Make sure cleanup works consistently and runs even on failure.
- When killing processes, ensure you're ONLY killing test processes that YOU ran. Use PIDs, not broad patterns.

After changes: run typecheck (npm run typecheck --workspaces --if-present).

Skip *.real.e2e.test.ts and *.local.e2e.test.ts (local-only manual testing).
PROMPT

for i in $(seq 1 "$MAX_ITERATIONS"); do
  log "━━━ Iteration $i/$MAX_ITERATIONS ━━━"

  if ! git diff --quiet 2>/dev/null; then
    git add -A
    git commit -m "fix(tests): iteration $((i-1))" || true
  fi

  log "Launching Codex agent via Paseo..."
  paseo run \
    --provider codex \
    --model gpt-5.4 \
    --thinking medium \
    --mode full-access \
    --name "Fix Tests #$i" \
    "$AGENT_PROMPT" || {
      warn "Agent exited non-zero (iteration $i), continuing..."
    }

  if ! git diff --quiet 2>/dev/null || [ -n "$(git ls-files --others --exclude-standard)" ]; then
    git add -A
    git commit -m "fix(tests): iteration $i" || true
  else
    warn "No changes in iteration $i"
  fi

  sleep "$SLEEP_BETWEEN"
done

log "Done. Review: git log --oneline main..HEAD"
