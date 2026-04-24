<p align="center">
  <a href="https://hubcode.ai"><img src="https://hubcode.ai/logo-hubcode.png" alt="Hubcode" width="120"/></a>
</p>

<h1 align="center">@hubcode/server</h1>

<p align="center">
  Hubcode daemon: agent lifecycle, WebSocket API, and MCP server for local AI coding agents.
</p>

## What it is

The Hubcode server runs as a local daemon on your development machine. It:

- Manages the lifecycle of Claude Code, Codex, and OpenCode agents
- Exposes a WebSocket API consumed by the Hubcode mobile and desktop apps
- Serves an MCP endpoint so agents can coordinate and access shared tooling
- Persists agent state, timelines, and chat history in a local SQLite store

It is normally installed and run via the [`@hubcode/cli`](https://www.npmjs.com/package/@hubcode/cli) package.

## Install

Use the CLI:

```bash
npm install -g @hubcode/cli
hubcode onboard
```

The CLI installs `@hubcode/server` as a dependency and supervises the daemon.

## Ports

- `6767` — daemon HTTP + WebSocket API

## Documentation

Full docs: <https://hubcode.ai>

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).
