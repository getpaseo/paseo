---
title: Orchestration skills
description: "Paseo orchestration skills: teach coding agents to spawn, coordinate, and manage other agents using slash commands."
nav: Skills
order: 8
---

# Orchestration skills

Paseo ships orchestration skills that teach coding agents (Claude Code, Codex) how to use the Paseo CLI to spawn, coordinate, and manage other agents. Skills are slash commands your agent can invoke, they provide the prompts, context, and workflows so agents know how to orchestrate without you writing boilerplate. Install them from the desktop app's Integrations settings or via the CLI.

## Installation

Two ways to install:

- **Desktop app:** Settings → Integrations → Install
- **Manual:** `npx skills add getpaseo/paseo`, this installs to `~/.agents/skills/` and sets up symlinks for each agent.

## `/paseo`, Paseo Reference

The foundational skill. Paseo reference for managing agents and worktrees. Load it when an agent needs to create agents, send them prompts, or manage worktrees.

Not typically invoked directly by users, it's a reference that other skills depend on.

```
/paseo show me the Paseo CLI surface for creating an agent in a worktree
```

## `/paseo-handoff`, Task Handoff

Hands off the current task to another agent with full context. Use it when you say "handoff", "hand off", "hand this to", or want to pass work to another agent.

The receiving agent gets a self-contained briefing with the task, context, relevant files, current state, what's been tried, decisions, acceptance criteria, and constraints. Provider comes from orchestration preferences unless you name one. Supports worktrees when you ask for one.

```
/paseo-handoff hand off the auth fix to codex in a worktree
/paseo-handoff hand this to claude opus for review
```

## `/paseo-loop`, Iterative Loops

Runs an agent loop until an exit condition is met. Use it when you say "loop", "babysit", "keep trying until", "check every X", "watch", or want iterative autonomous execution.

A loop is a worker/verifier cycle: launch a worker, check verification, repeat until done or limits hit. It can use a shell check, a verifier prompt, or both. Set a sensible `--max-iterations` or `--max-time`.

```
/paseo-loop keep trying until the changed test file passes, max 5 iterations
/paseo-loop babysit PR 123 until checks are green, check every 2m, max-time 1h
```

## `/paseo-committee`, Committee Planning

Forms a committee of two high-reasoning agents to step back, do root cause analysis, and produce a plan. Use it when stuck, looping, tunnel-visioning, or facing a hard planning problem.

Committee members do analysis only. They do not edit, create, or delete files. The orchestrating agent synthesizes their plans, implements, then sends the diff back for review.

```
/paseo-committee why are the websocket connections dropping under load?
/paseo-committee plan the auth system migration
```

## `/paseo-advisor`, Advisor

Spins up a single agent as an advisor, a second opinion on the current task. Use it when you say "advisor", "second opinion", "what does X think", or want an outside take without delegating the work itself.

The advisor gives a judgment. You decide what to do. The advisor prompt is analysis-only and ends with a no-edits instruction.

```
/paseo-advisor did I miss anything in this migration plan?
/paseo-advisor --provider claude/opus what is the UX risk in this flow?
```

## `/paseo-epic`, Epic Orchestration

Heavy-ceremony orchestration for big work: research, planning, adversarial review, phased implementation, audit, and delivery. Use it when you say "epic", "long task", "build this end to end", or want a feature that runs all night.

The plan file at `~/.paseo/plans/<slug>.md` is the source of truth. Default mode is conversational, with clarification and gates between phases. `--autopilot` runs through delivery without grills or gates. `--worktree` isolates the work in a new Paseo worktree.

```
/paseo-epic build the settings import/export flow end to end
/paseo-epic --autopilot --worktree migrate the relay config UI overnight
```
