---
name: paseo
description: Paseo CLI reference for managing agents. Load this skill whenever you need to use paseo commands.
---

## Agent Commands

```bash
# List agents (directory-scoped by default)
paseo ls                 # Only shows agents for current directory
paseo ls -g              # All agents across all projects (global)
paseo ls --json          # JSON output for parsing

# Create and run an agent (blocks until completion by default, no timeout)
paseo run --mode bypassPermissions "<prompt>"
paseo run --mode bypassPermissions --name "task-name" "<prompt>"
paseo run --mode bypassPermissions --provider claude/opus "<prompt>"
paseo run --mode full-access --provider codex/gpt-5.4 "<prompt>"

# Wait timeout - limit how long run blocks (default: no limit)
paseo run --wait-timeout 30m "<prompt>"   # Wait up to 30 minutes
paseo run --wait-timeout 1h "<prompt>"    # Wait up to 1 hour

# Detached mode - runs in background, returns agent ID immediately
paseo run --detach "<prompt>"
paseo run -d "<prompt>"  # Short form

# Structured output - agent returns only matching JSON
paseo run --output-schema '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}' "<prompt>"
# NOTE: --output-schema blocks until completion (cannot be used with --detach)

# Worktrees - isolated git worktree for parallel feature development
paseo run --worktree feature-x "<prompt>"

# Check agent logs/output
paseo logs <agent-id>
paseo logs <agent-id> -f               # Follow (stream)
paseo logs <agent-id> --tail 10        # Last 10 entries
paseo logs <agent-id> --filter tools   # Only tool calls

# Wait for agent to complete or need permission
paseo wait <agent-id>
paseo wait <agent-id> --timeout 60     # 60 second timeout

# Send follow-up prompt to running agent
paseo send <agent-id> "<prompt>"
paseo send <agent-id> --image screenshot.png "<prompt>"  # With image
paseo send <agent-id> --no-wait "<prompt>"               # Queue without waiting

# Inspect agent details
paseo inspect <agent-id>

# Interrupt an agent's current run
paseo stop <agent-id>

# Archive an agent (soft-delete, removes from UI)
paseo archive <agent-id>
paseo archive <agent-id> --force  # Force archive running agent (interrupts first)

# Hard-delete an agent (interrupts first if needed)
paseo delete <agent-id>

# Attach to agent output stream (Ctrl+C to detach without stopping)
paseo attach <agent-id>

# Permissions management
paseo permit ls                # List pending permission requests
paseo permit allow <agent-id>  # Allow all pending for agent
paseo permit deny <agent-id> --all  # Deny all pending

# Output formats
paseo ls --json          # JSON output
paseo ls -q              # IDs only (quiet mode, useful for scripting)
```

## Loop Commands

Iterative worker loops: launch a worker agent, verify its output, repeat until done.

```bash
# Start a loop
paseo loop run "<worker prompt>" [options]
  --verify "<verifier prompt>"      # Verifier agent prompt
  --verify-check "<command>"        # Shell command that must exit 0 (repeatable)
  --name <name>                     # Optional loop name
  --sleep <duration>                # Delay between iterations (30s, 5m)
  --max-iterations <n>              # Maximum number of iterations
  --max-time <duration>             # Maximum total runtime (1h, 30m)
  --provider <provider/model>        # Worker agent provider/model (e.g. codex/gpt-5.4)
  --verify-provider <provider/model> # Verifier agent provider/model (e.g. claude/opus)
  --archive                         # Archive agents after each iteration

# Manage loops
paseo loop ls                       # List all loops
paseo loop inspect <id>             # Show loop details and iterations
paseo loop logs <id>                # Stream loop logs
paseo loop stop <id>                # Stop a running loop
```

## Schedule Commands

Recurring time-based execution: run a prompt on a cron or interval schedule.

```bash
# Create a schedule
paseo schedule create "<prompt>" [options]
  --every <duration>                # Fixed interval (5m, 1h)
  --cron <expr>                     # Cron expression
  --name <name>                     # Optional schedule name
  --target <self|new-agent|id>      # Run target
  --max-runs <n>                    # Maximum number of runs
  --expires-in <duration>           # Time to live for schedule

# Manage schedules
paseo schedule ls                   # List schedules
paseo schedule inspect <id>         # Inspect a schedule
paseo schedule logs <id>            # Show recent run logs
paseo schedule pause <id>           # Pause a schedule
paseo schedule resume <id>          # Resume a paused schedule
paseo schedule delete <id>          # Delete a schedule
```

## Chat Commands

Asynchronous agent coordination through persistent chat rooms.

```bash
# Create a chat room
paseo chat create <name> --purpose "<description>"

# List and inspect rooms
paseo chat ls
paseo chat inspect <name-or-id>

# Post a message
paseo chat post <room> "<message>"
paseo chat post <room> "<message>" --reply-to <msg-id>
paseo chat post <room> "@<agent-id> <message>"
paseo chat post <room> "@everyone <message>"

# Read messages
paseo chat read <room>
paseo chat read <room> --limit <n>
paseo chat read <room> --since <duration-or-timestamp>
paseo chat read <room> --agent <agent-id>

# Wait for new messages
paseo chat wait <room>
paseo chat wait <room> --timeout <duration>

# Delete a room
paseo chat delete <name-or-id>
```

## Terminal Commands

Manage workspace terminals: create, inspect, send keystrokes, capture output.

```bash
# List terminals (scoped to current directory by default)
paseo terminal ls                    # Terminals in current directory
paseo terminal ls --all              # All terminals across all workspaces
paseo terminal ls --cwd ~/dev/myapp  # Terminals in a specific directory

# Create a terminal
paseo terminal create                          # In current directory
paseo terminal create --cwd ~/dev/myapp        # In a specific directory
paseo terminal create --name "build-runner"    # With a custom name

# Kill a terminal (supports short ID prefixes and name matching)
paseo terminal kill <terminal-id>
paseo terminal kill abc123           # Short prefix
paseo terminal kill build-runner     # By name

# Capture terminal output as plain text (like tmux capture-pane -p)
paseo terminal capture <terminal-id>               # Visible pane only, ANSI stripped
paseo terminal capture <terminal-id> --scrollback   # Full scrollback + visible
paseo terminal capture <terminal-id> -S             # Short form of --scrollback
paseo terminal capture <terminal-id> --start 0 --end 10   # Line range (tmux-style)
paseo terminal capture <terminal-id> --start -5     # Last 5 lines
paseo terminal capture <terminal-id> --ansi         # Preserve ANSI escape codes
paseo terminal capture <terminal-id> --json         # JSON output with metadata

# Send keystrokes (like tmux send-keys)
paseo terminal send-keys <terminal-id> "ls -la" Enter
paseo terminal send-keys <terminal-id> "echo hello" Enter
paseo terminal send-keys <terminal-id> C-c          # Ctrl+C
paseo terminal send-keys <terminal-id> C-d          # Ctrl+D
paseo terminal send-keys <terminal-id> --literal "raw text"  # No special token interpretation
```

**Special key tokens** (interpreted by default, use `--literal` to send raw):
`Enter`, `Tab`, `Escape`, `Space`, `BSpace`, `C-c`, `C-d`, `C-z`, `C-l`, `C-a`, `C-e`

**Common pattern — launch a process and interact with it:**
```bash
id=$(paseo terminal create --name "my-shell" -q)
paseo terminal send-keys "$id" "claude" Enter
sleep 5
paseo terminal capture "$id" --scrollback   # See what happened
paseo terminal send-keys "$id" "Hello!" Enter
sleep 10
paseo terminal capture "$id" --scrollback   # See the response
paseo terminal send-keys "$id" "/exit" Enter
paseo terminal kill "$id"
```

## Available Models

**Claude (default provider):**
- `--provider claude/haiku` — Fast/cheap, ONLY for tests (not for real work)
- `--provider claude/sonnet` — Good for most tasks
- `--provider claude/opus` — For harder reasoning, complex debugging

**Codex:**
- `--provider codex/gpt-5.4` — Latest frontier agentic coding model (preferred for all engineering tasks)
- `--provider codex/gpt-5.4-mini` — Cheaper, faster, but less capable

## Permissions

Always launch agents fully permissioned. Use `--mode bypassPermissions` for Claude and `--mode full-access` for Codex. Always specify the model: `--provider claude/opus`, `--provider codex/gpt-5.4`, etc. Control behavior through **strict prompting**, not permission modes.

## Waiting for Agents

Both `paseo run` and `paseo wait` block until the agent completes. Trust them.

- `paseo run` waits **forever** by default (no timeout). Use `--wait-timeout` to set a limit.
- `paseo wait` also waits forever by default. Use `--timeout` to set a limit.
- Agent tasks can legitimately take 10, 20, or even 30+ minutes. This is normal.
- When a wait times out, **just re-run `paseo wait <id>`** — don't panic, don't start checking logs.
- Do NOT poll with `paseo ls`, `paseo inspect`, or `paseo logs` in a loop to "check on" the agent.
- **Never launch a duplicate agent** because a wait timed out. The original is still running.

## Composing Agents in Bash

`paseo run` blocks by default and `--output-schema` returns structured JSON, making it easy to compose agents in bash loops and pipelines.

**Detach + wait pattern for parallel work:**
```bash
api_id=$(paseo run -d --name "impl-api" "implement the API" -q)
ui_id=$(paseo run -d --name "impl-ui" "implement the UI" -q)

paseo wait "$api_id"
paseo wait "$ui_id"
```
