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

Work out of the box once the underlying CLI is installed and authenticated.

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Anthropic's coding agent with MCP support, streaming, and deep reasoning.
- [Codex](/docs/codex). OpenAI's workspace agent with sandbox controls and optional network access.
- [OpenCode](https://opencode.ai/). Open-source coding assistant with multi-provider model support.
- [Pi](https://pi.dev). Minimal terminal-based coding agent with multi-provider LLM support.
- [Antigravity](#antigravity). Uses your installed `agy` CLI through a built-in provider plugin.
- [Muse Code](/docs/muse-code). Meta's terminal coding agent, bundled as a provider plugin.

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
