---
name: paseo-loop
description: Run an agent loop until an exit condition is met. Use when the user says "loop", "babysit", "keep trying until", "check every X", "watch", or wants iterative autonomous execution.
user-invocable: true
---

# Paseo Loop Skill

You are setting up a loop — an iterative worker/verifier cycle managed by the Paseo daemon.

**User's arguments:** $ARGUMENTS

---

## Prerequisites

Load the **Paseo skill** first. It contains the CLI reference for `paseo loop` and related commands.

## Core Model

A loop repeats: launch a worker → verify → repeat until done or limits hit.

1. **Worker prompt**: what the worker does each iteration
2. **Verification**: verifier prompt and/or shell checks that judge success
3. **Sleep**: optional pause between iterations
4. **Stop conditions**: max iterations and/or max total runtime
5. **Model selection**: different providers/models for worker vs verifier
6. **Archive**: optionally preserve agent history after each iteration

## Verification

Every loop needs at least one form of verification:

- `--verify "<prompt>"` — a verifier agent judges the worker's output
- `--verify-check "<command>"` — a shell command that must exit 0 (repeatable)
- Both can be combined: shell checks run first, then the verifier prompt

## Model Selection

Choose the right provider/model for worker and verifier independently:

- `--provider <provider/model>` — sets the worker (e.g. `codex/gpt-5.4`)
- `--verify-provider <provider/model>` — sets the verifier (e.g. `claude/opus`)

Default: both use Claude/sonnet. For implementation loops, use Codex for the worker and Claude for the verifier — each catches the other's blind spots.

## Archive

`--archive` preserves worker and verifier agents after each iteration instead of destroying them. Use this when you need to inspect conversation history for debugging.

## Defaults by User Intent

### Babysit / watch / check every X

```bash
paseo loop run "Check PR #42. Review CI, comments, and branch status. Fix issues as they arise." \
  --verify-check "gh pr checks 42 --fail-fast" \
  --sleep 2m \
  --max-time 1h \
  --name babysit-pr-42
```

### Keep trying until tests pass

```bash
paseo loop run "Run the test suite, investigate failures, and fix the code." \
  --provider codex/gpt-5.4 \
  --verify "Run the test suite. Return done=true only if all tests pass. Cite the exact command and outcome." \
  --verify-check "npm test" \
  --max-iterations 10 \
  --name fix-tests
```

### Implementation loop with cross-provider review

```bash
paseo loop run "Implement issue #456. Make incremental progress each iteration." \
  --provider codex/gpt-5.4 \
  --verify "Verify issue #456 is complete. Check changed files, run typecheck and tests." \
  --verify-provider claude/sonnet \
  --max-iterations 8 \
  --max-time 2h \
  --archive \
  --name issue-456
```

## Managing Loops

```bash
paseo loop ls                   # List all loops
paseo loop inspect <id>         # Show details and iteration history
paseo loop logs <id>            # Stream logs
paseo loop stop <id>            # Stop a running loop
```

## Your Job

1. Understand the user's intent from the conversation and `$ARGUMENTS`
2. Decide the worker prompt — self-contained, concrete about what to do
3. Decide verification — shell checks for objective criteria, verifier prompt for judgment
4. Choose providers/models for worker and verifier
5. Choose sleep only when the task is polling or waiting on an external system
6. Add sensible stop conditions
7. Run `paseo loop run` with the final arguments

## Prompt Writing Rules

### Worker prompt

The worker prompt must be:

- self-contained
- concrete about commands, files, branches, tests, PRs, or systems to inspect
- explicit about what counts as progress this iteration

### Verifier prompt

The verifier prompt should:

- check facts, not offer fixes
- cite commands, outputs, or file evidence
- be specific about what "done" means
