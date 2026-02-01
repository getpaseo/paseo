# Paseo CLI Design: Agent Orchestration

Inspired by Docker's mental model: containers → agents, images → providers

## ⚠️ CRITICAL ARCHITECTURE PRINCIPLE

**The CLI MUST be a THIN abstraction layer on top of the daemon client.**

Any missing features required by the CLI MUST be implemented in the daemon and exposed through the client API. The CLI layer should contain:
- Argument parsing
- Output formatting
- User interaction (prompts, progress display)

The CLI layer should NOT contain:
- Business logic
- State management
- Direct agent manipulation

If a feature is needed in the CLI, the workflow is:
1. Add the capability to the daemon (packages/server)
2. Expose it through the client API (PaseoClient)
3. Call it from the CLI (thin wrapper)

### CLI Bundles the Daemon

The CLI package depends on `@paseo/server` because it needs to:
1. **Start the daemon** - `paseo daemon start` spawns/runs the server process
2. **Talk to the daemon** - Uses `DaemonClientV2` for all other commands

```
┌─────────────────────────────────────────────────────┐
│                   @paseo/cli                        │
│  ┌───────────────────────────────────────────────┐  │
│  │  CLI Commands (agent, permit, worktree, etc.) │  │
│  └───────────────────────────────────────────────┘  │
│                        │                            │
│         ┌──────────────┴──────────────┐             │
│         ▼                             ▼             │
│  ┌─────────────────┐        ┌─────────────────┐     │
│  │ daemon start    │        │ DaemonClientV2  │     │
│  │ (spawns server) │        │ (WebSocket)     │     │
│  └────────┬────────┘        └────────┬────────┘     │
│           │                          │              │
│  ┌────────┴──────────────────────────┴────────┐     │
│  │              @paseo/server                 │     │
│  │  (daemon code, agent manager, providers)   │     │
│  └────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────┘
```

The `paseo` binary becomes the **unified entry point** for Paseo:
- `paseo daemon start` → runs the server (foreground or daemonized)
- `paseo agent ls` → connects to running daemon via WebSocket
- `paseo agent run "..."` → connects and creates agent

This replaces the need to run `npm run start` in the server package directly.

### Migration from Current Server Entry Point

Currently, the daemon is started via `packages/server/src/server/index.ts`:
- Config loaded from env vars: `PASEO_LISTEN`, `PASEO_CORS_ORIGINS`, etc.
- Single flag: `--no-relay`
- No proper CLI argument parsing

The CLI replaces this with proper commands:

| Current | New CLI |
|---------|---------|
| `npm run start` | `paseo daemon start --foreground` |
| `PASEO_LISTEN=:7777 npm run start` | `paseo daemon start --port 7777` |
| `npm run start -- --no-relay` | `paseo daemon start --no-relay` |
| `PASEO_HOME=~/.paseo-dev npm run start` | `paseo daemon start --home ~/.paseo-dev` |

### Refactoring the Server Package

The server package should expose a **clean programmatic API**. Keep it DRY.

**Current state:**
```
index.ts          → loads .env, reads env vars, creates config, runs daemon
dev-runner.ts     → forks index.ts with restart capability
config.ts         → loadConfig() reads from process.env
bootstrap.ts      → createPaseoDaemon(config, logger) - CLEAN ✓
```

**Target state:**
```
index.ts          → reads env vars, creates config, runs daemon (NO dotenv)
dev-runner.ts     → loads .env, then forks index.ts
config.ts         → loadConfig() reads from process.env (unchanged)
bootstrap.ts      → createPaseoDaemon(config, logger) - CLEAN ✓
```

**Changes:**
- Move `dotenv.config()` from `index.ts` → `dev-runner.ts`
- `index.ts` stays as direct entry point, just uses whatever env vars are set

**Server exports for CLI:**
```
@paseo/server exports:
  - createPaseoDaemon(config, logger) → PaseoDaemon
  - loadConfig(paseoHome) → PaseoDaemonConfig
  - PaseoDaemonConfig type
  - createRootLogger(options) → Logger
  - DaemonClientV2 (for client connections)
  - resolvePaseoHome(override?) → string
```

**CLI uses server's programmatic API:**
```
@paseo/cli:
  - Parses CLI args (--port, --home, --no-relay, etc.)
  - Optionally loads .env
  - Calls loadConfig() or builds config from args
  - Calls createPaseoDaemon(config, logger)
  - Handles signals, daemonization, PID files
```

The key principle: **`index.ts` is for direct use (dev/prod), CLI wraps the same programmatic API**.

---

## Core Concepts

| Docker | Paseo CLI | Description |
|--------|-----------|-------------|
| `container` | `agent` | Running AI coding agent instance |
| `image` | `provider` | Agent provider (claude, codex, opencode) |
| `volume` | `worktree` | Git worktree for isolated work |

---

## Command Structure

```
paseo <command> [subcommand] [options] [args]
```

### Shorthand Commands

Like Docker, common agent operations are lifted to the top level for convenience:

| Shorthand | Full Command | Description |
|-----------|--------------|-------------|
| `paseo ls` | `paseo agent ls` | List agents |
| `paseo run` | `paseo agent run` | Run an agent |
| `paseo logs` | `paseo agent logs` | View agent logs |
| `paseo stop` | `paseo agent stop` | Stop an agent |
| `paseo attach` | `paseo agent attach` | Attach to agent output |
| `paseo send` | `paseo agent send` | Send message to agent |
| `paseo inspect` | `paseo agent inspect` | Inspect agent details |
| `paseo wait` | `paseo agent wait` | Wait for agent |

Both forms are equivalent:
```bash
paseo ls -ag          # shorthand
paseo agent ls -ag    # full form
```

---

## Agent Commands (`paseo agent`)

### `paseo agent run`
Create and start an agent with a task.

```bash
# Start a claude agent in current directory
paseo agent run "Fix the failing tests"

# Start with a specific provider
paseo agent run --provider codex "Fix the failing tests"

# Run in background (detached)
paseo agent run -d --name "test-fixer" "Run the test suite and fix failures"

# Run with a specific mode (modes are provider-specific)
paseo agent run --mode bypass "Refactor the auth module"
paseo agent run --provider codex --mode full-access "Refactor the auth module"

# Run in a new worktree
paseo agent run --worktree feature/auth "Implement OAuth login"

# Run with images attached
paseo agent run --image ./screenshot.png "Match this design"
```

**Options:**
- `-d, --detach` - Run in background
- `--name <name>` - Assign a name/title to the agent
- `--provider <provider>` - claude | codex | opencode (default: claude)
- `--mode <mode>` - Provider-specific mode (claude: plan/default/bypass, codex: read-only/auto/full-access)
- `--worktree <name>` - Create agent in a new git worktree
- `--base <branch>` - Base branch for worktree (default: current branch)
- `--image <path>` - Attach image(s) to the initial prompt
- `--cwd <path>` - Working directory (default: current)

---

### `paseo agent ls`
List agents. By default shows running agents in current directory.

```bash
# Running agents in current directory (default)
paseo agent ls

# All statuses (running, idle, error, archived) in current directory
paseo agent ls -a

# Running agents globally (all directories)
paseo agent ls -g

# Everything everywhere (all statuses, all directories)
paseo agent ls -ag

# JSON output for scripting
paseo agent ls --json
```

**Options:**
- `-a, --all` - Include all statuses (not just running)
- `-g, --global` - Show agents from all directories (not just current)

**Default behavior (no flags):**
- Only `running` and `idle` agents
- Only agents in current working directory (or subdirectories)

**Sorting:**
- Primary: Status (`running` first, then `idle`, then others)
- Secondary: Created at (most recent first)

**Output:**
```
AGENT ID    NAME              PROVIDER             STATUS   CWD                    CREATED
a1b2c3d     🎭 Test fixer     claude/sonnet        running  ~/dev/paseo            2 minutes ago
e4f5g6h     Debug auth        codex/gpt-5.2        idle     ~/dev/paseo            15 minutes ago
```

The PROVIDER column shows `{provider}/{model}` format (e.g., `claude/opus`, `claude/sonnet`, `codex/gpt-5.2`).

**Output with `-ag` (everything everywhere):**
```
AGENT ID    NAME              PROVIDER             STATUS    CWD                    CREATED
a1b2c3d     🎭 Test fixer     claude/sonnet        running   ~/dev/paseo            2 minutes ago
e4f5g6h     Debug auth        codex/gpt-5.2        idle      ~/dev/paseo            15 minutes ago
i7j8k9l     -                 claude/haiku         error     ~/dev/other-project    1 hour ago
m3n4o5p     Old task          claude/opus          archived  ~/dev/paseo            2 days ago
```

---

### `paseo agent attach`
Attach to a running agent's output stream.

```bash
# Attach by ID
paseo agent attach a1b2c3d

# Attach by name
paseo agent attach "Test fixer"
```

Streams agent output to terminal. Ctrl+C to detach.

---

### `paseo agent logs`
View agent activity/timeline.

```bash
# Show recent activity
paseo agent logs a1b2c3d

# Follow logs in real-time
paseo agent logs -f a1b2c3d

# Show last N entries
paseo agent logs --tail 50 a1b2c3d

# Show tool invocations only
paseo agent logs --filter tools a1b2c3d
```

**Options:**
- `-f, --follow` - Follow log output
- `--tail <n>` - Show last n entries
- `--filter <type>` - Filter by event type (tools, text, errors, permissions)
- `--since <time>` - Show logs since timestamp

---

### `paseo agent send`
Send a message/task to an existing agent.

```bash
# Send a follow-up task
paseo agent send a1b2c3d "Now run the linter"

# Attach images
paseo agent send a1b2c3d --image ./bug.png "Fix this UI bug"

# Don't wait for completion
paseo agent send --no-wait a1b2c3d "Run the full test suite"
```

**Options:**
- `--image <path>` - Attach image(s)
- `--no-wait` - Return immediately (default: wait for completion)

---

### `paseo agent stop`
Stop an agent (cancel if running, then terminate).

```bash
paseo agent stop a1b2c3d
paseo agent stop --all
paseo agent stop --cwd ~/dev/paseo
```

**Options:**
- `--all` - Stop all agents
- `--cwd <path>` - Stop all agents in directory

---

### `paseo agent inspect`
Show detailed information about an agent.

```bash
paseo agent inspect a1b2c3d
```

**Output:**
```yaml
Id: a1b2c3d4e5f6
Name: 🎭 Test fixer
Provider: claude
Model: claude-sonnet-4-20250514
Status: running
Mode: bypass
Cwd: /Users/me/dev/paseo
CreatedAt: 2024-01-15T10:30:00Z
UpdatedAt: 2024-01-15T10:35:22Z
LastUsage:
  InputTokens: 45230
  OutputTokens: 12840
  CachedTokens: 38000
  CostUsd: 0.23
Capabilities:
  Streaming: true
  Persistence: true
  DynamicModes: true
  McpServers: true
AvailableModes:
  - id: plan
    label: Plan Mode
  - id: default
    label: Default
  - id: bypass
    label: Bypass Permissions
PendingPermissions: []
Worktree: null
ParentAgentId: null
```

---

### `paseo agent mode`
Change an agent's operational mode.

```bash
# Set mode (must be valid for the agent's provider)
paseo agent mode a1b2c3d bypass
paseo agent mode a1b2c3d plan

# List available modes for this agent
paseo agent mode --list a1b2c3d
```

**Output (--list):**
```
MODE      LABEL                DESCRIPTION
plan      Plan Mode            Read-only, propose changes
default   Default              Edit files, approval for commands
bypass    Bypass Permissions   Full access without prompts
```

---

### `paseo agent wait`
Wait for an agent to become idle.

```bash
# Wait for idle
paseo agent wait a1b2c3d

# Wait with timeout
paseo agent wait --timeout 5m a1b2c3d
```

**Options:**
- `--timeout <duration>` - Maximum wait time (e.g., 5m, 30s)

---

### `paseo agent archive`
Archive an agent (soft delete, keeps history).

```bash
paseo agent archive a1b2c3d
```

---

## Permission Commands (`paseo permit`)

### `paseo permit ls`
List pending permission requests across all agents.

```bash
paseo permit ls

# Output:
AGENT       REQ_ID      TOOL      DESCRIPTION
a1b2c3d     req-123     bash      Run: npm test
e4f5g6h     req-456     write     Write: src/auth.ts
```

---

### `paseo permit allow`
Approve a permission request.

```bash
paseo permit allow a1b2c3d req-123

# Allow all pending for an agent
paseo permit allow --all a1b2c3d

# Allow with modifications
paseo permit allow a1b2c3d req-123 --input '{"command": "npm test --ci"}'
```

**Options:**
- `--all` - Allow all pending permissions for agent
- `--input <json>` - Modified input parameters

---

### `paseo permit deny`
Deny a permission request.

```bash
paseo permit deny a1b2c3d req-123
paseo permit deny a1b2c3d req-123 --message "Use yarn instead"

# Deny and interrupt the agent
paseo permit deny --interrupt a1b2c3d req-123
```

**Options:**
- `--message <msg>` - Denial reason sent to agent
- `--interrupt` - Stop the agent after denial

---

## Worktree Commands (`paseo worktree`)

### `paseo worktree ls`
List Paseo-managed git worktrees.

```bash
paseo worktree ls

# Output:
NAME              BRANCH                CWD                                    AGENT
feature-auth      paseo/feature-auth    ~/.paseo/worktrees/feature-auth        a1b2c3d
fix-tests         paseo/fix-tests       ~/.paseo/worktrees/fix-tests           -
```

---

### `paseo worktree archive`
Archive a worktree.

```bash
paseo worktree archive feature-auth
```

---

## Provider Commands (`paseo provider`)

### `paseo provider ls`
List available providers and their status.

```bash
paseo provider ls

# Output:
PROVIDER    STATUS      DEFAULT MODE    MODES
claude      available   default         plan, default, bypass
codex       available   auto            read-only, auto, full-access
opencode    available   default         plan, default, bypass
```

---

### `paseo provider models`
List available models for a provider.

```bash
paseo provider models claude

# Output:
MODEL                          ID
Claude Sonnet 4                claude-sonnet-4-20250514
Claude Opus 4                  claude-opus-4-20250514
Claude Haiku 3.5               claude-3-5-haiku-20241022
```

---

## Daemon Commands (`paseo daemon`)

### `paseo daemon start`
Start the Paseo daemon.

```bash
paseo daemon start
paseo daemon start --port 7777
paseo daemon start --home ~/.paseo-dev
paseo daemon start --foreground
```

**Options:**
- `--port <port>` - Port to listen on (default: 6767)
- `--home <path>` - Paseo home directory (default: ~/.paseo)
- `--foreground` - Run in foreground (don't daemonize)
- `--allowed-hosts <hosts>` - Comma-separated allowed hosts

---

### `paseo daemon stop`
Stop the daemon.

```bash
paseo daemon stop
```

---

### `paseo daemon status`
Show daemon status.

```bash
paseo daemon status

# Output:
Status: running
PID: 12345
Port: 6767
Home: ~/.paseo
Uptime: 2h 15m
Agents: 3 running, 1 idle
```

---

### `paseo daemon restart`
Restart the daemon.

```bash
paseo daemon restart
```

---

## Global Options

```bash
# Connect to specific daemon
paseo --host localhost:7777 agent ps

# Output format
paseo agent ls --json
paseo agent ls --format yaml
paseo agent ls --format table  # default

# Quiet mode (minimal output, just IDs)
paseo -q agent run "Fix tests"

# Version
paseo --version

# Help
paseo --help
paseo agent --help
paseo agent run --help
```

---

## Environment Variables

```bash
PASEO_HOST=localhost:6767      # Daemon host:port
PASEO_DEFAULT_PROVIDER=claude  # Default provider for `agent run`
PASEO_DEFAULT_MODE=default     # Default mode for `agent run`
```

---

## Example Workflows

### 1. Quick task
```bash
paseo agent run "Add input validation to the signup form"
```

### 2. Background worker
```bash
# Start in background
paseo agent run -d --name "linter" "Run eslint --fix on the codebase"

# Check progress
paseo agent logs -f linter

# Stop when done
paseo agent stop linter
```

### 3. Permission-gated workflow
```bash
# Run in plan mode first
paseo agent run --mode plan "Refactor the database layer"

# Review the plan, then approve
paseo permit ls
paseo permit allow a1b2c3d plan-123

# Switch to bypass mode for execution
paseo agent mode a1b2c3d bypass
paseo agent send a1b2c3d "Execute the plan"
```

### 4. Parallel feature development
```bash
# Start multiple agents in worktrees
paseo agent run -d --worktree feature/api --name "API" "Build REST endpoints"
paseo agent run -d --worktree feature/ui --name "UI" "Build React components"

# Monitor both
paseo agent ls
paseo agent logs -f API
```

### 5. Agent consultation (ask another agent)
```bash
# Create a "consultant" agent
ID=$(paseo -q agent run -d --name "consultant" --provider codex --mode read-only "You are a code reviewer. Wait for code to review.")

# Ask for a second opinion
paseo agent send $ID "Review this approach: [paste]"

# Get the response
paseo agent logs $ID
```

### 6. Scripted CI workflow
```bash
#!/bin/bash
set -e

# Run tests agent
AGENT=$(paseo -q run -d "Run the test suite")

# Wait for completion or permission
paseo wait --timeout 10m $AGENT

# Check for pending permissions
if paseo permit ls | grep -q $AGENT; then
  paseo permit allow --all $AGENT
  paseo wait --timeout 5m $AGENT
fi

# Get exit status from logs
paseo logs --tail 10 $AGENT

# Cleanup
paseo stop $AGENT
```

---

## Command Summary

### Shorthand Commands (top-level)

| Shorthand | Full Form | Description |
|-----------|-----------|-------------|
| `paseo run <prompt>` | `paseo agent run` | Create and run agent with task |
| `paseo ls` | `paseo agent ls` | List running agents in current directory |
| `paseo ls -a` | `paseo agent ls -a` | Include all statuses (not just running) |
| `paseo ls -g` | `paseo agent ls -g` | Show agents globally (all directories) |
| `paseo ls -ag` | `paseo agent ls -ag` | Everything everywhere |
| `paseo attach <id>` | `paseo agent attach` | Attach to agent output stream |
| `paseo logs <id>` | `paseo agent logs` | View agent activity |
| `paseo send <id> <prompt>` | `paseo agent send` | Send message to agent |
| `paseo stop <id>` | `paseo agent stop` | Stop and terminate agent |
| `paseo inspect <id>` | `paseo agent inspect` | Show agent details |
| `paseo wait <id>` | `paseo agent wait` | Wait for agent state |

### Full Commands

| Command | Description |
|---------|-------------|
| `paseo agent run <prompt>` | Create and run agent with task |
| `paseo agent ls` | List running agents in current directory |
| `paseo agent mode <id> <mode>` | Change agent mode |
| `paseo agent archive <id>` | Archive agent |
| `paseo permit ls` | List pending permissions |
| `paseo permit allow <agent> <req>` | Approve permission |
| `paseo permit deny <agent> <req>` | Deny permission |
| `paseo worktree ls` | List worktrees |
| `paseo worktree archive <name>` | Archive worktree |
| `paseo provider ls` | List providers |
| `paseo provider models <provider>` | List provider models |
| `paseo daemon start` | Start daemon |
| `paseo daemon stop` | Stop daemon |
| `paseo daemon status` | Show daemon status |
| `paseo daemon restart` | Restart daemon |

---

## Testing Strategy

**Primary approach: TDD with [zx](https://github.com/google/zx)** - See the "TDD Checklist (zx)" section above for the comprehensive test plan.

The CLI testing strategy combines zx-based E2E tests (primary) with Vitest unit tests (secondary):
- **zx E2E tests**: Spawn isolated daemons on random ports, test real CLI behavior
- **Vitest unit tests**: Test argument parsing and output formatting in isolation

**Critical rules:**
- NEVER use port 6767 in tests (user's running daemon)
- Always use `--provider claude --model haiku` for fast, cheap agent tests
- Each test script manages its own daemon lifecycle

The following sections describe the additional Vitest-based tests for argument parsing and formatting.

### Unit Tests (Vitest)

Test argument parsing and output formatting in isolation. Location: `packages/cli/src/**/*.test.ts`

```typescript
// Example: command parsing test
describe('agent run command', () => {
  it('parses provider option', () => {
    const result = parseArgs(['agent', 'run', '--provider', 'codex', 'Fix tests'])
    expect(result.provider).toBe('codex')
    expect(result.prompt).toBe('Fix tests')
  })

  it('handles detach flag', () => {
    const result = parseArgs(['agent', 'run', '-d', 'Fix tests'])
    expect(result.detach).toBe(true)
  })
})

// Example: output formatting test
describe('agent ps formatter', () => {
  it('formats table output', () => {
    const agents = [mockAgent({ status: 'running', title: 'Test' })]
    const output = formatAgentTable(agents)
    expect(output).toContain('running')
    expect(output).toContain('Test')
  })

  it('formats JSON output', () => {
    const agents = [mockAgent({ status: 'running' })]
    const output = formatAgentJson(agents)
    expect(JSON.parse(output)).toEqual(agents)
  })
})
```

**Test coverage:**
- Argument parsing for all commands
- Output formatters (table, JSON, YAML, quiet mode)
- Error message formatting
- Duration/time formatters ("2 minutes ago", etc.)
- ID/name resolution logic

### Integration Tests (Vitest + DaemonTestContext)

Test CLI commands against a real (test) daemon. Uses existing `createDaemonTestContext()` from `packages/server/src/server/test-utils/`.

Location: `packages/cli/src/**/*.integration.test.ts`

```typescript
import { createDaemonTestContext, type DaemonTestContext } from '@paseo/server/test-utils'

describe('agent ps integration', () => {
  let ctx: DaemonTestContext

  beforeEach(async () => {
    ctx = await createDaemonTestContext()
  }, 30000)

  afterEach(async () => {
    await ctx.cleanup()
  }, 60000)

  it('lists created agents', async () => {
    // Create an agent through the daemon client
    const agent = await ctx.client.createAgent({
      provider: 'claude',
      cwd: '/tmp',
      modeId: 'default'
    })

    // Run CLI command (programmatically, not spawning)
    const result = await runCliCommand(['agent', 'ps'], { host: ctx.host })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(agent.id.substring(0, 7))
  })
})
```

**Test coverage:**
- All daemon client API calls work correctly
- Error handling for daemon disconnection
- Timeout handling
- Connection retry logic

### E2E Tests (Playwright or direct spawn)

Full workflow testing with actual CLI binary. Can either use Playwright (for consistency with app E2E tests) or direct process spawning.

Location: `packages/cli/e2e/**/*.e2e.test.ts`

```typescript
import { spawn } from 'child_process'

describe('CLI E2E', () => {
  let daemonProcess: ChildProcess
  let daemonPort: number

  beforeAll(async () => {
    // Start isolated daemon
    daemonPort = await getPort()
    daemonProcess = spawn('npm', ['run', 'start'], {
      env: { ...process.env, PASEO_PORT: String(daemonPort) }
    })
    await waitForDaemonReady(daemonPort)
  })

  afterAll(async () => {
    daemonProcess.kill()
  })

  it('complete workflow: run -> ps -> logs -> stop', async () => {
    // Run agent in background
    const runResult = await execCli(['agent', 'run', '-d', 'echo hello'], {
      env: { PASEO_HOST: `localhost:${daemonPort}` }
    })
    expect(runResult.exitCode).toBe(0)
    const agentId = runResult.stdout.trim()

    // List agents
    const psResult = await execCli(['agent', 'ps'], {
      env: { PASEO_HOST: `localhost:${daemonPort}` }
    })
    expect(psResult.stdout).toContain(agentId.substring(0, 7))

    // Get logs
    const logsResult = await execCli(['agent', 'logs', agentId], {
      env: { PASEO_HOST: `localhost:${daemonPort}` }
    })
    expect(logsResult.exitCode).toBe(0)

    // Stop agent
    const stopResult = await execCli(['agent', 'stop', agentId], {
      env: { PASEO_HOST: `localhost:${daemonPort}` }
    })
    expect(stopResult.exitCode).toBe(0)
  })

  it('quiet mode returns only ID', async () => {
    const result = await execCli(['-q', 'agent', 'run', '-d', 'test'], {
      env: { PASEO_HOST: `localhost:${daemonPort}` }
    })
    // Should be just the ID, no other output
    expect(result.stdout.trim()).toMatch(/^[a-z0-9-]+$/)
  })

  it('handles daemon not running', async () => {
    const result = await execCli(['agent', 'ps'], {
      env: { PASEO_HOST: 'localhost:9999' }
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('daemon not running')
  })
})
```

**Test coverage:**
- Complete workflows (example scenarios from design doc)
- Signal handling (Ctrl+C on attach)
- Exit codes for success/failure
- Scripting compatibility (quiet mode, JSON output)
- Error messages for common failures

### Test Utilities

Create reusable test utilities in `packages/cli/src/test-utils/`:

```typescript
// mock-daemon.ts
export function createMockDaemonClient(): MockDaemonClient {
  return {
    agents: new Map(),
    createAgent: vi.fn(),
    listAgents: vi.fn(),
    // ...
  }
}

// cli-runner.ts
export async function runCliCommand(
  args: string[],
  options?: { host?: string; stdin?: string }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // For unit/integration tests: call CLI programmatically
}

export async function execCli(
  args: string[],
  options?: { env?: Record<string, string> }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // For E2E tests: spawn actual CLI process
}

// fixtures.ts
export function mockAgent(overrides?: Partial<AgentSnapshot>): AgentSnapshot {
  return {
    id: 'test-agent-123',
    status: 'idle',
    provider: 'claude',
    title: 'Test Agent',
    cwd: '/test/path',
    createdAt: new Date().toISOString(),
    ...overrides
  }
}
```

### Test Scripts (package.json)

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "test:e2e": "vitest run --config vitest.e2e.config.ts"
  }
}
```

### CI Integration

Tests run in the existing CI pipeline:
- Unit tests: Fast, run on every PR
- Integration tests: Require daemon, run on every PR
- E2E tests: Full workflow, run on merge to main

### What NOT to Test in CLI

Per the "thin abstraction" principle, the CLI should NOT test:
- Agent lifecycle logic (tested in server package)
- Permission handling logic (tested in server package)
- WebSocket protocol (tested in server package)

The CLI tests focus on:
- Argument parsing correctness
- Output formatting
- Error message quality
- Signal handling
- Scripting compatibility

---

## TDD Checklist (zx)

Use [zx](https://github.com/google/zx) for end-to-end testing. Each test script spawns an isolated daemon on a random port (NEVER use 6767 - that's the user's running daemon).

### Critical Rules

1. **Port**: Random port via `get-port` or `10000 + random()` - **NEVER 6767**
2. **Protocol**: WebSocket ONLY - no HTTP endpoints exist
3. **Temp dirs**: Create temp directories for `PASEO_HOME` and agent `--cwd`
4. **Model**: Always `--provider claude` with haiku model for fast, cheap tests
5. **Cleanup**: Kill daemon and remove temp dirs after each test

### Test Setup Pattern

```typescript
#!/usr/bin/env npx zx

import { $, sleep } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// Get random available port (never 6767)
const port = 10000 + Math.floor(Math.random() * 50000)

// Create isolated temp directories
const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-test-home-'))
const workDir = await mkdtemp(join(tmpdir(), 'paseo-test-work-'))

// Start isolated daemon
const daemon = $`PASEO_HOME=${paseoHome} PASEO_PORT=${port} paseo daemon start --foreground`.nothrow()

// Wait for daemon ready (WebSocket connection test)
async function waitForDaemon(port: number, timeout = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      // Try to connect via WebSocket and list agents
      const result = await $`PASEO_HOST=localhost:${port} paseo agent ls`.nothrow()
      if (result.exitCode === 0) return
    } catch {}
    await sleep(100)
  }
  throw new Error(`Daemon failed to start on port ${port}`)
}

await waitForDaemon(port)

// Helper to run CLI commands against test daemon
const paseo = (args: string[]) =>
  $`PASEO_HOST=localhost:${port} paseo ${args}`

// Cleanup on exit
async function cleanup() {
  daemon.kill()
  await rm(paseoHome, { recursive: true, force: true })
  await rm(workDir, { recursive: true, force: true })
}
process.on('exit', cleanup)
process.on('SIGINT', cleanup)
```

### Agent Test Pattern

Always use temp `workDir` for agents and haiku model:

```typescript
// Create agent in temp directory with fast model
const result = await paseo([
  '-q', 'agent', 'run', '-d',
  '--provider', 'claude',
  '--cwd', workDir,
  'say hello'
])
const agentId = result.stdout.trim()
```

---

### Phase 1: Foundation
- [ ] **1.1** Package setup (`packages/cli/`)
- [ ] **1.2** Entry point (`bin/paseo`)
- [ ] **1.3** `paseo --version` works
- [ ] **1.4** `paseo --help` shows commands

**Test: `tests/01-foundation.test.mts`**
```typescript
#!/usr/bin/env npx zx
await $`paseo --version`
await $`paseo --help`
```

---

### Phase 2: Daemon Commands
- [ ] **2.1** `paseo daemon start --foreground --port <port>` starts daemon
- [ ] **2.2** `paseo daemon status` shows running status
- [ ] **2.3** `paseo daemon stop` stops daemon
- [ ] **2.4** `paseo daemon restart` restarts daemon

**Test: `tests/02-daemon.test.mts`**
```typescript
#!/usr/bin/env npx zx
const port = 10000 + Math.floor(Math.random() * 50000)
const home = `/tmp/paseo-test-${port}`

// Start daemon
const daemon = $`PASEO_HOME=${home} PASEO_PORT=${port} paseo daemon start --foreground`.nothrow()
await sleep(2000)

// Check status
const status = await $`PASEO_HOST=localhost:${port} paseo daemon status`
assert(status.stdout.includes('running'))

// Cleanup
daemon.kill()
await $`rm -rf ${home}`
```

---

### Phase 3: Agent List (`agent ls`)
- [ ] **3.1** `paseo agent ls` returns empty list when no agents
- [ ] **3.2** `paseo agent ls` shows created agents in current directory
- [ ] **3.3** `paseo agent ls -a` includes all statuses (running, idle, error, archived)
- [ ] **3.4** `paseo agent ls -g` shows agents globally (all directories)
- [ ] **3.5** `paseo agent ls -ag` shows everything everywhere
- [ ] **3.6** `paseo agent ls --json` returns valid JSON

**Test: `tests/03-agent-ls.test.ts`**
```typescript
#!/usr/bin/env npx zx
// ... setup daemon on random port ...

// Empty list
const empty = await paseo(['agent', 'ls', '--json'])
assert(JSON.parse(empty.stdout).length === 0)

// Create agent (haiku for speed)
await paseo(['agent', 'run', '-d', '--provider', 'claude', '--model', 'haiku', 'echo test'])

// Should appear in list
const list = await paseo(['agent', 'ls', '--json'])
assert(JSON.parse(list.stdout).length === 1)

// Global flag shows agents from all cwds
const global = await paseo(['agent', 'ls', '-g', '--json'])
// ...
```

---

### Phase 4: Agent Run
- [ ] **4.1** `paseo agent run "prompt"` creates and runs agent (foreground)
- [ ] **4.2** `paseo agent run -d "prompt"` runs detached, returns ID
- [ ] **4.3** `paseo agent run --name "foo" "prompt"` sets title
- [ ] **4.4** `paseo agent run --provider claude --model haiku "prompt"` uses specified model
- [ ] **4.5** `paseo agent run --mode plan "prompt"` sets mode
- [ ] **4.6** `paseo -q agent run -d "prompt"` returns only ID (quiet mode)

**Test: `tests/04-agent-run.test.mts`**
```typescript
#!/usr/bin/env npx zx
// ... setup daemon on random port ...

// Detached run returns ID
const result = await paseo(['-q', 'agent', 'run', '-d', '--provider', 'claude', '--model', 'haiku', 'say hello'])
const agentId = result.stdout.trim()
assert(agentId.match(/^[a-z0-9-]+$/))

// Agent appears in list
const list = await paseo(['agent', 'ps', '--json'])
const agents = JSON.parse(list.stdout)
assert(agents.some(a => a.id.startsWith(agentId.slice(0, 7))))
```

---

### Phase 5: Agent Send
- [ ] **5.1** `paseo agent send <id> "prompt"` sends message
- [ ] **5.2** `paseo agent send --no-wait <id> "prompt"` returns immediately
- [ ] **5.3** Agent ID prefix matching works (e.g., `a1b2` matches `a1b2c3d4`)

**Test: `tests/05-agent-send.test.mts`**
```typescript
#!/usr/bin/env npx zx
// ... setup daemon on random port ...

// Create agent
const id = (await paseo(['-q', 'agent', 'run', '-d', '--provider', 'claude', '--model', 'haiku', 'wait for instructions'])).stdout.trim()

// Send follow-up
await paseo(['agent', 'send', '--no-wait', id, 'say goodbye'])

// Verify agent received message (check logs)
await sleep(1000)
const logs = await paseo(['agent', 'logs', id])
assert(logs.stdout.includes('goodbye'))
```

---

### Phase 6: Agent Stop
- [ ] **6.1** `paseo agent stop <id>` stops running agent
- [ ] **6.2** `paseo agent stop --all` stops all agents
- [ ] **6.3** `paseo agent stop --cwd <path>` stops agents in directory

**Test: `tests/06-agent-stop.test.mts`**
```typescript
#!/usr/bin/env npx zx
// ... setup daemon on random port ...

// Create agent
const id = (await paseo(['-q', 'agent', 'run', '-d', '--provider', 'claude', '--model', 'haiku', 'wait'])).stdout.trim()

// Stop it
await paseo(['agent', 'stop', id])

// Should not appear in ps (or show as stopped)
const list = await paseo(['agent', 'ps', '--json'])
const agents = JSON.parse(list.stdout)
assert(!agents.some(a => a.id.startsWith(id.slice(0, 7)) && a.status === 'running'))
```

---

### Phase 7: Agent Logs
- [ ] **7.1** `paseo agent logs <id>` shows timeline
- [ ] **7.2** `paseo agent logs --tail 10 <id>` limits output
- [ ] **7.3** `paseo agent logs -f <id>` follows (streams) logs
- [ ] **7.4** `paseo agent logs --filter tools <id>` filters by type

**Test: `tests/07-agent-logs.test.mts`**
```typescript
#!/usr/bin/env npx zx
// ... setup daemon on random port ...

// Create agent that does something
const id = (await paseo(['-q', 'agent', 'run', '-d', '--provider', 'claude', '--model', 'haiku', 'list files in current directory'])).stdout.trim()

await sleep(3000) // Wait for agent to do work

// Get logs
const logs = await paseo(['agent', 'logs', id])
assert(logs.stdout.length > 0)

// Tail
const tail = await paseo(['agent', 'logs', '--tail', '5', id])
assert(tail.stdout.split('\n').length <= 10) // ~5 entries + formatting
```

---

### Phase 8: Agent Attach
- [ ] **8.1** `paseo agent attach <id>` streams output
- [ ] **8.2** Ctrl+C detaches without killing agent

**Test: `tests/08-agent-attach.test.mts`**
```typescript
#!/usr/bin/env npx zx
// ... setup daemon on random port ...

// Create long-running agent
const id = (await paseo(['-q', 'agent', 'run', '-d', '--provider', 'claude', '--model', 'haiku', 'count from 1 to 100 slowly'])).stdout.trim()

// Attach for 2 seconds then kill
const attach = $`PASEO_HOST=localhost:${port} paseo agent attach ${id}`.nothrow()
await sleep(2000)
attach.kill('SIGINT')

// Agent should still be running
const list = await paseo(['agent', 'ps', '--json'])
const agents = JSON.parse(list.stdout)
assert(agents.some(a => a.id.startsWith(id.slice(0, 7))))
```

---

### Phase 9: Agent Inspect
- [ ] **9.1** `paseo agent inspect <id>` shows detailed info
- [ ] **9.2** Output includes: id, name, provider, model, status, mode, cwd, created, usage

**Test: `tests/09-agent-inspect.test.mts`**
```typescript
#!/usr/bin/env npx zx
// ... setup daemon on random port ...

const id = (await paseo(['-q', 'agent', 'run', '-d', '--provider', 'claude', '--model', 'haiku', '--name', 'inspector', 'hello'])).stdout.trim()

const inspect = await paseo(['agent', 'inspect', id])
assert(inspect.stdout.includes('inspector'))
assert(inspect.stdout.includes('claude'))
assert(inspect.stdout.includes('haiku'))
```

---

### Phase 10: Agent Mode
- [ ] **10.1** `paseo agent mode <id> <mode>` changes mode
- [ ] **10.2** `paseo agent mode --list <id>` shows available modes

**Test: `tests/10-agent-mode.test.mts`**
```typescript
#!/usr/bin/env npx zx
// ... setup daemon on random port ...

const id = (await paseo(['-q', 'agent', 'run', '-d', '--provider', 'claude', '--model', 'haiku', 'wait'])).stdout.trim()

// List modes
const modes = await paseo(['agent', 'mode', '--list', id])
assert(modes.stdout.includes('plan') || modes.stdout.includes('default'))

// Change mode
await paseo(['agent', 'mode', id, 'plan'])

// Verify
const inspect = await paseo(['agent', 'inspect', id])
assert(inspect.stdout.includes('plan'))
```

---

### Phase 11: Agent Wait
- [ ] **11.1** `paseo agent wait <id>` blocks until idle
- [ ] **11.2** `paseo agent wait --timeout 5s <id>` respects timeout

**Test: `tests/11-agent-wait.test.mts`**
```typescript
#!/usr/bin/env npx zx
// ... setup daemon on random port ...

const id = (await paseo(['-q', 'agent', 'run', '-d', '--provider', 'claude', '--model', 'haiku', 'say hello'])).stdout.trim()

// Wait for completion
await paseo(['agent', 'wait', '--timeout', '30s', id])

// Should be idle now
const inspect = await paseo(['agent', 'inspect', id, '--json'])
const agent = JSON.parse(inspect.stdout)
assert(agent.status === 'idle' || agent.status === 'completed')
```

---

### Phase 12: Agent Archive
- [ ] **12.1** `paseo agent archive <id>` archives agent
- [ ] **12.2** Archived agent appears in `ps -a` but not `ps`

**Test: `tests/12-agent-archive.test.mts`**
```typescript
#!/usr/bin/env npx zx
// ... setup daemon on random port ...

const id = (await paseo(['-q', 'agent', 'run', '-d', '--provider', 'claude', '--model', 'haiku', 'hello'])).stdout.trim()
await paseo(['agent', 'wait', '--timeout', '30s', id])

// Archive
await paseo(['agent', 'archive', id])

// Not in ps
const list = await paseo(['agent', 'ps', '--json'])
assert(!JSON.parse(list.stdout).some(a => a.id.startsWith(id.slice(0, 7))))

// But in ps -a
const listAll = await paseo(['agent', 'ps', '-a', '--json'])
assert(JSON.parse(listAll.stdout).some(a => a.id.startsWith(id.slice(0, 7))))
```

---

### Phase 13: Permissions
- [ ] **13.1** `paseo permit ls` lists pending permissions
- [ ] **13.2** `paseo permit allow <agent> <req>` approves
- [ ] **13.3** `paseo permit deny <agent> <req>` denies
- [ ] **13.4** `paseo permit deny --message "reason" <agent> <req>` sends reason

**Test: `tests/13-permissions.test.mts`**
```typescript
#!/usr/bin/env npx zx
// ... setup daemon on random port ...

// Create agent in default mode (needs permission for bash)
const id = (await paseo(['-q', 'agent', 'run', '-d', '--provider', 'claude', '--model', 'haiku', '--mode', 'default', 'run npm test'])).stdout.trim()

await sleep(3000) // Wait for permission request

// List permissions
const permits = await paseo(['permit', 'ls', '--json'])
const pending = JSON.parse(permits.stdout)

if (pending.length > 0) {
  const req = pending.find(p => p.agentId.startsWith(id.slice(0, 7)))
  if (req) {
    // Allow it
    await paseo(['permit', 'allow', id, req.requestId])
  }
}
```

---

### Phase 14: Worktrees
- [ ] **14.1** `paseo worktree ls` lists worktrees
- [ ] **14.2** `paseo agent run --worktree <name> "prompt"` creates worktree
- [ ] **14.3** `paseo worktree archive <name>` archives worktree

**Test: `tests/14-worktrees.test.mts`**
```typescript
#!/usr/bin/env npx zx
// ... setup daemon on random port ...

// List worktrees (may be empty)
const list = await paseo(['worktree', 'ls'])
// Just verify command works
assert(list.exitCode === 0)
```

---

### Phase 15: Providers
- [ ] **15.1** `paseo provider ls` lists available providers
- [ ] **15.2** `paseo provider models claude` lists Claude models
- [ ] **15.3** `paseo provider models codex` lists Codex models

**Test: `tests/15-providers.test.mts`**
```typescript
#!/usr/bin/env npx zx
// ... setup daemon on random port ...

// List providers
const providers = await paseo(['provider', 'ls'])
assert(providers.stdout.includes('claude'))

// List models
const models = await paseo(['provider', 'models', 'claude'])
assert(models.stdout.includes('haiku'))
```

---

### Phase 16: Output Formats
- [ ] **16.1** `--json` works on all list commands
- [ ] **16.2** `--format yaml` works on all list commands
- [ ] **16.3** `--format table` is default
- [ ] **16.4** `-q` (quiet) returns minimal output

**Test: `tests/16-output-formats.test.mts`**
```typescript
#!/usr/bin/env npx zx
// ... setup daemon on random port ...

// JSON
const json = await paseo(['agent', 'ps', '--json'])
JSON.parse(json.stdout) // Should not throw

// YAML
const yaml = await paseo(['agent', 'ps', '--format', 'yaml'])
assert(!yaml.stdout.startsWith('[')) // Not JSON

// Quiet
const id = (await paseo(['-q', 'agent', 'run', '-d', '--provider', 'claude', '--model', 'haiku', 'hi'])).stdout.trim()
assert(id.match(/^[a-z0-9-]+$/)) // Just the ID
```

---

### Phase 17: Error Handling
- [ ] **17.1** Daemon not running shows clear error
- [ ] **17.2** Invalid agent ID shows clear error
- [ ] **17.3** Invalid command shows help
- [ ] **17.4** Connection timeout is handled gracefully

**Test: `tests/17-errors.test.mts`**
```typescript
#!/usr/bin/env npx zx

// Daemon not running (use port that's definitely not running)
const result = await $`PASEO_HOST=localhost:59999 paseo agent ls`.nothrow()
assert(result.exitCode !== 0)
assert(result.stderr.includes('daemon') || result.stderr.includes('connect'))

// Invalid agent ID
// ... setup daemon on random port ...
const invalid = await paseo(['agent', 'inspect', 'nonexistent-id-12345']).nothrow()
assert(invalid.exitCode !== 0)
```

---

### Phase 18: Complete Workflows
- [ ] **18.1** Quick task workflow (run, wait, done)
- [ ] **18.2** Background worker workflow (run -d, logs -f, stop)
- [ ] **18.3** Permission workflow (run default mode, permit ls, permit allow)
- [ ] **18.4** Scripted CI workflow (run, wait, check exit)

**Test: `tests/18-workflows.test.mts`**
```typescript
#!/usr/bin/env npx zx
// ... setup daemon on random port ...

// Complete workflow
const id = (await paseo(['-q', 'agent', 'run', '-d', '--provider', 'claude', '--model', 'haiku', 'say hello world'])).stdout.trim()

// Wait for completion
await paseo(['agent', 'wait', '--timeout', '60s', id])

// Check logs
const logs = await paseo(['agent', 'logs', id])
assert(logs.stdout.includes('hello') || logs.stdout.length > 0)

// Archive
await paseo(['agent', 'archive', id])

// Verify archived
const list = await paseo(['agent', 'ps', '--json'])
assert(!JSON.parse(list.stdout).some(a => a.id.startsWith(id.slice(0, 7))))

echo('✅ Complete workflow passed')
```

---

### Test Runner Script

**`tests/run-all.mts`**
```typescript
#!/usr/bin/env npx zx

const tests = [
  '01-foundation',
  '02-daemon',
  '03-agent-ps',
  '04-agent-run',
  '05-agent-send',
  '06-agent-stop',
  '07-agent-logs',
  '08-agent-attach',
  '09-agent-inspect',
  '10-agent-mode',
  '11-agent-wait',
  '12-agent-archive',
  '13-permissions',
  '14-worktrees',
  '15-providers',
  '16-output-formats',
  '17-errors',
  '18-workflows',
]

let passed = 0
let failed = 0

for (const test of tests) {
  echo(`\n📋 Running ${test}...`)
  try {
    await $`npx zx tests/${test}.test.mts`
    echo(`✅ ${test} passed`)
    passed++
  } catch (e) {
    echo(`❌ ${test} failed: ${e.message}`)
    failed++
  }
}

echo(`\n${'='.repeat(40)}`)
echo(`Results: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
```

---

## Implementation Plan

### Phase 1: Foundation

**Package Setup:**
1. Create `packages/cli/` with npm workspace
2. Use Commander.js for argument parsing
3. Set up Vitest for unit tests
4. Create `bin/paseo` entry point

**Daemon Client Enhancements:**
The existing `DaemonClientV2` in `packages/server/src/client/daemon-client-v2.ts` already supports most operations. Export it for CLI use:
- Export client from `packages/server`
- Add connection string parsing (host:port)

**Commands:**
- `paseo daemon status` - Check if daemon is running (health endpoint)
- `paseo agent ls` - List agents (uses `listAgents()`)

### Phase 2: Core Agent Commands

**Commands:**
- `paseo agent run <prompt>` - Create + initial prompt (uses `createAgent()` + `sendAgentMessage()`)
- `paseo agent send <id> <prompt>` - Send message (uses `sendAgentMessage()`)
- `paseo agent stop <id>` - Stop agent (uses `cancelAgent()` + `deleteAgent()`)
- `paseo agent logs <id>` - View timeline (uses existing timeline in agent state)

**Daemon Enhancements Needed:**
- Add `getAgentTimeline(agentId, options)` method to client for paginated timeline access
- Add timeline streaming subscription for `logs -f`

### Phase 3: Streaming & Attach

**Commands:**
- `paseo agent attach <id>` - Real-time output stream
- `paseo agent logs -f <id>` - Follow logs

**Implementation:**
- Use existing `subscribe()` for real-time events
- Terminal rendering for streaming output
- Signal handling (Ctrl+C to detach)

### Phase 4: Advanced Agent Commands

**Commands:**
- `paseo agent inspect <id>` - Detailed agent info (uses `getAgent()`)
- `paseo agent mode <id> <mode>` - Change mode (uses `setAgentMode()`)
- `paseo agent wait <id>` - Wait for state (uses `waitForAgentIdle()` / `waitForPermission()`)
- `paseo agent archive <id>` - Archive (uses `archiveAgent()`)

### Phase 5: Permissions

**Commands:**
- `paseo permit ls` - List pending permissions
- `paseo permit allow <agent> <req>` - Approve permission
- `paseo permit deny <agent> <req>` - Deny permission

**Implementation:**
- Uses existing `respondToPermission()` method
- Need to add `listPendingPermissions()` method to client (already in MCP server)

### Phase 6: Worktrees & Providers

**Commands:**
- `paseo worktree ls` - List worktrees (uses `getPaseoWorktreeList()`)
- `paseo worktree archive <name>` - Archive worktree (uses `archivePaseoWorktree()`)
- `paseo provider ls` - List providers
- `paseo provider models <provider>` - List models (uses `listProviderModels()`)

**Daemon Enhancements Needed:**
- Add `listProviders()` endpoint to daemon
- Add provider availability status

### Phase 7: Daemon Management

**Commands:**
- `paseo daemon start` - Start daemon
- `paseo daemon stop` - Stop daemon (uses `restartServer()` with exit flag)
- `paseo daemon restart` - Restart daemon

**Implementation:**
- Daemon spawning with proper daemonization
- PID file management in `~/.paseo/`
- Port detection and management

### Phase 8: Polish

**Features:**
- Shell completion (bash, zsh, fish)
- Global options (`--host`, `--format`, `-q`)
- Error message improvements
- Man pages / help improvements
- Version command

---

## Gap Analysis: Daemon Features Needed

The following features need to be added to the daemon and/or client before the CLI can use them:

### Already Implemented ✓

| Feature | Daemon | Client | Notes |
|---------|--------|--------|-------|
| Create agent | ✓ | ✓ | `createAgent()` |
| Delete agent | ✓ | ✓ | `deleteAgent()` |
| Archive agent | ✓ | ✓ | `archiveAgent()` |
| List agents | ✓ | ✓ | `listAgents()` |
| Send message | ✓ | ✓ | `sendAgentMessage()` |
| Cancel agent | ✓ | ✓ | `cancelAgent()` |
| Set mode | ✓ | ✓ | `setAgentMode()` |
| Wait for idle | ✓ | ✓ | `waitForAgentIdle()` |
| Respond to permission | ✓ | ✓ | `respondToPermission()` |
| List worktrees | ✓ | ✓ | `getPaseoWorktreeList()` |
| Archive worktree | ✓ | ✓ | `archivePaseoWorktree()` |
| List provider models | ✓ | ✓ | `listProviderModels()` |
| Real-time streaming | ✓ | ✓ | `subscribe()` |

### Needs Client Method (WebSocket)

| Feature | Daemon | Client | Notes |
|---------|--------|--------|-------|
| List pending permissions | ✓ (MCP) | ✗ | Add `listPendingPermissions()` - exists in MCP server |
| Get agent timeline | ✓ (state) | ✗ | Add `getAgentTimeline(id, options)` for paginated access |

### Needs Daemon Feature (WebSocket messages)

| Feature | Daemon | Client | Notes |
|---------|--------|--------|-------|
| List providers | ✗ | ✗ | Add WebSocket message `list_providers` |
| Provider availability | ✗ | ✗ | Check if claude/codex/opencode is configured |
| Daemon shutdown | ✗ | ✗ | Add WebSocket message `shutdown` |
| Daemon status | ✗ | ✗ | Add WebSocket message `daemon_status` (uptime, agent counts, etc.) |
| Health/ping | ✗ | ✗ | Add WebSocket message `ping` → `pong` for connection check |

### Export Requirements

The `DaemonClientV2` needs to be exported from `@paseo/server` for the CLI to use:

```typescript
// packages/server/package.json exports
{
  "exports": {
    "./client": "./src/client/daemon-client-v2.ts",
    "./types": "./src/types/index.ts"
  }
}
```

---

## Package Structure

```
packages/cli/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── bin/
│   └── paseo              # Entry point (#!/usr/bin/env node)
├── src/
│   ├── index.ts           # Main CLI setup
│   ├── cli.ts             # Commander program definition
│   ├── commands/
│   │   ├── agent/
│   │   │   ├── run.ts
│   │   │   ├── ps.ts
│   │   │   ├── attach.ts
│   │   │   ├── logs.ts
│   │   │   ├── send.ts
│   │   │   ├── stop.ts
│   │   │   ├── inspect.ts
│   │   │   ├── mode.ts
│   │   │   ├── wait.ts
│   │   │   └── archive.ts
│   │   ├── permit/
│   │   │   ├── ls.ts
│   │   │   ├── allow.ts
│   │   │   └── deny.ts
│   │   ├── worktree/
│   │   │   ├── ls.ts
│   │   │   └── archive.ts
│   │   ├── provider/
│   │   │   ├── ls.ts
│   │   │   └── models.ts
│   │   └── daemon/
│   │       ├── start.ts
│   │       ├── stop.ts
│   │       ├── status.ts
│   │       └── restart.ts
│   ├── output/
│   │   ├── table.ts       # Table formatting
│   │   ├── json.ts        # JSON output
│   │   ├── yaml.ts        # YAML output
│   │   └── stream.ts      # Streaming output renderer
│   ├── utils/
│   │   ├── client.ts      # Client connection helper
│   │   ├── config.ts      # Config file loading
│   │   ├── time.ts        # "2 minutes ago" formatting
│   │   └── id.ts          # Agent ID/name resolution
│   └── test-utils/
│       ├── fixtures.ts
│       ├── mock-client.ts
│       └── cli-runner.ts
└── e2e/
    └── workflows.e2e.test.ts
```

### Dependencies

```json
{
  "name": "@paseo/cli",
  "bin": {
    "paseo": "./bin/paseo"
  },
  "dependencies": {
    "@paseo/server": "workspace:*",
    "commander": "^12.0.0",
    "chalk": "^5.3.0",
    "cli-table3": "^0.6.3",
    "yaml": "^2.3.4",
    "ora": "^8.0.1"
  },
  "devDependencies": {
    "vitest": "^3.2.4",
    "tsx": "^4.6.0",
    "typescript": "^5.2.2"
  }
}
```
