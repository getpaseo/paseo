---
title: Supported providers
description: Every coding agent Paseo can launch, natively supported providers and the ACP catalog.
nav: Supported providers
order: 21
category: Providers
---

# Supported providers

For the concept and how Paseo manages providers, see [Providers](/docs/providers). To add or configure your own, see [Custom providers](/docs/custom-providers).

## Native support

Use these providers with an installed, authenticated CLI. Some require the setup below.

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Anthropic's coding agent with MCP support, streaming, and deep reasoning.
- [Codex](/docs/codex). OpenAI's workspace agent with sandbox controls and optional network access.
- [OpenCode](https://opencode.ai/). Open-source coding assistant with multi-provider model support.
- [Pi](https://pi.dev). Minimal terminal-based coding agent with multi-provider LLM support.
- [Roder](#roder). Local coding agent through a bundled ACP provider plugin.
- [Antigravity](#antigravity). Uses your installed `agy` CLI through a built-in provider plugin.
- [Muse Code](/docs/muse-code). Meta's terminal coding agent, bundled as a provider plugin.

### Roder

Install [Roder 0.3.25 or newer](https://github.com/RoderAI/roder/releases/tag/roder/v0.3.25)
on your daemon host. This version adds ACP session controls, MCP injection and
saved-session listing. See [Roder's installation guide](https://github.com/RoderAI/roder#install-roder)
to install or upgrade the CLI.
For Codex OAuth, run `roder auth login codex` in a terminal on that host. Roder reads
its own credentials; Paseo does not sign in for you.

Enable the bundled provider in `~/.paseo/config.json`:

```json
{
  "agents": {
    "providers": {
      "roder": {
        "enabled": true,
        "command": ["roder", "acp"],
        "env": { "RODER_PROVIDER": "codex", "RODER_MODEL": "gpt-6-sol" }
      }
    }
  }
}
```

Run `paseo reload`, then choose **Roder** when starting an agent. If `roder` is
outside the daemon's PATH, use its absolute path in `command` and keep `acp` as
the second argument. Configuration and environment overrides set the initial model;
the session's model and mode selectors use the values advertised by Roder.

Roder accepts injected stdio and HTTP MCP servers, so Paseo tools can stay enabled.
MCP calls ask for permission in Default and Accept edits modes. Plan mode denies
them; Full access runs them without a permission request. SSE MCP is unsupported.

The adapter supports text and image prompts, streamed responses, tool activity,
cancellation, saved-session listing and conversation restoration after process
restart. Images require a model that supports them. Keep Roder's data directory
and the session's working directory available for restoration, and resupply MCP
servers with the same tool definitions.

Paseo's system prompt becomes persistent thread developer instructions, alongside
workspace `AGENTS.md`. Reopening preserves the original prompt; changing it requires
a new session. Other Paseo metadata, including persistence preferences and provider
options, is not applied by Roder. Only capabilities advertised by the running
binary appear in Paseo.

### Antigravity

Install the Antigravity CLI (`agy`) on your daemon host, then run `agy` once to sign in. Pick
**Antigravity** in Paseo. The provider ships with Paseo; no separate plugin install is required.

**Full access** is the only permission mode. Antigravity cannot ask for permission when another
app drives it, so Paseo starts `agy` with `--dangerously-skip-permissions`. Every tool call,
including shell commands, runs without asking. Each session starts with a warning explaining
this, including when you reopen a chat. Antigravity's own policy can still deny
an action.

After a daemon restart, Antigravity remembers the conversation, but Paseo's transcript starts
fresh because `agy` does not replay its history.

This integration uses your installed CLI and sign-in. It is not endorsed by Google.

Paseo MCP tools and steering are unavailable. Your own `agy` MCP servers still work. Attached
images are passed as file references for the agent to read.

If `agy` is outside your daemon's PATH, override its command in `~/.paseo/config.json`. Use `env`
for provider-specific environment variables:

```json
{
  "agents": {
    "providers": {
      "antigravity": {
        "command": ["/absolute/path/to/agy"],
        "env": { "EXAMPLE_VARIABLE": "value" }
      }
    }
  }
}
```

See [Custom providers](/docs/custom-providers) for command and environment overrides.

## ACP catalog

Pick any of these from the in-app provider catalog. Each entry is a one-click install of the underlying CLI.

- [Agoragentic](https://agoragentic.com), agent marketplace with 174+ AI capabilities.
- [Amp](https://github.com/tao12345666333/amp-acp), frontier coding agent.
- [Auggie CLI](https://www.augmentcode.com/), Augment Code's agent backed by their context engine.
- [Autohand Code](https://www.autohand.ai/cli/), Autohand AI's coding agent.
- [Cline](https://cline.bot/cli), autonomous coding agent.
- [Codebuddy Code](https://www.codebuddy.cn/cli/), Tencent Cloud's coding tool.
- [CodeWhale](https://codewhale.net/), terminal coding agent for DeepSeek V4 and open models.
- [Cortex Code](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli), Snowflake's coding agent.
- [Corust Agent](https://github.com/Corust-ai/corust-agent-release/releases), Rust-focused coding partner.
- [crow-cli](https://crow-ai.dev/), minimal ACP-native coding agent.
- [Cursor](https://cursor.com/docs/cli/overview), Cursor's coding agent.
- [DeepAgents](https://docs.langchain.com/oss/javascript/deepagents/overview), LangChain-powered coding agent.
- [DimCode](https://dimcode.dev/docs/acp.html), multi-model coding agent.
- [Dirac](https://dirac.run), open-source agent with hash-anchored parallel edits.
- [Factory Droid](https://factory.ai/product/cli), Factory AI's coding agent.
- [fast-agent](https://fast-agent.ai/acp/), multi-provider coding agent.
- [Gajae Code](https://gajae-code.com), subscription-based coding agent with plan-before-mutation workflows.
- [Gemini CLI](https://geminicli.com), Google's official Gemini CLI.
- [GitHub Copilot](https://github.com/features/copilot/cli/), GitHub's AI pair programmer via ACP.
- [GLM Agent](https://github.com/stefandevo/glm-acp-agent), Zhipu AI's GLM coding agent.
- [goose](https://block.github.io/goose/), Block's local open-source AI agent.
- [Grok](https://docs.x.ai/build/overview), xAI's Grok Build agentic coding CLI.
- [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp), Nous Research's self-improving agent.
- [Hoplite](#hoplite), cloud coding agent through its local ACP bridge.
- [Junie](https://junie.jetbrains.com/docs/junie-cli-acp.html), JetBrains' coding agent.
- [Kilo Code](https://kilo.ai/docs/code-with-ai/platforms/cli), open-source coding agent.
- [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code), Moonshot AI's coding assistant.
- [Minion Code](https://github.com/femto/minion-code), Minion-framework coding agent.
- [Mistral Vibe](https://github.com/mistralai/mistral-vibe), Mistral's open-source CLI assistant.
- [Nova](https://www.compassap.ai/portfolio/nova.html), Compass AI's software engineer.
- [Poolside](https://docs.poolside.ai/cli/pool), Poolside's coding agent.
- [Qoder](https://qoder.com), agentic coding assistant.
- [Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/users/overview), Alibaba's Qwen coding assistant.
- [siGit Code](https://github.com/getsigit/sigit), local-first coding agent with optional on-device LLM.
- [Stakpak](https://stakpak.dev/), Rust-based DevOps agent.
- [TRAE CLI](https://docs.trae.cn/cli_get-started-with-trae-cli), ByteDance's official TRAE coding agent.
- [VT Code](https://github.com/vinhnx/VTCode/blob/main/docs/guides/zed-acp.md), open-source multi-provider coding agent.

The in-app catalog is the canonical, version-pinned source. Anything not listed here can still be added manually, see [Custom providers](/docs/custom-providers).

### Hoplite

Install the [Hoplite CLI](https://hoplite.sh/docs/cli) on your daemon host and run
`hoplite login`. In **Settings → Hosts → your host → Providers**, find **Hoplite**
in the catalog and choose **Add**. Paseo launches `hoplite acp` through the generic ACP adapter.

Hoplite runs the agent in a cloud workspace. Open a repository linked to a Hoplite project,
or set `agents.providers.hoplite.env.HOPLITE_PROJECT_ID` to use one project everywhere.
Without a linked repository or pinned project, discovery reports `No Hoplite project`.
Your local files and Paseo's loopback MCP tools are not available in that cloud workspace.

See [Hoplite's ACP guide](https://hoplite.sh/docs/cli/acp) for authentication and project setup.
Use a [command override](/docs/custom-providers) if `hoplite` is outside your daemon's PATH;
keep `acp` in the arguments.
