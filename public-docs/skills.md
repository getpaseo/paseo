---
title: Orchestration skills
description: "Paseo orchestration skills: teach coding agents to spawn, coordinate, and manage other agents using slash commands."
nav: Skills
order: 6
---

# Orchestration skills

Paseo ships orchestration skills that teach coding agents (Claude Code, Codex) how to use the Paseo CLI to spawn, coordinate, and manage other agents. Skills are slash commands your agent can invoke — they provide the prompts, context, and workflows so agents know how to orchestrate without you writing boilerplate. Install them from the desktop app's Integrations settings or via the CLI.

## Installation

Two ways to install:

- **Desktop app:** Settings → Integrations → Install
- **Manual:** `npx skills add getpaseo/paseo` — this installs to `~/.agents/skills/` and sets up symlinks for each agent.

## `/paseo` — CLI Reference

The foundational skill. Loaded automatically by other skills. Contains the full Paseo CLI command reference so agents know how to run commands.

Not typically invoked directly by users — it's a reference that other skills depend on.

## `/paseo-handoff` — Task Handoff

Hands off your current task to another agent with full context. The receiving agent gets a comprehensive prompt with: task description, relevant files, what's been tried, decisions made, and acceptance criteria.

Default provider is Codex. Can specify Claude (sonnet/opus). Supports `--worktree` for isolated git branches.

```
/paseo-handoff hand off the auth fix to codex in a worktree
/paseo-handoff hand this to claude opus for review
```

## `/paseo-loop` — Iterative Loops

Runs an agent in a loop with automatic verification until an exit condition is met. Worker runs, verifier checks, repeat until done or max iterations. Supports different providers for worker vs verifier (e.g., Codex implements, Claude verifies).

Stop conditions: `--max-iterations`, `--max-time`, or verification passes.

```
/paseo-loop fix the failing tests, verify with npm test, max 5 iterations
/paseo-loop use codex to implement, claude sonnet to verify, loop until tests pass
```

## `/paseo-orchestrator` — Team Orchestration

Builds and manages a team of agents coordinating through a shared chat room. You describe the work, it sets up roles, launches agents, and coordinates through chat. Uses a heartbeat schedule to check progress.

Cross-provider: typically Codex for implementation, Claude for review.

```
/paseo-orchestrator spin up a team to implement the database migration, codex implements, claude reviews
```

## `/paseo-chat` — Chat Rooms

Use persistent chat rooms for asynchronous agent coordination. Create rooms, post messages, read history, wait for replies. Supports @mentions for specific agents or @everyone.

Typically used by the orchestrator skill, but can be used directly.

```
/paseo-chat create a room called "backend-refactor" for coordinating the API changes
/paseo-chat post to backend-refactor: "API endpoints are done, ready for review"
```

## `/paseo-committee` — Committee Planning

Forms a committee of two high-reasoning agents (Claude Opus + GPT 5.4) to analyze a problem before implementing. Both agents reason in parallel, then plans are merged. Useful when stuck, looping, or facing a hard architectural decision.

Agents are prevented from editing code — they only produce a plan.

```
/paseo-committee why are the websocket connections dropping under load?
/paseo-committee plan the auth system migration
```
