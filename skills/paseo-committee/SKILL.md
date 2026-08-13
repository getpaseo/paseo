---
name: paseo-committee
description: Form a committee of two high-reasoning agents to step back, do root cause analysis, and produce a plan. Use when stuck, looping, tunnel-visioning, or facing a hard planning problem.
user-invocable: true
---

# Committee Skill

Two agents from contrasting profiles, fresh context, planning a solution in parallel.

**User's additional context:** $ARGUMENTS

## Prerequisites

Read the **paseo** skill. Call `list_profiles` before choosing committee members. Do not create committee agents until you have read the configured profiles and their `notes`.

Contrast is the point of a committee, so pick profiles from different provider families when possible. Materialize each profile into `create_agent`.

## Composition

Two members with different reasoning styles, selected from configured Agent profiles:

- one whose notes fit planning, research, or root-cause analysis
- one contrasting high-reasoning profile from another provider family

If the user names profiles, use those. If fewer than two suitable profiles are configured, use Paseo's provider discovery fallback for the missing member and tell the user. Override the selection only when the user explicitly asks for different members.

## Hard rules

- **No edits.** Every prompt to a committee member ends with the no-edits suffix:

  ```
  This is analysis only. Do NOT edit, create, or delete any files. Do NOT write code.
  ```

- **Trust the finish notification.** Do not poll, send hurry-ups, or interrupt. Models can reason for 15–30 minutes. You can go idle and Paseo will notify you.

## Workflow

1. Write a problem-level prompt
2. Create both agents in parallel via Paseo with `[Committee] <task>` titles and the same prompt
3. Wait for both responses
4. Resolve disagreements by passing their arguments between each other
5. Keep going until they converge into a response

Share the consensus with the user. Summarize where the agents diverged and how they resolved it.
