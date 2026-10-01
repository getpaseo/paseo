---
title: CLI reference
description: "Paseo CLI reference: manage projects, workspaces, agents, plugins, scripts, schedules, daemons, and permissions from your terminal."
nav: CLI reference
order: 35
category: Orchestration
---

# CLI reference

The Paseo CLI lets you manage agents from your terminal. It's the same interface exposed by the daemon's API, so anything you can do in the app you can do from the command line.

> **Agent orchestration:** You can tell coding agents to use the Paseo CLI to spawn and manage other agents. Paseo recognizes the calling agent, so CLI-created workers get the same workspace and parent defaults as MCP-created workers.

## Quick reference

```bash
pandaos run "fix the tests"            # Start an agent
pandaos ls                             # List running agents
pandaos attach <id>                    # Stream agent output
pandaos send <id> "also fix linting"   # Send follow-up task
pandaos logs <id>                      # View agent timeline
pandaos stop <id>                      # Stop an agent
```

## Provider diagnostics

Ask the daemon to inspect the provider environment it actually uses:

```bash
pandaos provider diagnostic claude
pandaos provider diagnostic codex --json
pandaos --host devbox:6767 provider diagnostic opencode
```

The diagnostic includes the configured command, daemon `PATH` and shell, matching binaries, resolved path, version, model count, and provider status. Use the global `--host` option for a remote daemon. This is the same diagnostic shown under **Settings → your host → Providers → provider → Diagnostic**.

## Running agents

Use `pandaos run` to start a new agent with a task:

```bash
pandaos run "implement user authentication"
pandaos run --provider codex "refactor the API layer"
pandaos run --background "run the focused test suite"
pandaos run --new-workspace worktree --worktree-mode branch-off --new-branch feature/x --base origin/main "implement feature X"
pandaos run --workspace <workspace-id> "review the current diff"
pandaos run --output-schema schema.json "extract release notes"
pandaos run --output-schema '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}' "summarize release notes"
```

From a human shell, a bare `pandaos run` creates a new local workspace for the current directory. Use `--workspace <id>` to add the agent to an existing workspace, or `--new-workspace local|worktree` to explicitly create a separate workspace for the run.

Worktree creation accepts `--worktree-mode branch-off|checkout-branch|checkout-pr` plus the matching `--new-branch`/`--base`, `--branch`, or `--pr-number`/`--forge` options. Use `--worktree-slug` to choose the managed directory slug.

When an existing Paseo agent runs the same command, Paseo recognizes it through `PASEO_AGENT_ID`. Without explicit placement, the new agent becomes its subagent in the same workspace. `--workspace` can place that subagent elsewhere without changing its parent.

Use `--output-schema` to return only matching JSON output. You can pass a schema file path or an inline JSON schema object. This mode cannot be used with `--background`.

By default, `pandaos run` waits for completion. Use `--background` to return immediately while the agent keeps running.

## Projects

Register the current directory as a project, then list the projects known to the daemon:

```bash
cd ~/dev/my-app
pandaos project create
pandaos project ls
```

Use the project ID from `pandaos project ls` to rename, reset, or delete a project:

```bash
pandaos project rename <project-id> "My app"
pandaos project rename <project-id> --reset
pandaos project delete <project-id>
```

`--reset` restores the name derived from the project directory. Deleting a project archives its active workspaces and removes the project from Paseo. It does not delete the project directory.

For a local daemon, `pandaos project create [path]` defaults to the current directory and resolves relative paths on the CLI machine. When you use the global `--host` option or `PASEO_HOST`, provide a path that the target daemon can access:

```bash
pandaos --host devbox:6767 project create /srv/repos/api
```

The remote daemon interprets that path on its own machine. See [Workspaces](/docs/workspaces) for how projects group working directories and sessions.

## Workspaces

Create a workspace independently when you want to prepare its files before starting an agent:

```bash
pandaos workspace create --isolation local --path ~/dev/my-app --title main

pandaos workspace create \
  --isolation worktree \
  --path ~/dev/my-app \
  --mode branch-off \
  --new-branch feature/auth \
  --worktree-slug feature-auth \
  --base origin/main

pandaos workspace create \
  --isolation worktree \
  --path ~/dev/my-app \
  --mode checkout-branch \
  --branch feature/existing \
  --worktree-slug existing-copy

pandaos workspace create \
  --isolation worktree \
  --path ~/dev/my-app \
  --mode checkout-pr \
  --pr-number 2186
```

Then list, use, rename, or archive it:

```bash
pandaos workspace ls
pandaos run --workspace <workspace-id> "implement authentication"
pandaos workspace rename <workspace-id> "Auth rework"
pandaos workspace rename <workspace-id> --reset   # back to the branch or directory name
pandaos workspace archive <workspace-id>
```

Add `--forge <name>` to PR checkout when Paseo cannot infer the forge from the source checkout. See [Git worktrees](/docs/worktrees) for setup hooks and services.

## Terminals

Use the workspace ID when multiple workspaces share a directory:

```bash
pandaos terminal create --workspace <workspace-id> --name Development
pandaos terminal ls --workspace <workspace-id> --json
pandaos terminal send-keys <terminal-id> -l "echo ready"
pandaos terminal send-keys <terminal-id> Enter
pandaos terminal capture <terminal-id>
pandaos terminal kill <terminal-id>
```

Creation defaults to the workspace directory. Add `--cwd <absolute-path>` to change the process directory while keeping that workspace as the owner. Unknown and archived workspace IDs fail.

Without `--workspace`, creation opens the project at `--cwd` or the current directory and reuses its oldest active workspace. Listing without `--workspace` filters by `--cwd` or the current directory and can include multiple workspaces. `ls --all` lists every terminal on the host and cannot be combined with directory or workspace filters.

Create and list results include `id`, `name`, `cwd`, and `workspaceId`. Use `--json` for structured output and the global `--host` option to target another daemon. These commands require a host that supports the [workspace terminal API](/docs/sdk/reference#clientterminals); older hosts return an update message.

## Workspace scripts

List, start, and stop the scripts configured in a workspace's `paseo.json`:

```bash
pandaos script ls
pandaos script start web
pandaos script stop web
```

By default, Paseo selects the workspace whose directory is the current directory. Pass `--cwd <path>` to select a different directory, or `--workspace <workspace-id>` when a directory has multiple workspaces. Use the global `--host` option to target another daemon. These commands also accept standard output options such as `--json`.

The output includes each script's lifecycle and supervised terminal ID. Services also include their assigned port, proxy URL, and health. See [Git worktrees](/docs/worktrees#scripts-and-services) for `paseo.json` configuration.

## Plugins

> **Trust every plugin you add.** `pandaos plugin add` and `pandaos plugin install` mean “I trust this codebase.” Plugin server code and Git preparation commands run unsandboxed with the daemon user's access on the daemon host; client contributions run inside Paseo. Dependencies and future updates are part of that decision. With the global `--host` option, commands run on the remote daemon host.

Create and manage trusted plugins on a daemon:

```bash
pandaos plugin init /absolute/path/to/plugin
pandaos plugin install /absolute/path/to/plugin
pandaos plugin add owner/repository
pandaos plugin add https://gitlab.com/group/repository.git --ref main
pandaos plugin add owner/monorepo:plugins/review
pandaos plugin ls [id]
pandaos plugin update my-plugin
pandaos plugin update --all
pandaos plugin reload my-plugin
pandaos plugin logs my-plugin
pandaos plugin disable my-plugin
pandaos plugin enable my-plugin
pandaos plugin remove my-plugin
```

GitHub shorthand checks an existing host directory first. Append `:<directory>` for a plugin in a
monorepo. `pandaos plugin ls [id]` does not contact the remote. `pandaos plugin logs <id>` returns the
plugin's recent daemon-side stdout and stderr. Add `--json` for structured entries, or run
`pandaos --host <target> plugin logs <id>` for another daemon. See the
[Plugin reference](/docs/plugins/reference) for installation, trust, lifecycle, and log-retention
behavior.

## Listing agents

```bash
pandaos ls                    # Non-archived agents in active workspaces
pandaos ls -a                 # Also include archived agents
pandaos ls -g                 # Non-archived agents across all workspaces
pandaos ls -a -g --json       # All agents, including archived, as JSON
```

## Streaming output

Use `pandaos attach` to stream an agent's output in real-time:

```bash
pandaos attach abc123   # Attach to agent (Ctrl+C to detach)
```

Agent IDs can be shortened, `abc` works if it's unambiguous.

## Sending messages

Send follow-up tasks to a running or idle agent:

Use the recipient's agent ID from `pandaos ls`, or [copy it from the agent's tab](/docs/orchestration-workflows#send-a-prompt-to-another-agent).

```bash
pandaos send <id> "now run the tests"
pandaos send <id> --image screenshot.png "what's wrong here?"
pandaos send <id> --no-wait "queue this task"
```

## Viewing logs

```bash
pandaos logs <id>                  # Full timeline
pandaos logs <id> -f               # Follow (streaming)
pandaos logs <id> --tail 10        # Last 10 entries
pandaos logs <id> --filter tools   # Only tool calls
```

## Waiting for agents

Block until an agent finishes its current task:

```bash
pandaos wait <id>
pandaos wait <id> --timeout 60   # 60 second timeout
```

Useful in scripts or when one agent needs to wait for another.

## Schedules

Run an agent on a cron schedule. The CLI also accepts simple cadence presets and compiles them to cron. See [Schedules from the CLI](/docs/schedules-cli) for the full reference.

```bash
pandaos schedule create --every 30m --cwd ~/dev/my-app "Continue the refactor and leave a note."
pandaos schedule ls
pandaos schedule pause <id>
```

## Permissions

Agents may request permission for certain actions. Manage these from the CLI:

```bash
pandaos permit ls                # List pending requests
pandaos permit allow <id>        # Allow all pending for agent
pandaos permit deny <id> --all   # Deny all pending
```

## Agent modes

Change an agent's operational mode (provider-specific):

```bash
pandaos agent mode <id> --list   # Show available modes
pandaos agent mode <id> bypass   # Set bypass mode
pandaos agent mode <id> plan     # Set plan mode
pandaos agent detach <id>        # Make a subagent top-level
```

Detaching is an explicit lifecycle action, not a creation flag. The agent keeps running; only its relationship to its parent changes.

## Daemon management

Define an instance once, then start its saved configuration:

```bash
pandaos daemon config set daemon.listen 127.0.0.1:6799 --home ~/paseo-test
pandaos daemon config set daemon.relay.enabled false --home ~/paseo-test
pandaos daemon start --home ~/paseo-test
pandaos project ls --home ~/paseo-test
pandaos daemon restart --home ~/paseo-test
pandaos daemon stop --home ~/paseo-test
```

`start` runs in the background and reports the actual listening address and supervisor PID. It accepts only home selection and `--timeout <seconds>` (default 600). If waiting times out, the supervisor remains running: use the printed status, log, and stop instructions. A worker that exits before becoming ready makes startup fail.

`restart` requests a replacement worker from the existing supervisor. It rereads the file and retains the supervisor's original environment and arguments. Success confirms a different ready worker, following a changed address for a home target. It never starts a stopped daemon or refreshes the supervisor binary. A timeout reports whether the request was acknowledged; it does not prove why reconnection failed.

`stop --home` waits for that local supervisor to exit. On POSIX it signals the supervisor without contacting a TCP endpoint. On Windows it uses the ready daemon's shutdown RPC; an unbound instance requires explicit `--force`. `--force` permits forced process-tree cleanup after the graceful timeout (default 15 seconds). `stop --host` only reports **shutdown requested**; remote process exit is not verified. A service manager may start another instance after the captured supervisor exits.

`status` separates local supervisor state, its published endpoint, the configured address, and RPC reachability. A stopped home is never probed at its configured address. An unbound live supervisor is **not ready**. If an authenticated local connection remains open but status details time out, the result stays `reachable` with a note explaining the unavailable details. Worker and provider fields are omitted. An explicit `--host` query still fails when its status request fails.

`reload` validates the file, applies runtime-safe changes, and reports `appliedPaths`, `restartRequiredPaths`, and `overrideControlledPaths`. It never implicitly restarts. Use `--json` or `--format yaml` for structured results. An older host lacking the capability reports that it needs an update.

The root aliases `start`, `status`, `restart`, `reload`, and `pair` use the same commands as `daemon`. Root `run` and `stop` remain agent operations.

### Foreground deployments and migration

Use environment overrides with the foreground deployment command:

```bash
PASEO_LISTEN=127.0.0.1:6799 PASEO_RELAY_ENABLED=false pandaos daemon run --home ~/paseo-test
```

It stays attached until the supervisor exits or you cancel, without a readiness timeout. Worker restart retains these launch inputs. Stop and relaunch the deployment to change them. If the home already has a live supervisor, `run` returns `already_running` without owning or launching a foreground process.

Managed `start` ignores inherited daemon-setting overrides, including `PORT`, `PASEO_LISTEN`, relay, voice, and web UI settings. It preserves provider credentials and executable/runtime controls. `start --foreground` is removed; use `daemon run`. Former start/restart configuration flags such as `--port`, `--no-relay`, and `--web-ui` fail before side effects, with the corresponding `config set` migration. See [configuration edits](/docs/configuration#apply-changes).

### Select one daemon

Every daemon-connected CLI command accepts global `--home` or `--host`, before or after the command. A home selects a local supervisor's published endpoint; a host selects an explicit endpoint. There is no configured-address or default-port fallback.

| Selectors                                  | Result                                                 |
| ------------------------------------------ | ------------------------------------------------------ |
| `--home`                                   | That local home, overriding both environment selectors |
| `--host`                                   | That endpoint, overriding both environment selectors   |
| Both flags, or conflicting duplicate flags | `TARGET_AMBIGUOUS`                                     |
| Only `PASEO_HOME` or only `PASEO_HOST`     | The corresponding target                               |
| Both environment selectors, without a flag | `TARGET_AMBIGUOUS`                                     |
| Neither                                    | Default local home, `~/.paseo`                         |

Local-only `start`, `daemon run`, `config`, `onboard`, and `set-password` reject explicit `--host` and ignore `PASEO_HOST`. Endpoint operations retain TCP, Unix socket, Windows pipe, SSH, and pairing-offer transports. A host-side CLI controlling a container needs `--host` or `PASEO_HOST`.

## Hub

```bash
pandaos hub login [url]          # Approve and store organization-scoped CLI access
pandaos hub init                 # Create and optionally deploy a starter trigger here
pandaos hub connect [url]        # Enroll this daemon using CLI access
pandaos hub projects             # List legacy projects in the authenticated organization
pandaos hub status               # Show the current Hub relationship
pandaos hub disconnect           # End it
pandaos hub deploy               # Validate and install .paseo/triggers/*.yml
pandaos hub deploy --dry-run     # Validate without installing
pandaos hub deploy -p <project>   # Deploy an existing legacy project bundle
pandaos hub logout               # Remove the active stored CLI login
```

Run deploy from the repository root. By default it reads every direct `.paseo/triggers/*.yml` file in deterministic path order. It validates all triggers before installing them one at a time. If an installation fails after earlier ones succeeded, the error lists the installed files. `--dry-run` only validates; it does not create or activate revisions.

Pass `-p, --project <slug>` for an existing legacy bundle: `.paseo/hub.yml`, direct `.paseo/workflows/*.yml` files, and referenced workflow partials. See [Deploy from the CLI](/docs/hub/configuration#deploy-from-the-cli).

`login` opens the Hub approval page and stores a durable organization-scoped CLI credential under `PASEO_HOME`. In an interactive terminal it offers to connect this daemon, then separately asks whether to allow Hub automations to run agents. Connection defaults to yes; execution permission defaults to no. It then links to Hub's **Triggers** page and prints `pandaos hub init` for setup as code. `--json` and non-TTY login remain login-only and never prompt. The stored login is separate from the daemon relationship created by `connect`.

`init` requires a TTY. It signs in and connects the daemon as needed, then lists the organization's app connections that can back a starter trigger. One usable connection is selected automatically; with several, you choose a **Trigger connection**. If none is ready, setup sends you to **Hub → Apps** and stops before selecting an agent or writing files.

Setup asks which agent provider, model, and mode to run. Providers must be enabled and expose both a selectable model and an execution mode. Suggested model and mode entries are the daemon's defaults; a mode is still selected explicitly when there is no default. Setup then asks for the identity allowed to trigger the bot: a GitHub username, Slack member ID, or Discord user ID. It validates the trigger, writes `.paseo/triggers/<provider>-help.yml`, and asks whether to deploy. Replacing that file requires confirmation; existing legacy bundles and other trigger files are preserved. See the [generated starter trigger](/docs/hub/configuration#generated-starter-trigger).

Interactive logout checks the same-origin daemon relationship and asks whether to disconnect before deleting the login. Declining removes only the login. JSON and noninteractive logout never prompt or disconnect implicitly; `--disconnect-daemon` is the explicit automation path, and `--force` applies to that daemon disconnection. If a requested disconnection fails, the login is preserved.

Every command resolves and normalizes its destination before Hub or daemon work. Origin precedence is an explicit command origin or `--hub`, then `PASEO_HUB_URL`, then the active stored login origin, then the hosted default `https://hub.paseo.sh`. The hosted default never overrides an active login. Credential precedence is `--api-key <secret>`, then `PASEO_HUB_API_KEY`, then a stored login for the exact resolved origin. A stored credential is never sent to a different origin. API keys passed through flags or the environment are not stored.

Human output reports the resolved destination before each action. JSON output keeps stdout machine-readable and includes the normalized Hub origin. Bundle diagnostics identify paths without printing configuration contents or credentials.

See [Daemons in Hub](/docs/hub/daemons), [Hub configuration](/docs/hub/configuration), and the [Hub public API](/docs/hub/api).

## Connecting to a remote daemon

The global `--host` option accepts either a local target (`host:port`, a unix socket, or a Windows pipe) or a pairing offer URL, the same `https://app.paseo.sh/#offer=...` link the mobile app uses for QR pairing. With an offer URL the CLI connects through the Paseo relay with end-to-end encryption, so you can drive a daemon on another machine without exposing it to the network.

Get an offer URL from the daemon you want to control:

```bash
pandaos daemon pair          # prints the QR and link when relay is enabled
pandaos daemon pair --relay  # enables relay without prompting
pandaos daemon pair --json   # structured output; never prompts
```

Relay is off for new installations. A disabled relay returns a `RELAY_DISABLED` error; pass `--relay` to provide explicit consent. For a stopped home, pairing is labelled offline; `--relay` saves relay enablement and the offer includes a start instruction. A live but unreachable home never falls back to an offline identity. Relay pairing is end-to-end encrypted. See [Security](/docs/security).

Use it from anywhere:

```bash
pandaos --host 'https://app.paseo.sh/#offer=eyJ2IjoyLC...' ls
pandaos --host "$OFFER_URL" run "fix the failing tests"
```

You can also set it once via `PASEO_HOST` instead of passing `--host` on every command. An explicit flag overrides the environment variable.

## Team workflows

Track a team started by a boss agent with `team_start`:

```bash
pandaos team ls
pandaos team inspect <team-id> --json
pandaos team events <team-id> --after <commit> --json
pandaos team message <team-id> "Clarified acceptance criterion"
```

`inspect` returns work item phases, agent bindings and the current team commit; `--json` also includes event history.
`events --after` reads once and returns events newer than that commit. Use `--host` to select the
same daemon as the Teams screen. Team IDs are exact; these commands do not start agents.

## Multi-agent workflows

The CLI is designed to be used by agents themselves. You can instruct an agent to spawn sub-agents for parallel work:

```bash
# Agent A spawns Agent B and waits for it
agent_id=$(pandaos run --background --quiet --title api-agent "implement the API")
pandaos wait "$agent_id"
pandaos logs "$agent_id" --tail 5
```

Because Agent A's ID is present in the environment, Agent B is created as its subagent in the same workspace unless `--workspace` is specified.

Simple implement + verify loop:

```bash
# Requires jq
while true; do
  pandaos run --provider codex "make the tests pass" >/dev/null

  verdict=$(pandaos run --provider claude --output-schema '{"type":"object","properties":{"criteria_met":{"type":"boolean"}},"required":["criteria_met"],"additionalProperties":false}' "ensure tests all pass")
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
pandaos ls --json                # JSON output
pandaos ls --format yaml         # YAML output
pandaos ls -q                    # IDs only (quiet)
```

## Global options

- `--host <target>`, connect to a different daemon (`host:port`, unix socket, or `https://app.paseo.sh/#offer=...` for relay). See [Connecting to a remote daemon](#connecting-to-a-remote-daemon).
- `--json`, JSON output
- `-q, --quiet`, minimal output
- `--no-color`, disable colors
