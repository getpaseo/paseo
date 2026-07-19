---
title: CLI
description: "Paseo CLI reference: manage agents, workspaces, schedules, daemons, and permissions from your terminal."
nav: CLI
order: 3
category: Getting started
---

# CLI

The Paseo CLI lets you manage agents from your terminal. It's the same interface exposed by the daemon's API, so anything you can do in the app you can do from the command line.

> **Agent orchestration:** You can tell coding agents to use the Paseo CLI to spawn and manage other agents. Paseo recognizes the calling agent, so CLI-created workers get the same workspace and parent defaults as MCP-created workers.

## Quick reference

```bash
paseo run "fix the tests"            # Start an agent
paseo ls                             # List running agents
paseo attach <id>                    # Stream agent output
paseo send <id> "also fix linting"   # Send follow-up task
paseo logs <id>                      # View agent timeline
paseo stop <id>                      # Stop an agent
```

## Running agents

Use `paseo run` to start a new agent with a task:

```bash
paseo run "implement user authentication"
paseo run --provider codex "refactor the API layer"
paseo run --background "run the focused test suite"
paseo run --isolation worktree --base main "implement feature X"
paseo run --workspace <workspace-id> "review the current diff"
paseo run --output-schema schema.json "extract release notes"
paseo run --output-schema '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}' "summarize release notes"
```

From a human shell, a bare `paseo run` creates a new local workspace for the current directory. Use `--workspace <id>` to add the agent to an existing workspace, or `--isolation worktree` to create a new workspace backed by an isolated git worktree.

When an existing Paseo agent runs the same command, Paseo recognizes it through `PASEO_AGENT_ID`. Without explicit placement, the new agent becomes its subagent in the same workspace. `--workspace` can place that subagent elsewhere without changing its parent.

Use `--output-schema` to return only matching JSON output. You can pass a schema file path or an inline JSON schema object. This mode cannot be used with `--background`.

By default, `paseo run` waits for completion. Use `--background` to return immediately while the agent keeps running.

## Workspaces

Create a workspace independently when you want to prepare its files before starting an agent:

```bash
paseo workspace create --isolation local --path ~/dev/my-app --title main

paseo workspace create \
  --isolation worktree \
  --path ~/dev/my-app \
  --mode branch-off \
  --new-branch feature/auth \
  --worktree-slug feature-auth \
  --base main

paseo workspace create \
  --isolation worktree \
  --path ~/dev/my-app \
  --mode checkout-branch \
  --branch feature/existing \
  --worktree-slug existing-copy

paseo workspace create \
  --isolation worktree \
  --path ~/dev/my-app \
  --mode checkout-pr \
  --pr-number 2186
```

Then list, use, or archive it:

```bash
paseo workspace ls
paseo run --workspace <workspace-id> "implement authentication"
paseo workspace archive <workspace-id>
```

Add `--forge <name>` to PR checkout when Paseo cannot infer the forge from the source checkout. See [Git worktrees](/docs/worktrees) for setup hooks and services.

## Listing agents

```bash
paseo ls                    # Running agents in current directory
paseo ls -a                 # Include completed/stopped agents
paseo ls -g                 # All directories
paseo ls -a -g --json       # Full list as JSON
```

## Streaming output

Use `paseo attach` to stream an agent's output in real-time:

```bash
paseo attach abc123   # Attach to agent (Ctrl+C to detach)
```

Agent IDs can be shortened, `abc` works if it's unambiguous.

## Sending messages

Send follow-up tasks to a running or idle agent:

```bash
paseo send <id> "now run the tests"
paseo send <id> --image screenshot.png "what's wrong here?"
paseo send <id> --no-wait "queue this task"
```

## Viewing logs

```bash
paseo logs <id>                  # Full timeline
paseo logs <id> -f               # Follow (streaming)
paseo logs <id> --tail 10        # Last 10 entries
paseo logs <id> --filter tools   # Only tool calls
```

## Waiting for agents

Block until an agent finishes its current task:

```bash
paseo wait <id>
paseo wait <id> --timeout 60   # 60 second timeout
```

Useful in scripts or when one agent needs to wait for another.

## Schedules

Run an agent on a cron schedule. The CLI also accepts simple cadence presets and compiles them to cron. See [Schedules from the CLI](/docs/schedules-cli) for the full reference.

```bash
paseo schedule create --every 30m --cwd ~/dev/my-app "Continue the refactor and leave a note."
paseo schedule ls
paseo schedule pause <id>
```

## Permissions

Agents may request permission for certain actions. Manage these from the CLI:

```bash
paseo permit ls                # List pending requests
paseo permit allow <id>        # Allow all pending for agent
paseo permit deny <id> --all   # Deny all pending
```

## Agent modes

Change an agent's operational mode (provider-specific):

```bash
paseo agent mode <id> --list   # Show available modes
paseo agent mode <id> bypass   # Set bypass mode
paseo agent mode <id> plan     # Set plan mode
paseo agent detach <id>        # Make a subagent top-level
```

Detaching is an explicit lifecycle action, not a creation flag. The agent keeps running; only its relationship to its parent changes.

## Daemon management

```bash
paseo daemon start             # Start the daemon
paseo daemon start --web-ui    # Start and serve the bundled web UI
paseo daemon status            # Check status
paseo daemon stop              # Stop the daemon
```

Use `PASEO_HOME` to run multiple isolated daemon instances.

## Connecting to a remote daemon

`--host` accepts either a local target (`host:port`, a unix socket, or a Windows pipe) or a pairing offer URL, the same `https://app.paseo.sh/#offer=...` link the mobile app uses for QR pairing. With an offer URL the CLI connects through the Paseo relay with end-to-end encryption, so you can drive a daemon on another machine without exposing it to the network.

Get an offer URL from the daemon you want to control:

```bash
paseo daemon pair --json   # prints { url, qr, ... }
```

Use it from anywhere:

```bash
paseo ls --host 'https://app.paseo.sh/#offer=eyJ2IjoyLC...'
paseo run --host "$OFFER_URL" "fix the failing tests"
```

You can also set it once via `PASEO_HOST` instead of passing `--host` on every command.

## Multi-agent workflows

The CLI is designed to be used by agents themselves. You can instruct an agent to spawn sub-agents for parallel work:

```bash
# Agent A spawns Agent B and waits for it
agent_id=$(paseo run --background --quiet --title api-agent "implement the API")
paseo wait "$agent_id"
paseo logs "$agent_id" --tail 5
```

Because Agent A's ID is present in the environment, Agent B is created as its subagent in the same workspace unless `--workspace` is specified.

Simple implement + verify loop:

```bash
# Requires jq
while true; do
  paseo run --provider codex "make the tests pass" >/dev/null

  verdict=$(paseo run --provider claude --output-schema '{"type":"object","properties":{"criteria_met":{"type":"boolean"}},"required":["criteria_met"],"additionalProperties":false}' "ensure tests all pass")
  if echo "$verdict" | jq -e '.criteria_met == true' >/dev/null; then
    echo "criteria met"
    break
  fi
done
```

This pattern enables hierarchical task decomposition, a lead agent can break down work, delegate to specialists, and synthesize results.

## Output formats

Most commands support multiple output formats for scripting:

```bash
paseo ls --json                # JSON output
paseo ls --format yaml         # YAML output
paseo ls -q                    # IDs only (quiet)
```

## Global options

- `--host <target>`, connect to a different daemon (`host:port`, unix socket, or `https://app.paseo.sh/#offer=...` for relay). See [Connecting to a remote daemon](#connecting-to-a-remote-daemon).
- `--json`, JSON output
- `-q, --quiet`, minimal output
- `--no-color`, disable colors
