<p align="center">
  <a href="https://www.atlascloud.ai/?utm_source=github&utm_medium=link&utm_campaign=paseo">
    <img src="docs/atlas-cloud-logo.png" alt="Atlas Cloud" width="200">
  </a>
</p>

> 🎁 **[Atlas Cloud](https://www.atlascloud.ai/?utm_source=github&utm_medium=link&utm_campaign=paseo)** is the full-modal AI platform powering Paseo — 59 frontier LLMs (DeepSeek-V4, Qwen3, Kimi K2, GPT-5, Claude, Grok-4) via unified OpenAI-compatible API. [View all models](https://www.atlascloud.ai/models) · [Coding Plan](https://www.atlascloud.ai/console/coding-plan)

<details>
<summary>📋 59 models available on Atlas Cloud</summary>

| Model | Type |
|-------|------|
| deepseek-ai/deepseek-v4-pro | LLM |
| deepseek-ai/deepseek-v4-0520 | LLM |
| deepseek-ai/deepseek-v4-flash | LLM |
| deepseek-ai/deepseek-r2 | LLM |
| deepseek-ai/deepseek-r2-0528 | LLM |
| deepseek-ai/deepseek-r1-0528 | LLM |
| deepseek-ai/deepseek-r1 | LLM |
| deepseek-ai/deepseek-prover-v2 | LLM |
| moonshot-ai/kimi-k2 | LLM |
| moonshot-ai/kimi-k2-0711 | LLM |
| moonshot-ai/kimi-k1.5-long | LLM |
| qwen/qwen3-235b-a22b | LLM |
| qwen/qwen3-30b-a3b | LLM |
| qwen/qwen3-32b | LLM |
| qwen/qwq-32b | LLM |
| openai/gpt-5 | LLM |
| openai/gpt-5-mini | LLM |
| openai/gpt-4.1 | LLM |
| openai/gpt-4o | LLM |
| openai/o3 | LLM |
| openai/o4-mini | LLM |
| openai/o3-mini | LLM |
| anthropic/claude-sonnet-4-5 | LLM |
| anthropic/claude-opus-4 | LLM |
| anthropic/claude-sonnet-4 | LLM |
| anthropic/claude-haiku-4-5 | LLM |
| google/gemini-2.5-pro | LLM |
| google/gemini-2.5-flash | LLM |
| google/gemini-2.5-flash-lite | LLM |
| google/gemini-2.0-flash | LLM |
| xai/grok-4 | LLM |
| xai/grok-3 | LLM |
| xai/grok-3-mini | LLM |
| meta-llama/llama-4-scout | LLM |
| meta-llama/llama-4-maverick | LLM |
| meta-llama/llama-3.3-70b | LLM |
| cohere/command-a | LLM |
| mistral/mistral-large | LLM |
| minimax/minimax-m1 | LLM |
| 01ai/yi-lightning | LLM |
| seedance/seedance-v1-pro | Video |
| seedance/seedance-v1-pro-fast | Video |
| seedance/seedance-v1-lite | Video |
| kling/kling-v2.1-pro | Video |
| kling/kling-v2.1-standard | Video |
| kling/kling-v1.6-pro | Video |
| kling/kling-v1.6-standard | Video |
| wan2/wan2.1-t2v-turbo | Video |
| wan2/wan2.1-i2v-turbo | Video |
| veo/veo3.1-fast | Video |
| veo/veo3-fast | Video |
| veo/veo3 | Video |
| runway/gen4-turbo | Video |
| stable-diffusion/sd3.5-large | Image |
| flux/flux1.1-pro-ultra | Image |
| flux/flux1.1-pro | Image |
| ideogram/ideogram-v3 | Image |
| recraft/recraft-v3 | Image |
| minimax/hailuo-i2v-01-live | Video |
</details>

---

<p align="center">
  <img src="packages/website/public/logo.svg" width="64" height="64" alt="Paseo logo">
</p>

<h1 align="center">Paseo</h1>

<p align="center">
  <a href="https://github.com/getpaseo/paseo/stargazers">
    <img src="https://img.shields.io/github/stars/getpaseo/paseo?style=flat&logo=github" alt="GitHub stars">
  </a>
  <a href="https://github.com/getpaseo/paseo/releases">
    <img src="https://img.shields.io/github/v/release/getpaseo/paseo?style=flat&logo=github" alt="GitHub release">
  </a>
  <a href="https://x.com/moboudra">
    <img src="https://img.shields.io/badge/%40moboudra-555?logo=x" alt="X">
  </a>
  <a href="https://discord.gg/jz8T2uahpH">
    <img src="https://img.shields.io/badge/Discord-555?logo=discord" alt="Discord">
  </a>
  <a href="https://www.reddit.com/r/PaseoAI/">
    <img src="https://img.shields.io/badge/Reddit-555?logo=reddit" alt="Reddit">
  </a>
</p>

<p align="center">One interface for Claude Code, Codex, Copilot, OpenCode, and Pi agents.</p>

<p align="center">
  <img src="https://paseo.sh/hero-mockup.png" alt="Paseo app screenshot" width="100%">
</p>

<p align="center">
  <img src="https://paseo.sh/mobile-mockup.png" alt="Paseo mobile app" width="100%">
</p>

---

Run agents in parallel on your own machines. Ship from your phone or your desk.

- **Self-hosted:** Agents run on your machine with your full dev environment. Use your tools, your configs, and your skills.
- **Multi-provider:** Claude Code, Codex, Copilot, OpenCode, and Pi through the same interface. Pick the right model for each job.
- **Voice control:** Dictate tasks or talk through problems in voice mode. Hands-free when you need it.
- **Cross-device:** iOS, Android, desktop, web, and CLI. Start work at your desk, check in from your phone, script it from the terminal.
- **Privacy-first:** Paseo doesn't have any telemetry, tracking, or forced log-ins.

## Getting Started

Paseo runs a local server called the daemon that manages your coding agents. Clients like the desktop app, mobile app, web app, and CLI connect to it.

### Prerequisites

You need at least one agent CLI installed and configured with your credentials:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [Codex](https://github.com/openai/codex)
- [GitHub Copilot](https://github.com/features/copilot/cli/)
- [OpenCode](https://github.com/anomalyco/opencode)
- [Pi](https://pi.dev)

### Desktop app (recommended)

Download it from [paseo.sh/download](https://paseo.sh/download) or the [GitHub releases page](https://github.com/getpaseo/paseo/releases). Open the app and the daemon starts automatically. Nothing else to install.

To connect from your phone, scan the QR code shown in Settings.

### CLI / headless

Install the CLI and start Paseo:

```bash
npm install -g @getpaseo/cli
paseo
```

This shows a QR code in the terminal. Connect from any client. This path is useful for servers and remote machines.

For full setup and configuration, see:

- [Docs](https://paseo.sh/docs)
- [Configuration reference](https://paseo.sh/docs/configuration)

## CLI

Everything you can do in the app, you can do from the terminal.

```bash
paseo run --provider claude/opus-4.6 "implement user authentication"
paseo run --provider codex/gpt-5.4 --worktree feature-x "implement feature X"

paseo ls                           # list running agents
paseo attach abc123                # stream live output
paseo send abc123 "also add tests" # follow-up task

# run on a remote daemon
paseo --host workstation.local:6767 run "run the full test suite"
```

See the [full CLI reference](https://paseo.sh/docs/cli) for more.

## Skills

Skills teach your agent to use Paseo to orchestrate other agents.

```bash
npx skills add getpaseo/paseo
```

Then use them in any agent conversation:

- `/paseo-handoff` — hand off work between agents. I use this to plan with Claude and then handoff to Codex to implement.
- `/paseo-loop` — loop an agent against clear acceptance criteria (aka Ralph loops), optionally with a verifier.
- `/paseo-advisor` — spin up a single agent as an advisor for a second opinion, without delegating the work itself.
- `/paseo-committee` — form a committee of two contrasting agents to step back, do root cause analysis, and produce a plan.

## Development

Quick monorepo package map:

- `packages/server`: Paseo daemon (agent process orchestration, WebSocket API, MCP server)
- `packages/app`: Expo client (iOS, Android, web)
- `packages/cli`: `paseo` CLI for daemon and agent workflows
- `packages/desktop`: Electron desktop app
- `packages/relay`: Relay package for remote connectivity
- `packages/website`: Marketing site and documentation (`paseo.sh`)

Common commands:

```bash
# run all local dev services
npm run dev

# run individual surfaces
npm run dev:server
npm run dev:app
npm run dev:desktop
npm run dev:website

# build the server stack
npm run build:server

# repo-wide checks
npm run typecheck
```

## Community

- [paseo-relay](https://github.com/zenghongtu/paseo-relay) — self-hosted relay in Go

### Self-hosted relay TLS

Self-hosted relays use `ws://` unless TLS is opted in. For a relay behind nginx on 443, start the daemon with:

```bash
PASEO_RELAY_ENDPOINT=127.0.0.1:8080 \
PASEO_RELAY_PUBLIC_ENDPOINT=relay.example.com:443 \
PASEO_RELAY_USE_TLS=true \
paseo daemon start
```

Equivalent config:

```json
{
  "daemon": {
    "relay": {
      "enabled": true,
      "endpoint": "127.0.0.1:8080",
      "publicEndpoint": "relay.example.com:443",
      "useTls": true
    }
  }
}
```

Minimal nginx WebSocket proxy:

```nginx
server {
  listen 443 ssl;
  server_name relay.example.com;

  ssl_certificate /etc/letsencrypt/live/relay.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

  location /ws {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
  }
}
```

---

<p align="center">
  <a href="https://star-history.com/#getpaseo/paseo&Date">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=getpaseo/paseo&type=Date&theme=dark">
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=getpaseo/paseo&type=Date">
      <img src="https://api.star-history.com/svg?repos=getpaseo/paseo&type=Date" alt="Star history chart for getpaseo/paseo" width="600" style="max-width: 100%;">
    </picture>
  </a>
</p>

## License

AGPL-3.0
