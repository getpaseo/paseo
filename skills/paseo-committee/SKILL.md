---
name: hubcode-committee
description: Form a committee of two high-reasoning agents to step back, do root cause analysis, and produce a plan. Use when stuck, looping, tunnel-visioning, or facing a hard planning problem.
user-invocable: true
---

# Committee Skill

You are forming a committee to step back from the current problem and get fresh perspective.

**User's additional context:** $ARGUMENTS

---

## Prerequisites

Load the **Hubcode skill** first — it contains the CLI reference for all agent commands and waiting guidelines.

## What Is a Committee

Two agents — **Opus 4.6** (`--thinking on`) and **GPT 5.4** (`--thinking medium`) — launched in parallel to plan a solution. Fresh context, no implementation baggage, proper root cause analysis.

They stay alive after planning for Phase 3 review — they hold only the plan, so they catch implementation drift.

**The purpose is to step back, not to double down.** The committee may propose a completely different approach.

## Your Role

You drive the full lifecycle: plan → implement → review. You are a middleman between the user and the committee. Do not yield back to the user until the cycle is complete. If the user needs to weigh in on a divergence, ask them — but don't stop the process.

## No Anxiety

**Once you call `hubcode wait`, trust the wait.** Do not poll logs, read output early, send hurry-up messages, interrupt deep analysis, or give up because it's taking long.

GPT 5.4 can reason for 15–30 minutes. Opus does extended thinking. Long waits mean the agent found something worth thinking about. Let it finish.

If the CLI has a bug, the user will tell you.

## No-Edits Suffix

Every prompt to a committee member — initial, follow-up, or review — **must** end with this suffix. They will start editing code if you don't.

```
NO_EDITS="This is analysis only. Do NOT edit, create, or delete any files. Do NOT write code."
```

All example prompts below include `$NO_EDITS` — always expand it.

## Phase 1: Get a Plan

### Write the prompt

Describe the **overall problem**, not just the immediate symptom:

- High-level goal and acceptance criteria
- Constraints
- Symptoms (if a bug)
- What you've tried and why it failed
- Explicitly ask for root cause analysis

```bash
prompt="We're trying to [high-level goal]. Constraints: [X, Y, Z]. Acceptance criteria: [A, B, C].

We've been stuck on this. Here's what we've tried and why it didn't work:
- [approach 1] — failed because [reason]
- [approach 2] — partially worked but [issue]

Step back from these attempts. Do root cause analysis — the fix might not be for [immediate symptom] at all, it might be structural.

Use the think-harder approach: state your assumptions, ask why at least 3 levels deep for each, and check whether you're patching a symptom or removing the problem. What's the right approach?

$NO_EDITS"
```

### Launch both members

Same prompt to both, `[Committee]` prefix for identification:

```bash
opus_id=$(hubcode run -d --mode bypassPermissions --provider claude/opus --thinking on --name "[Committee] Task description" "$prompt" -q)
gpt_id=$(hubcode run -d --mode full-access --provider codex/gpt-5.4 --thinking medium --name "[Committee] Task description" "$prompt" -q)
```

### Wait for both

Wait for **both** agents — not just the first one that finishes.

```bash
hubcode wait "$opus_id"
hubcode wait "$gpt_id"
```

### Read and challenge

```bash
hubcode logs "$opus_id"
hubcode logs "$gpt_id"
```

**Do not accept output at face value.** Use the **think-harder** framework to challenge their output. Before synthesizing:

1. **Ask "why" 2–3 levels deep.** "Fix X because Y is broken" — why is Y broken? Is Y a root cause or a consequence?
2. **Challenge assumptions.** If the plan assumes something about the code, make the agent verify it.
3. **Symptom vs cause.** "Are we fixing the consequence or the cause?"
4. **Probe alternatives.** "What did you consider and reject?"

```bash
hubcode send "$opus_id" "You said [X]. Why does [underlying thing] happen in the first place? Are we patching a symptom? $NO_EDITS"
hubcode wait "$opus_id"
hubcode logs "$opus_id"
```

Keep pushing until the plan addresses the root cause.

### Synthesize and confirm

- Convergence → merge into unified plan.
- Significant divergence → involve the user.

Send the merged plan back for confirmation. Multi-turn if needed — keep going until consensus.

```bash
hubcode send "$opus_id" "Merged plan: [plan]. Concerns? $NO_EDITS"
hubcode send "$gpt_id" "Merged plan: [plan]. Concerns? $NO_EDITS"
```

## Phase 2: Implement

Implement the plan yourself — unless the user said **"delegate"**, in which case launch an implementer:

```bash
impl_id=$(hubcode run -d --mode full-access --provider codex/gpt-5.4 --name "[Impl] Task description" "Implement the following plan end-to-end. [plan]" -q)
hubcode wait "$impl_id"
```

Committee agents stay clean — not involved in implementation.

## Phase 3: Review

Send the committee the changes for review. They anchor against the plan and catch drift.

```bash
review_prompt="Implementation is done. Review changes against the plan. Flag drift or missing pieces. $NO_EDITS"

hubcode send "$opus_id" "$review_prompt"
hubcode send "$gpt_id" "$review_prompt"

hubcode wait "$opus_id"
hubcode wait "$gpt_id"

hubcode logs "$opus_id"
hubcode logs "$gpt_id"
```

### Iterate

Send committee feedback to the implementer (or apply yourself). Repeat Phase 2 → 3 until the committee confirms the implementation matches the plan.

After ~10 iterations without convergence, start a fresh committee with full context of what was tried — the current committee's context may have drifted too far.
