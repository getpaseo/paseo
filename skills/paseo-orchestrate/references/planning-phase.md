# Planning Phase

Deploy planners to create an implementation plan informed by research findings. The number of planners and plan-reviewers scales with complexity order (see triage.md).

## Refactor-First Thinking

Every planner prompt must emphasize this: the default agent instinct is to bolt new code on top of existing code. Resist this.

The right approach:

1. Study the existing code — understand why it's shaped the way it is
2. Design the target shape — what would the code look like if this feature had always existed?
3. Identify the refactoring gap — what needs to change so the new feature slots in cleanly?
4. Plan refactor phases before feature phases — lay the groundwork first

If the plan has a phase called "wire up" or "connect" or "integrate," a refactor phase could probably eliminate the need for it.

## Launching Planners

Use the Paseo **create agent** tool with `background: true` and `notifyOnFinish: true`:

```
title: "planner-<scope>"
agentType: <resolved from providers.planning>
model: <resolved from providers.planning>
background: true
notifyOnFinish: true
initialPrompt: "You are a planner.

Read the research findings provided below and the objective.

<paste synthesized research findings and objective>

Draft a phased implementation plan. Think refactor-first: before planning the feature, identify what existing code needs to be reshaped so the feature slots in naturally.

For each phase, specify:
- What changes and why
- Files involved
- Types and interfaces affected
- Tests to write (failing test first — TDD)
- Acceptance criteria for the phase

Write the plan to ~/.paseo/plans/<task-slug>.md"
```

## Launching Plan-Reviewers

```
title: "plan-reviewer-<scope>"
agentType: <resolved from providers.planning>
model: <resolved from providers.planning>
background: true
notifyOnFinish: true
initialPrompt: "You are a plan-reviewer.

Read the plan at ~/.paseo/plans/<task-slug>.md.

Challenge the plan:
- Is it bolting new code on top, or reshaping existing code first?
- Are there coordination/glue/bridge layers that a better refactor would eliminate?
- What edge cases are missing? What will break?
- What's over-engineered? What's under-specified?
- Is the phase ordering correct? Are there hidden dependencies?"
```

## Multiple Planners (Order 3+)

For cross-module tasks, deploy planners focusing on different slices:

- One for backend phases
- One for frontend phases
- One for test strategy

Then deploy a plan-reviewer to challenge the combined plan.

## Iteration

If the plan-reviewer finds significant issues, either:

1. Send follow-up instructions via the Paseo **send agent prompt** tool to the planner
2. Launch a new planner if the original is stale

Iterate until the plan-reviewer's only feedback is minor. Then synthesize the final plan.

## Plan Structure

The final plan must follow this structure:

```
# <Task Title>

## Objective
<one-paragraph summary>

## Acceptance Criteria
- [ ] <criterion 1>
- [ ] <criterion 2>

## Plan
### Phase 1: <name>
<description, files, types, tests, acceptance criteria>

### Phase 2: <name>
...
```

## Persisting the Plan

Save the final plan to disk:

```bash
mkdir -p ~/.paseo/plans
cat > ~/.paseo/plans/<task-slug>.md << 'PLAN'
<plan content>
PLAN
```

This file is the durable reference. Re-read it before every verification, review, or QA phase. It survives context compaction.

## Always Archive

Archive all planners and plan-reviewers once the final plan is settled.
