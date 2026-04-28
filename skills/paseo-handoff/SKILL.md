---
name: paseo-handoff
description: Hand off the current task to another agent with full context. Use when the user says "handoff", "hand off", "hand this to", or wants to pass work to another agent (Codex or Claude).
user-invocable: true
---

# Handoff Skill

You are handing off the current task to another agent. Your job is to write a comprehensive handoff prompt and launch the agent via Paseo CLI.

**User's arguments:** $ARGUMENTS

---

## Prerequisites

Load the **Paseo skill** first — it contains the CLI reference for all agent commands.

## What Is a Handoff

A handoff transfers your current task — including all context, decisions, failed attempts, and constraints — to a fresh agent that will carry it to completion. The handoff prompt is the most important part: the receiving agent starts with **zero context**, so everything it needs must be in the prompt.

## Parsing Arguments

Parse `$ARGUMENTS` to determine:

1. **Provider and model** — who to hand off to
2. **Worktree** — whether to run in an isolated git worktree
3. **Task description** — any additional context the user provided

### Provider Resolution

| User says   | --provider      | Mode          |
| ----------- | --------------- | ------------- |
| _(nothing)_ | `codex/gpt-5.4` | `full-access` |
| `codex`     | `codex/gpt-5.4` | `full-access` |
| `claude`    | `claude/opus`   | `bypass`      |
| `opus`      | `claude/opus`   | `bypass`      |
| `sonnet`    | `claude/sonnet` | `bypass`      |

Default is **Codex** with `gpt-5.4`.

### Worktree Resolution

If the user says "in a worktree" or "worktree", add `--worktree` with a short descriptive branch name derived from the task. Worktrees require a `--base` branch — use the current branch in the working directory (run `git branch --show-current` to get it).

## Writing the Handoff Prompt

This is the critical step. The receiving agent has **zero context** about your conversation. The handoff prompt must be a self-contained briefing document.

### Must Include

1. **Task description** — What needs to be done, in clear imperative language
2. **Task qualifiers** — Preserve the semantics of what the user asked for:
   - If the user asked to **investigate without editing**, say "DO NOT edit any files"
   - If the user asked to **fix**, say "implement the fix"
   - If the user asked to **refactor**, say "refactor" not "rewrite"
   - Carry forward the exact intent
3. **Relevant files** — List every file path that matters, with brief descriptions of what each contains
4. **Current state** — What has been done so far, what's working, what's not
5. **What was tried** — Any approaches attempted and why they failed or were abandoned
6. **Decisions made** — Anything you and the user agreed on (design choices, constraints, trade-offs)
7. **Acceptance criteria** — How the agent knows it's done
8. **Constraints** — Anything the agent must NOT do

### Template

```
## Task

[Clear, imperative description of what to do]

## Context

[Why this task exists, background the agent needs]

## Relevant Files

- `path/to/file.ts` — [what it does and why it matters]
- `path/to/other.ts` — [what it does and why it matters]

## Current State

[What's been done, what works, what doesn't]

## What Was Tried

- [Approach 1] — [why it failed/was abandoned]
- [Approach 2] — [partial success, but...]

## Decisions

- [Decision 1 — rationale]
- [Decision 2 — rationale]

## Acceptance Criteria

- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Constraints

- [Do not do X]
- [Must preserve Y]
```

## Launching the Agent

### Default (Codex, no worktree)

```bash
paseo run -d --mode full-access --provider codex/gpt-5.4 --name "[Handoff] Task description" "$prompt"
```

### Claude (Opus, no worktree)

```bash
paseo run -d --mode bypassPermissions --provider claude/opus --name "[Handoff] Task description" "$prompt"
```

### Codex in a worktree

```bash
base=$(git branch --show-current)
paseo run -d --mode full-access --provider codex/gpt-5.4 --worktree task-branch-name --base "$base" --name "[Handoff] Task description" "$prompt"
```

### Claude in a worktree

```bash
base=$(git branch --show-current)
paseo run -d --mode bypass --provider claude/opus --worktree task-branch-name --base "$base" --name "[Handoff] Task description" "$prompt"
```

## After Launch

1. Print the agent ID and the command to follow along:
   ```
   Handed off to [provider] ([model]). Agent ID: <id>
   Follow along: paseo logs <id> -f
   Wait for completion: paseo wait <id>
   ```
2. Do **not** wait for the agent by default — the user can choose to wait or move on.
3. If the user wants to wait, run `paseo wait <id>` and then `paseo logs <id>` when done.
