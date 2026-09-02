---
title: Orchestration skills
description: "Paseo orchestration skills: teach coding agents to spawn, coordinate, and manage other agents using slash commands."
nav: Skills
order: 32
category: Orchestration
---

# Orchestration skills

Paseo ships skills that teach coding agents how to use Paseo tools and the CLI. They package orchestration and browser workflows so agents have the command surface and safety rails without adding every tool to every session.

Start with [Orchestration](/docs/orchestration) if you want the mental model, or [Common workflows](/docs/orchestration-workflows) for prompts you can use without installing skills.

## Installation

Two ways to install:

- **Paseo app:** Connect to the host, then open Settings → Host → Agents → Orchestration skills. The selected host installs the skills on its own machine.
- **Manual:** `npx skills add getpaseo/paseo`, this installs to `~/.agents/skills/` and sets up symlinks for each agent.

When a daemon finds installed Paseo skills, it keeps the selected bundled skills up to date on startup without removing deselected directories. Use the host's Orchestration skills card to install, update, choose, or uninstall skills. Removal always asks for confirmation.

## `/paseo`, Paseo Reference

The foundational skill. Paseo reference for managing projects, workspaces, and agents. Load it when an agent needs to register a project, create agents, send them prompts, or manage workspace isolation.

Not typically invoked directly by users, it's a reference that other skills depend on.

```
/paseo show me the Paseo CLI surface for creating an agent in a worktree-isolated workspace
```

## `/paseo-handoff`, Task Handoff

Hands off the current task to another agent with full context. Use it when you say "handoff", "hand off", "hand this to", or want to pass work to another agent.

The receiving agent gets a self-contained briefing with the task, context, relevant files, current state, what's been tried, decisions, acceptance criteria, and constraints. Provider comes from orchestration preferences unless you name one. Supports worktree-isolated workspaces when you ask for one.

```
/paseo-handoff hand off the auth fix to codex in a worktree-isolated workspace
/paseo-handoff hand this to claude opus for review
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

## `/paseo-browser`, Browser Automation

Drives real Paseo browser tabs through the `paseo browser` CLI. Use it when an agent needs to inspect a page, interact with elements, upload files, capture screenshots, or read browser logs without loading the browser MCP tool catalog into the session.

The skill teaches workspace scoping, the snapshot-and-ref interaction loop, stale-ref recovery, structured output, and the full browser command surface.

```
/paseo-browser open example.com, capture a snapshot, and report the page title
/paseo-browser fill the sign-up form and save a screenshot before submitting
```
