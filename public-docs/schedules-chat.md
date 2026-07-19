---
title: Schedules from chat
description: Ask an agent in chat to set up and manage a schedule for you.
nav: Chat
order: 26
category: Schedules
---

# Schedules from chat

You don't have to fill in a form. In any agent chat, just ask, and the agent sets up the schedule for you through [Paseo MCP](/docs/mcp).

Example prompts:

- "Every weekday at 9am, triage new GitHub issues and PRs and summarize what needs attention."
- "Check the release build every 5 minutes until it passes, and fix the cause if it fails."
- "Keep working on this refactor — wake yourself every 20 minutes and continue where you left off."

The agent picks the cron cadence, agent settings, and prompt from what you asked, creates the schedule, and reports back. You can manage a new-agent schedule the same way — "pause the triage schedule", "make the build check run every 2 minutes instead", "run it once now", or "delete it" — or from the [Schedules view](/docs/schedules) and the [CLI](/docs/schedules-cli).

An agent scheduling itself to wake up later is a **heartbeat**. Over MCP, an agent can create or delete its heartbeat; changing one means deleting it and creating a replacement. This small surface prevents a heartbeat from silently becoming a different job or agent. See [Paseo MCP](/docs/mcp) for the underlying tools.
