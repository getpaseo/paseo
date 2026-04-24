<p align="center">
  <a href="https://hubcode.ai"><img src="https://hubcode.ai/logo-hubcode.png" alt="Hubcode" width="120"/></a>
</p>

<h1 align="center">@hubcode/cli</h1>

<p align="center">
  Control Claude Code, Codex, and OpenCode agents from your terminal — part of <a href="https://hubcode.ai">Hubcode</a>.
</p>

## Install

```bash
npm install -g @hubcode/cli
```

## Quick start

```bash
hubcode onboard            # first-time setup: start the daemon and print pairing instructions
hubcode ls -a              # list all agents
hubcode run "fix the login bug"   # create and start an agent with a task
hubcode attach <id>        # attach to a running agent's output stream
hubcode logs <id>          # view agent activity/timeline
hubcode wait <id>          # wait for an agent to become idle
```

## Commands

| Command | Purpose |
|---|---|
| `onboard` | First-time setup, starts the daemon, prints pairing instructions |
| `start` / `status` / `restart` | Manage the local Hubcode daemon |
| `ls` | List agents |
| `run` / `send` / `stop` / `delete` / `archive` | Agent lifecycle |
| `attach` / `logs` / `inspect` / `wait` | Observe an agent |
| `agent` / `daemon` / `chat` / `terminal` / `loop` / `schedule` | Advanced operations |
| `permit` / `provider` / `mcp` / `skills` / `library` | Manage providers, MCP servers, skills |
| `speech` / `worktree` | Speech and worktree utilities |

Run `hubcode <command> --help` for details on any command.

## Documentation

Full docs: <https://hubcode.ai>

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).
