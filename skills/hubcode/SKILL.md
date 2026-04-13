---
name: hubcode
description: Hubcode CLI reference for managing agents. Load this skill whenever you need to use hubcode commands.
---

## Agent Commands

```bash
# List agents (directory-scoped by default)
hubcode ls                 # Only shows agents for current directory
hubcode ls -g              # All agents across all projects (global)
hubcode ls --json          # JSON output for parsing

# Create and run an agent (blocks until completion by default, no timeout)
hubcode run --mode bypassPermissions "<prompt>"
hubcode run --mode bypassPermissions --name "task-name" "<prompt>"
hubcode run --mode bypassPermissions --provider claude/opus "<prompt>"
hubcode run --mode full-access --provider codex/gpt-5.4 "<prompt>"

# Wait timeout - limit how long run blocks (default: no limit)
hubcode run --wait-timeout 30m "<prompt>"   # Wait up to 30 minutes
hubcode run --wait-timeout 1h "<prompt>"    # Wait up to 1 hour

# Detached mode - runs in background, returns agent ID immediately
hubcode run --detach "<prompt>"
hubcode run -d "<prompt>"  # Short form

# Structured output - agent returns only matching JSON
hubcode run --output-schema '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}' "<prompt>"
# NOTE: --output-schema blocks until completion (cannot be used with --detach)

# Worktrees - isolated git worktree for parallel feature development
hubcode run --worktree feature-x "<prompt>"

# Check agent logs/output
hubcode logs <agent-id>
hubcode logs <agent-id> -f               # Follow (stream)
hubcode logs <agent-id> --tail 10        # Last 10 entries
hubcode logs <agent-id> --filter tools   # Only tool calls

# Wait for agent to complete or need permission
hubcode wait <agent-id>
hubcode wait <agent-id> --timeout 60     # 60 second timeout

# Send follow-up prompt to running agent
hubcode send <agent-id> "<prompt>"
hubcode send <agent-id> --image screenshot.png "<prompt>"  # With image
hubcode send <agent-id> --no-wait "<prompt>"               # Queue without waiting

# Inspect agent details
hubcode inspect <agent-id>

# Interrupt an agent's current run
hubcode stop <agent-id>

# Archive an agent (soft-delete, removes from UI)
hubcode archive <agent-id>
hubcode archive <agent-id> --force  # Force archive running agent (interrupts first)

# Hard-delete an agent (interrupts first if needed)
hubcode delete <agent-id>

# Attach to agent output stream (Ctrl+C to detach without stopping)
hubcode attach <agent-id>

# Permissions management
hubcode permit ls                # List pending permission requests
hubcode permit allow <agent-id>  # Allow all pending for agent
hubcode permit deny <agent-id> --all  # Deny all pending

# Output formats
hubcode ls --json          # JSON output
hubcode ls -q              # IDs only (quiet mode, useful for scripting)
```

## Loop Commands

Iterative worker loops: launch a worker agent, verify its output, repeat until done.

```bash
# Start a loop
hubcode loop run "<worker prompt>" [options]
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
hubcode loop ls                       # List all loops
hubcode loop inspect <id>             # Show loop details and iterations
hubcode loop logs <id>                # Stream loop logs
hubcode loop stop <id>                # Stop a running loop
```

## Schedule Commands

Recurring time-based execution: run a prompt on a cron or interval schedule.

```bash
# Create a schedule
hubcode schedule create "<prompt>" [options]
  --every <duration>                # Fixed interval (5m, 1h)
  --cron <expr>                     # Cron expression
  --name <name>                     # Optional schedule name
  --target <self|new-agent|id>      # Run target
  --max-runs <n>                    # Maximum number of runs
  --expires-in <duration>           # Time to live for schedule

# Manage schedules
hubcode schedule ls                   # List schedules
hubcode schedule inspect <id>         # Inspect a schedule
hubcode schedule logs <id>            # Show recent run logs
hubcode schedule pause <id>           # Pause a schedule
hubcode schedule resume <id>          # Resume a paused schedule
hubcode schedule delete <id>          # Delete a schedule
```

## Chat Commands

Asynchronous agent coordination through persistent chat rooms.

```bash
# Create a chat room
hubcode chat create <name> --purpose "<description>"

# List and inspect rooms
hubcode chat ls
hubcode chat inspect <name-or-id>

# Post a message
hubcode chat post <room> "<message>"
hubcode chat post <room> "<message>" --reply-to <msg-id>
hubcode chat post <room> "@<agent-id> <message>"
hubcode chat post <room> "@everyone <message>"

# Read messages
hubcode chat read <room>
hubcode chat read <room> --limit <n>
hubcode chat read <room> --since <duration-or-timestamp>
hubcode chat read <room> --agent <agent-id>

# Wait for new messages
hubcode chat wait <room>
hubcode chat wait <room> --timeout <duration>

# Delete a room
hubcode chat delete <name-or-id>
```

## Terminal Commands

Manage workspace terminals: create, inspect, send keystrokes, capture output.

```bash
# List terminals (scoped to current directory by default)
hubcode terminal ls                    # Terminals in current directory
hubcode terminal ls --all              # All terminals across all workspaces
hubcode terminal ls --cwd ~/dev/myapp  # Terminals in a specific directory

# Create a terminal
hubcode terminal create                          # In current directory
hubcode terminal create --cwd ~/dev/myapp        # In a specific directory
hubcode terminal create --name "build-runner"    # With a custom name

# Kill a terminal (supports short ID prefixes and name matching)
hubcode terminal kill <terminal-id>
hubcode terminal kill abc123           # Short prefix
hubcode terminal kill build-runner     # By name

# Capture terminal output as plain text (like tmux capture-pane -p)
hubcode terminal capture <terminal-id>               # Visible pane only, ANSI stripped
hubcode terminal capture <terminal-id> --scrollback   # Full scrollback + visible
hubcode terminal capture <terminal-id> -S             # Short form of --scrollback
hubcode terminal capture <terminal-id> --start 0 --end 10   # Line range (tmux-style)
hubcode terminal capture <terminal-id> --start -5     # Last 5 lines
hubcode terminal capture <terminal-id> --ansi         # Preserve ANSI escape codes
hubcode terminal capture <terminal-id> --json         # JSON output with metadata

# Send keystrokes (like tmux send-keys)
hubcode terminal send-keys <terminal-id> "ls -la" Enter
hubcode terminal send-keys <terminal-id> "echo hello" Enter
hubcode terminal send-keys <terminal-id> C-c          # Ctrl+C
hubcode terminal send-keys <terminal-id> C-d          # Ctrl+D
hubcode terminal send-keys <terminal-id> --literal "raw text"  # No special token interpretation
```

**Special key tokens** (interpreted by default, use `--literal` to send raw):
`Enter`, `Tab`, `Escape`, `Space`, `BSpace`, `C-c`, `C-d`, `C-z`, `C-l`, `C-a`, `C-e`

**Common pattern — launch a process and interact with it:**
```bash
id=$(hubcode terminal create --name "my-shell" -q)
hubcode terminal send-keys "$id" "claude" Enter
sleep 5
hubcode terminal capture "$id" --scrollback   # See what happened
hubcode terminal send-keys "$id" "Hello!" Enter
sleep 10
hubcode terminal capture "$id" --scrollback   # See the response
hubcode terminal send-keys "$id" "/exit" Enter
hubcode terminal kill "$id"
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

Both `hubcode run` and `hubcode wait` block until the agent completes. Trust them.

- `hubcode run` waits **forever** by default (no timeout). Use `--wait-timeout` to set a limit.
- `hubcode wait` also waits forever by default. Use `--timeout` to set a limit.
- Agent tasks can legitimately take 10, 20, or even 30+ minutes. This is normal.
- When a wait times out, **just re-run `hubcode wait <id>`** — don't panic, don't start checking logs.
- Do NOT poll with `hubcode ls`, `hubcode inspect`, or `hubcode logs` in a loop to "check on" the agent.
- **Never launch a duplicate agent** because a wait timed out. The original is still running.

## Composing Agents in Bash

`hubcode run` blocks by default and `--output-schema` returns structured JSON, making it easy to compose agents in bash loops and pipelines.

**Detach + wait pattern for parallel work:**
```bash
api_id=$(hubcode run -d --name "impl-api" "implement the API" -q)
ui_id=$(hubcode run -d --name "impl-ui" "implement the UI" -q)

hubcode wait "$api_id"
hubcode wait "$ui_id"
```
