---
name: paseo-handoff
description: Hand off the current task to another agent with full context. Use when the user says "handoff", "hand off", "hand this to", or wants to pass work to another agent.
user-invocable: true
---

# Handoff Skill

Transfer the current task — context, decisions, failed attempts, constraints — to a fresh agent. The receiving agent starts with **zero context**, so the handoff prompt must be a self-contained briefing.

**User's arguments:** $ARGUMENTS

## Prerequisites

Read the **paseo** skill — provider for the receiving agent comes from orchestration preferences unless the user names one.

## Parsing arguments

1. **Provider** — explicit user request first; otherwise resolve from `impl` preference (or `ui` if the task is styling-only).
2. **Worktree** — "in a worktree" / "worktree" → create a worktree via Paseo with a short branch name derived from the task, based on the current branch.
3. **Task description** — anything else the user said.

## The handoff prompt

The receiving agent has zero context. Include:

```
## Task
[Imperative description.]

## Context
[Why this task exists, background needed.]

## Relevant files
- `path/to/file.ts` — [what it is and why it matters]

## Current state
[What's done, what works, what doesn't.]

## What was tried
- [Approach] — [why it failed or was abandoned]

## Decisions
- [Decision — rationale]

## Acceptance criteria
- [ ] [Criterion]

## Constraints
- [Must-not / must-preserve]
```

**Preserve task semantics.** Investigate-only → "DO NOT edit files." Fix → "implement the fix." Refactor → "refactor, not rewrite." Carry the user's exact intent.

## Launch

Create the agent via Paseo with a `[Handoff] <task>` title, the briefing as initial prompt, and cwd set to the worktree path if `--worktree`.

Don't wait by default — the user decides whether to follow along or move on. Tell them the agent ID and how to follow along (the paseo skill explains).
