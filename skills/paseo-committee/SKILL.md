---
name: paseo-committee
description: Form a committee of two high-reasoning agents to step back, do root cause analysis, and produce a plan. Use when stuck, looping, tunnel-visioning, or facing a hard planning problem.
user-invocable: true
---

# Committee Skill

Two agents from contrasting profiles, fresh context, planning a solution in parallel. They stay alive for review after implementation.

The purpose is to step back, not double down. The committee may propose a completely different approach.

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

- **Trust the wait.** Do not poll, send hurry-ups, or interrupt. GPT-5.4 can reason 15–30 minutes; Opus does extended thinking. Long waits mean it found something worth thinking about.
- **You are the middleman.** Drive plan → implement → review without yielding to the user, except for divergences that need their call.

## Phase 1: Plan

Write a problem-level prompt:

- High-level goal and acceptance criteria
- Constraints
- Symptoms (if a bug)
- What you tried and why it failed
- Explicit: "do root cause analysis"
- Explicit: "state assumptions, ask why three levels deep, check whether you're patching a symptom or removing the problem"

Create both agents in parallel via Paseo with `[Committee] <task>` titles and the same prompt. Wait for both — not just whichever finishes first.

Read both responses. Challenge them — do not accept at face value:

- "Why does <underlying thing> happen? Symptom or cause?"
- Verify any assumption the plan makes about the code.
- "What did you consider and reject?"

Send follow-ups until the plan addresses root cause.

Synthesize:

- Convergence → unified plan.
- Significant divergence → involve the user.

Confirm the merged plan with both members. Multi-turn until consensus.

## Phase 2: Implement

Default: implement yourself. If the user said **"delegate"**, launch one impl agent and pass the merged plan.

The committee stays clean — not involved in implementation.

## Phase 3: Review

Send the diff to the committee:

> Implementation is done. Review changes against the plan. Flag drift or missing pieces. <no-edits suffix>

Apply feedback yourself, or send to the impl agent. Repeat 2 → 3 until consensus.

After ~10 iterations without convergence, start a fresh committee with the full history of what was tried — the current committee's context may have drifted too far.
