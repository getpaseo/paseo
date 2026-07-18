---
title: MCP reference
description: Reference for the Paseo tools agents use to manage agents, workspaces, terminals, and schedules.
nav: MCP reference
order: 33
category: Orchestration
---

# MCP reference

This is the complete catalog behind the workflows in [Orchestration](/docs/orchestration) and [Common workflows](/docs/orchestration-workflows). You normally ask for an outcome in natural language and let the agent choose the tools.

Paseo can inject these tools into every new agent it launches. Open **Settings → your host → Agents** and turn on **Enable Paseo tools**, or set `daemon.mcp.injectIntoAgents` to `true`.

Depending on the provider, Paseo delivers the catalog through its native tool interface or MCP. The capabilities are the same either way.

The MCP server itself is controlled by `daemon.mcp.enabled`. Existing agents may need a reload.

## Mental model

Workspaces decide where work happens; agent parentage decides who owns the work.

- An agent that calls `create_agent` without a `workspaceId` gets a subagent in its own workspace.
- Passing a `workspaceId` places that subagent in another workspace without detaching it from its parent.
- A top-level MCP caller without a workspace gets a new local workspace.
- Create a workspace first when you need worktree isolation, a specific branch, or a pull request checkout.

MCP does not expose an agent-detach tool. Detaching is a manual user action in the app or CLI.

## Tools

### Agents

| Tool                 | Function                                                                                |
| -------------------- | --------------------------------------------------------------------------------------- |
| `create_agent`       | Create an agent, optionally placing it in an existing workspace with `workspaceId`.     |
| `send_agent_prompt`  | Send a task to a running agent.                                                         |
| `get_agent_status`   | Return the latest snapshot for an agent.                                                |
| `list_agents`        | List recent agents as compact metadata.                                                 |
| `cancel_agent`       | Abort an agent's current run but keep the agent alive.                                  |
| `archive_agent`      | Soft-delete an agent and remove it from the active list.                                |
| `kill_agent`         | Terminate an agent session permanently.                                                 |
| `update_agent`       | Update an agent name, labels, or runtime settings such as mode/model/thinking/features. |
| `get_agent_activity` | Return recent agent timeline entries as a curated summary.                              |
| `set_agent_mode`     | Switch an agent's session mode.                                                         |

### Workspaces

| Tool                | Function                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `create_workspace`  | Create a local or worktree-isolated workspace. Worktrees can branch off, check out a branch, or a PR. |
| `list_workspaces`   | List active workspaces and their directories and isolation.                                           |
| `rename_workspace`  | Change the user-visible name of the current or specified workspace.                                   |
| `archive_workspace` | Archive a workspace and the sessions it owns.                                                         |

For worktree isolation, `create_workspace` accepts the same useful choices as the app: branch off from a base, check out an existing branch, or check out a pull request. The worktree remains an implementation detail of the workspace lifecycle.

### Terminals

| Tool                 | Function                                                                     |
| -------------------- | ---------------------------------------------------------------------------- |
| `list_terminals`     | List terminal sessions for one working directory or all working directories. |
| `create_terminal`    | Create a terminal session for a working directory.                           |
| `kill_terminal`      | Kill a terminal session.                                                     |
| `capture_terminal`   | Capture plain-text output from a terminal session.                           |
| `send_terminal_keys` | Send text or special key tokens to a terminal session.                       |

### Schedules and heartbeats

Both use the same cron engine, but they have deliberately different interfaces.

| Tool                | Function                                                                     |
| ------------------- | ---------------------------------------------------------------------------- |
| `create_schedule`   | Create a cron schedule that starts a new agent for each run.                 |
| `list_schedules`    | List new-agent schedules managed by the daemon.                              |
| `inspect_schedule`  | Inspect a schedule and its run history.                                      |
| `pause_schedule`    | Pause an active schedule.                                                    |
| `resume_schedule`   | Resume a paused schedule.                                                    |
| `update_schedule`   | Change a schedule's cron, prompt, agent settings, limits, or other settings. |
| `schedule_logs`     | Return recent runs and output for a schedule.                                |
| `run_schedule_once` | Start one new-agent schedule run without changing its cron.                  |
| `delete_schedule`   | Delete a new-agent schedule permanently.                                     |
| `create_heartbeat`  | Send a recurring cron-backed prompt into the current agent.                  |
| `delete_heartbeat`  | Delete one of the current agent's heartbeats.                                |

MCP heartbeats are ephemeral: create or delete them. To change one, delete it and create a replacement. Pause, resume, update, inspect, logs, and run-once apply to new-agent schedules only.

### Providers

| Tool               | Function                                                          |
| ------------------ | ----------------------------------------------------------------- |
| `list_providers`   | List configured agent providers, availability, and modes.         |
| `list_models`      | List models for an agent provider.                                |
| `inspect_provider` | Inspect compact provider capabilities and draft feature settings. |

### Permissions

| Tool                       | Function                                          |
| -------------------------- | ------------------------------------------------- |
| `list_pending_permissions` | Return pending permission requests across agents. |
| `respond_to_permission`    | Approve or deny a pending permission request.     |

### Browser

Browser automation is opt-in and adds tools for opening tabs, reading pages, clicking, typing, and taking screenshots. See the [Browser tools reference](/docs/browser-tools).

### Voice

| Tool    | Function                                                                                  |
| ------- | ----------------------------------------------------------------------------------------- |
| `speak` | Speak text through daemon-managed voice output. Available only in voice-enabled sessions. |
