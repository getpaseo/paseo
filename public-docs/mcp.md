---
title: Paseo MCP
description: Paseo MCP tools injected into agents.
nav: Paseo MCP
order: 9
---

# Paseo MCP

Paseo can inject these MCP tools into every new agent it launches. Turn on **Inject Paseo tools** in host settings, or set `daemon.mcp.injectIntoAgents` to `true`.

The MCP server itself is controlled by `daemon.mcp.enabled`. Existing agents may need a reload.

## Tools

### Agents

| Tool                 | Function                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `create_agent`       | Create an agent tied to a working directory, optionally with initial settings or a new git worktree. |
| `wait_for_agent`     | Block until an agent requests permission or finishes its current run.                                |
| `send_agent_prompt`  | Send a task to a running agent.                                                                      |
| `get_agent_status`   | Return the latest snapshot for an agent.                                                             |
| `list_agents`        | List recent agents as compact metadata.                                                              |
| `cancel_agent`       | Abort an agent's current run but keep the agent alive.                                               |
| `archive_agent`      | Soft-delete an agent and remove it from the active list.                                             |
| `kill_agent`         | Terminate an agent session permanently.                                                              |
| `update_agent`       | Update an agent name, labels, or runtime settings such as mode/model/thinking/features.              |
| `get_agent_activity` | Return recent agent timeline entries as a curated summary.                                           |
| `set_agent_mode`     | Switch an agent's session mode.                                                                      |

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
| `list_schedules`   | List schedules managed by the daemon.                             |
| `inspect_schedule` | Inspect a schedule and its run history.                           |
| `pause_schedule`   | Pause an active schedule.                                         |
| `resume_schedule`  | Resume a paused schedule.                                         |
| `delete_schedule`  | Delete a schedule permanently.                                    |

### Providers

| Tool               | Function                                                          |
| ------------------ | ----------------------------------------------------------------- |
| `list_providers`   | List configured agent providers, availability, and modes.         |
| `list_models`      | List models for an agent provider.                                |
| `inspect_provider` | Inspect compact provider capabilities and draft feature settings. |

### Worktrees

| Tool               | Function                                                                      |
| ------------------ | ----------------------------------------------------------------------------- |
| `list_worktrees`   | List Paseo-managed git worktrees for a repository.                            |
| `create_worktree`  | Create a Paseo-managed git worktree from a branch, base branch, or GitHub PR. |
| `archive_worktree` | Delete a Paseo-managed git worktree.                                          |

### Permissions

| Tool                       | Function                                          |
| -------------------------- | ------------------------------------------------- |
| `list_pending_permissions` | Return pending permission requests across agents. |
| `respond_to_permission`    | Approve or deny a pending permission request.     |

### Voice

| Tool    | Function                                                                                  |
| ------- | ----------------------------------------------------------------------------------------- |
| `speak` | Speak text through daemon-managed voice output. Available only in voice-enabled sessions. |
