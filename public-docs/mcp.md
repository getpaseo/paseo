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

## Tools

### Agents

| Tool                 | Function                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `create_agent`       | Create an agent tied to a working directory, optionally with initial settings or a new git worktree. |
| `send_agent_prompt`  | Send a task to a running agent.                                                                      |
| `get_agent_status`   | Return the latest snapshot for an agent.                                                             |
| `list_agents`        | List recent agents as compact metadata.                                                              |
| `cancel_agent`       | Abort an agent's current run but keep the agent alive.                                               |
| `archive_agent`      | Soft-delete an agent and remove it from the active list.                                             |
| `kill_agent`         | Terminate an agent session permanently.                                                              |
| `update_agent`       | Update an agent name, labels, or runtime settings such as mode/model/thinking/features.              |
| `get_agent_activity` | Return recent agent timeline entries as a curated summary.                                           |
| `set_agent_mode`     | Switch an agent's session mode.                                                                      |

### Workspaces and worktrees

| Tool               | Function                                                                      |
| ------------------ | ----------------------------------------------------------------------------- |
| `rename_workspace` | Change the user-visible name of the current or specified workspace.           |
| `list_worktrees`   | List Paseo-managed git worktrees for a repository.                            |
| `create_worktree`  | Create a Paseo-managed git worktree from a branch, base branch, or GitHub PR. |
| `archive_worktree` | Delete a Paseo-managed git worktree.                                          |

### Terminals

| Tool                 | Function                                                                     |
| -------------------- | ---------------------------------------------------------------------------- |
| `list_terminals`     | List terminal sessions for one working directory or all working directories. |
| `create_terminal`    | Create a terminal session for a working directory.                           |
| `kill_terminal`      | Kill a terminal session.                                                     |
| `capture_terminal`   | Capture plain-text output from a terminal session.                           |
| `send_terminal_keys` | Send text or special key tokens to a terminal session.                       |

### Schedules

| Tool               | Function                                                          |
| ------------------ | ----------------------------------------------------------------- |
| `create_schedule`  | Create a recurring schedule that runs on an agent or a new agent. |
| `create_heartbeat` | Send a recurring prompt back into the current agent.              |
| `list_schedules`   | List schedules managed by the daemon.                             |
| `inspect_schedule` | Inspect a schedule and its run history.                           |
| `pause_schedule`   | Pause an active schedule.                                         |
| `resume_schedule`  | Resume a paused schedule.                                         |
| `update_schedule`  | Change the cadence, prompt, limits, or other schedule settings.   |
| `schedule_logs`    | Return recent runs and output for a schedule.                     |
| `delete_schedule`  | Delete a schedule permanently.                                    |

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
