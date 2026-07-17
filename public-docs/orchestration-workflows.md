---
title: Common orchestration workflows
description: Copyable prompts for delegating, parallelizing, reviewing, and continuing agent work with Paseo.
nav: Common workflows
order: 31
category: Orchestration
---

# Common orchestration workflows

These examples are prompts for your main agent. Change the provider, model, task, and branch names to fit your work.

## Send work to a different model

Keep a strong planner in the main chat and send implementation to a workhorse:

```text
Stay as the orchestrator. Use Paseo to find the available Codex 5.6 model, then
create a subagent in a new worktree. Ask it to implement the parser change and
run the focused tests.
```

Ask the orchestrator to inspect providers first when you are unsure of the exact model ID. Available models come from your own installed and authenticated CLIs.

## Fan out research

Read-only work can safely share one workspace:

```text
Create three Paseo subagents in this workspace. Have one trace the request path,
one inspect the tests, and one look for related regressions. Do not edit files.
Synthesize their findings when all three report back.
```

Each worker appears in the Subagents track, and the orchestrator can keep working while they run.

## Parallelize edits without collisions

Give each independent implementation its own git worktree:

```text
Split these two issues between two Paseo subagents. Create a separate worktree
from main for each issue, use the best available implementation model, and have
each agent run the focused checks for its change. Summarize both diffs when done.
```

Use the current workspace for collaboration on the same files. Use worktrees when agents may edit independently.

## Implement, then review

Use different models for making and judging the change:

```text
Create a worker in a new worktree to implement this feature. When it finishes,
create a second subagent on the same worktree to review the diff for correctness,
missing tests, and unnecessary complexity. Bring the review back here.
```

The second agent sees the worker's files without sharing its conversation context, which makes the review more independent.

## Check, redirect, or continue work

The orchestrator can inspect a worker and send a follow-up without starting over:

```text
Summarize what the subagents are doing and flag anything blocked.
```

```text
Tell the parser worker to add the malformed-input case and rerun its test file.
```

```text
Cancel the UI worker's current turn, but keep the agent so I can redirect it.
```

## Keep an agent working with a heartbeat

Use a heartbeat when the current agent should wake itself up, reassess the task, and continue working:

```text
Use Paseo to create a heartbeat every 10 minutes. Continue this migration in
small steps, run the focused checks after each step, and stop when the migration
is complete or after two hours.
```

```text
Create a heartbeat every 5 minutes to check this deployment. Investigate any
failure and report meaningful changes in this conversation. Stop after one hour.
```

A heartbeat returns to the same conversation. For cron-style recurring work such as daily triage, use a [schedule](/docs/schedules). For reusable workflows such as handoffs, committees, advisors, and bounded loops, see [Orchestration skills](/docs/skills).
