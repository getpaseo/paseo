<p align="center">
  <img src="packages/website/public/logo.svg" width="64" height="64" alt="PandaOS logo">
</p>

<h1 align="center">PandaOS</h1>

<p align="center">
  <a href="https://github.com/marushan49/pandaos/releases">
    <img src="https://img.shields.io/github/v/release/marushan49/pandaos?include_prereleases&style=flat&logo=github" alt="Fork release">
  </a>
  <a href="https://github.com/getpaseo/paseo">
    <img src="https://img.shields.io/badge/upstream-getpaseo%2Fpaseo-555?logo=github" alt="Upstream">
  </a>
</p>

<p align="center">One interface for Claude Code, Codex, Copilot, OpenCode, and Pi agents, with a testing engine and Jev decisions built in.</p>

PandaOS is a fork of [Paseo](https://github.com/getpaseo/paseo). The repository, the `paseo` CLI and the `@getpaseo/*` packages keep their upstream names so merging upstream stays cheap. It tracks upstream releases (currently 0.9.1) and adds features that make agents cheaper to run and faster to verify. Everything upstream does still works the same way; the additions below are on top.

## What PandaOS adds

| Area                      | What you get                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Testing engine**        | `browser_test` runs UI and end-to-end checks inside the daemon and returns only the verdict: pass or fail, checks, log counts, and an evidence reference. Scripted steps cost no model tokens; `goal` steps hand the unscriptable part to Jev. Passing ad-hoc runs can be saved as recipes in `paseo.json` (`saveAs`). Every provider gets a rule to use it first for tests, and competing browser MCP servers (Playwright, Puppeteer, Chrome DevTools) are hidden from Paseo's Claude, Codex, and OpenCode sessions. See [browser docs](public-docs/browser.md#testing-engine). |
| **System One (Jev)**      | `system_one_decide` gives every agent fast typed decisions. `browser_goal` drives a browser tab with Jev. Keys are checked before they are saved and fall through to the next configured key if TypeSafe rejects one. See [System One docs](public-docs/system-one.md).                                                                                                                                                                                                                                                                                                          |
| **Model routing**         | Before each turn Jev picks the cheapest sufficient model and thinking depth from a per-provider ladder in `daemon.systemOne.routing`, for Claude, Codex, OpenCode, and any other provider you list. A model you pick by hand wins for that session.                                                                                                                                                                                                                                                                                                                              |
| **Daemon-hosted browser** | Agent browser tabs run on the daemon host with persistent profiles, and mirror into the desktop, web, and mobile apps. Import cookies from Chrome, Brave, Edge, Arc, Vivaldi, Chromium, or Firefox under **Settings → Browser**, and set a start page for new tabs.                                                                                                                                                                                                                                                                                                              |
| **Pull request sets**     | The sidebar groups a workspace's pull requests and lets you attach one by number. The daemon tries each GitHub account in `PASEO_GH_CONFIG_DIRS` until one can see the repository.                                                                                                                                                                                                                                                                                                                                                                                               |
| **Transcript copy**       | Copy a whole agent transcript as Markdown or JSON from the tab menu.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Rolling Android APK**   | Every push to `main` that touches the app rebuilds an arm64 APK at a fixed link.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Install

### Desktop app

Download the Linux `.deb` or macOS `.dmg` from the [fork releases](https://github.com/marushan49/pandaos/releases). The app updates itself from this fork's releases, not from upstream.

On macOS PandaOS is ad-hoc signed. After copying `PandaOS.app` into `/Applications`, run:

```bash
xattr -cr /Applications/PandaOS.app
```

### Android

Install the rolling build of `main`:

https://github.com/marushan49/pandaos/releases/download/android-latest/paseo-android-latest.apk

### Daemon from source

The fork does not publish npm packages; `npm install -g @getpaseo/cli` installs upstream Paseo. Run the daemon from a checkout instead:

```bash
git clone https://github.com/marushan49/pandaos.git
cd pandaos
npm ci
npm run build:server
packages/cli/bin/paseo daemon run
```

You need at least one agent CLI installed and signed in: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), [GitHub Copilot](https://github.com/features/copilot/cli/), [OpenCode](https://github.com/anomalyco/opencode), or [Pi](https://pi.dev). To connect from your phone, open **Settings → your host → Pair Device**.

Upstream's [docs](https://paseo.sh/docs), [connectivity guide](https://paseo.sh/docs/connectivity), and [configuration reference](https://paseo.sh/docs/configuration) apply to the fork as well.

## Plugins

Add themes, workspace panels, commands, settings screens, and coding-agent providers with trusted TypeScript plugins. Install from npm, Git, or a local directory with `paseo plugin install <source>`. Start with the [plugin quickstart](https://paseo.sh/docs/plugins). Plugins run with access to your daemon machine and inside connected clients; install only code you trust.

## Staying current with upstream

Upstream releases are merged into `main` as they ship. Remote `origin` points at `getpaseo/paseo` and is fetch-only; `marushan49` is the fork:

```bash
git fetch origin --tags
git merge v<version>
```

## CLI

Everything you can do in the app, you can do from the terminal.

```bash
paseo run --provider claude/opus-4.6 "implement user authentication"
paseo run --provider codex/gpt-5.5 --worktree feature-x "implement feature X"

paseo ls                           # list running agents
paseo attach abc123                # stream live output
paseo send abc123 "also add tests" # follow-up task

# run on a remote daemon; --cwd is a path on that host
paseo run --host workstation.local:6767 --cwd /workspace "run the full test suite"
```

See the [full CLI reference](https://paseo.sh/docs/cli) for more.

## TypeScript SDK

Build issue integrations, dashboards, and orchestration services with `@getpaseo/client`:

```ts
import { createPaseoClient } from "@getpaseo/client";

const client = createPaseoClient({ url: "ws://127.0.0.1:6767/ws" });
await client.connect();

const agent = await client.agents.create({
  config: { provider: "codex/gpt-5.5" },
  cwd: "/Users/me/dev/storefront",
  prompt: "Review the current diff and name the riskiest change.",
});

const result = await agent.waitForFinish();
console.log(result.lastMessage);

await client.close();
```

See the [SDK quickstart](https://paseo.sh/docs/sdk/quickstart), [recipes](https://paseo.sh/docs/sdk/recipes), and [API reference](https://paseo.sh/docs/sdk/reference).

## Skills

Skills teach your agent to use PandaOS to orchestrate other agents.

```bash
npx skills add marushan49/pandaos
```

Then use them in any agent conversation:

- `/paseo-handoff` — hand off work between agents. I use this to plan with Claude and then handoff to Codex to implement.
- `/paseo-advisor` — spin up a single agent as an advisor for a second opinion, without delegating the work itself.
- `/paseo-committee` — form a committee of two contrasting agents to step back, do root cause analysis, and produce a plan.

## Development

Quick monorepo package map:

- `packages/server`: PandaOS daemon (agent process orchestration, WebSocket API, MCP server)
- `packages/app`: Expo client (iOS, Android, web)
- `packages/cli`: `paseo` CLI for daemon and agent workflows
- `packages/desktop`: Electron desktop app
- `packages/relay`: Relay transport and encryption used by the daemon and clients
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

## Sponsors

Upstream Paseo is built by one person and funded by the people who use it. Support the work on [GitHub Sponsors](https://github.com/sponsors/boudra). Companies can [sponsor Paseo](https://paseo.sh/sponsor#spot) monthly and have their logo shown here and on the paseo.sh homepage.

<!-- Sponsor logos go here, in the same order as packages/website/src/data/sponsors.ts -->

## Related projects

- [getpaseo/paseo-relay](https://github.com/getpaseo/paseo-relay) — official distributed relay, written in Elixir
- [paseo-vscode](https://marketplace.visualstudio.com/items?itemName=hinnes.paseo-vscode) — VS Code extension

## License

Apache-2.0
