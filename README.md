<p align="center">
  <img src="packages/website/public/logo.svg" width="64" height="64" alt="Paseo logo">
</p>

<h1 align="center">Paseo</h1>

<p align="center">Manage coding agents from your phone and desktop.</p>

<p align="center">
  <img src="https://paseo.sh/paseo-mockup.png" alt="Paseo app screenshot" width="100%">
</p>

---

> [!WARNING]
> **Early development** — Features may break or change without notice. Use at your own risk.

Paseo is a self-hosted daemon for Claude Code, Codex, and OpenCode. Agents run on your machine with your full dev environment. Connect from phone, desktop, or web.

## Getting Started

```bash
npm install -g @getpaseo/cli
paseo
```

Then open the app and connect to your daemon.

For full setup and configuration, see:
- [Docs](https://paseo.sh/docs)
- [Configuration reference](https://paseo.sh/docs/configuration)

## Development

Quick monorepo package map:
- `packages/server`: Paseo daemon (agent process orchestration, WebSocket API, MCP server)
- `packages/app`: Expo client (iOS, Android, web)
- `packages/cli`: `paseo` CLI for daemon and agent workflows
- `packages/desktop`: Tauri desktop app
- `packages/relay`: Relay package for remote connectivity
- `packages/website`: Marketing site and documentation (`paseo.sh`)

Common commands:

```bash
# run all local dev services
npm run dev

# run individual surfaces
npm run dev:server
npm run dev:app
npm run dev:website

# repo-wide checks
npm run typecheck
```

## License

MIT
