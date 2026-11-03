---
name: paseo-handoff
description: Hand off the current task to another agent with full context. Use when the user says "handoff", "hand off", "hand this to", or wants to pass work to another agent.
user-invocable: true
---

# Handoff Skill

Transfer the current task — context, decisions, failed attempts, constraints — to a fresh agent. The receiving agent starts with **zero context**, so the handoff prompt must be a self-contained briefing.

Use the user's request and current conversation as input, including any arguments supplied with the skill invocation.

## Prerequisites

Read the **paseo** skill.

## Choosing the receiving agent

A handoff starts a fresh agent on your provider, model, mode, and features.

1. **Named profile, provider, or specialty** — the user named a profile, a provider, a model, or a specialty such as review or planning. Call `list_profiles` and apply the match as the **paseo** skill describes. When a named specialty has no matching profile, say so and continue with your own provider.
2. **Otherwise** — omit `provider` and `settings` on `create_agent`. Skip `list_profiles`, `list_providers`, and `list_models`. Leave the provider field unset so the child keeps yours.

Another agent is a new conversation. It keeps the provider you were started with.

## Parsing arguments

1. **Receiving agent** — follow the choice above.
2. **Isolation** — "in a worktree" / "worktree" → create a workspace with `isolation: "worktree"`, using a short branch name derived from the task.
3. **Task description** — anything else the user said.

## The handoff prompt

The receiving agent has zero context. Include:

```
## Task
[Imperative description.]

## Context
[Why this task exists, required context.]

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

Prepare the handoff in a dedicated workspace:

1. Select the current workspace or call `create_workspace` with the requested isolation.
2. Call `create_agent` with a `[Handoff] <task>` title, the briefing as initial prompt, and the selected `workspaceId` when explicit placement is needed.
3. Return the agent and workspace to the user, explaining that it remains in your subagent track until they detach it manually.

Do not encode independence as a create mode and do not invoke CLI or wire-level detach operations. Detach is a user gesture in the subagents track.

Do not wait or poll for the agent to finish.
