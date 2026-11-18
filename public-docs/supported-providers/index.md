---
title: Supported providers
description: Every coding agent Paseo can launch, with native support or through ACP.
nav: Supported providers
order: 21
category: Providers
---

# Supported providers

Paseo runs coding agents that you install and sign in to on your daemon host. For how Paseo manages providers, see [Providers](/docs/providers). To add an agent that is not listed here, see [Custom providers](/docs/custom-providers).

## Native support

Paseo ships an integration for each of these agents.

- [Antigravity](/docs/supported-providers/antigravity), runs through your installed `agy` CLI.
- [Claude Code](/docs/supported-providers/claude-code), Anthropic's coding agent.
- [Codex](/docs/supported-providers/codex), OpenAI's workspace agent.
- [fx](/docs/supported-providers/fx), Vercel Labs' coding agent.
- [GitHub Copilot](/docs/supported-providers/github-copilot), GitHub's AI pair programmer.
- [Hoplite](/docs/supported-providers/hoplite), cloud coding agent.
- [Muse Code](/docs/supported-providers/muse-code), Meta's terminal coding agent.
- [Oh My Pi](/docs/supported-providers/omp), multi-provider coding agent.
- [OpenCode](/docs/supported-providers/opencode), open-source coding assistant.
- [Pi](/docs/supported-providers/pi), minimal terminal coding agent.

## More agents through ACP

Paseo runs any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP). The in-app catalog lists the agents below.

To add one, open **Settings → Hosts → your host → Providers**, find the agent in the catalog, and choose **Add**. Entries that launch through `npx` or `uvx` need only that tool on your daemon host. For the other entries, install the CLI of the agent first. Each entry links to its install instructions.

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
- [Devin CLI](https://cli.devin.ai/docs), Cognition's Devin for the terminal.
- [DimCode](https://dimcode.dev/docs/acp.html), multi-model coding agent.
- [Dirac](https://dirac.run), open-source agent with hash-anchored parallel edits.
- [Factory Droid](https://factory.ai/product/cli), Factory AI's coding agent.
- [fast-agent](https://fast-agent.ai/acp/), multi-provider coding agent.
- [Gajae Code](https://gajae-code.com), subscription-based coding agent with plan-before-mutation workflows.
- [Gemini CLI](https://geminicli.com), Google's official Gemini CLI.
- [GLM Agent](https://github.com/stefandevo/glm-acp-agent), Zhipu AI's GLM coding agent.
- [goose](https://block.github.io/goose/), Block's local open-source AI agent.
- [Grok](https://docs.x.ai/build/overview), xAI's Grok Build agentic coding CLI.
- [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp), Nous Research's self-improving agent.
- [Junie](https://junie.jetbrains.com/docs/junie-cli-acp.html), JetBrains' coding agent.
- [Kilo Code](https://kilo.ai/docs/code-with-ai/platforms/cli), open-source coding agent.
- [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code), Moonshot AI's coding assistant.
- [Kiro CLI](https://kiro.dev/docs/cli/acp/), Amazon's coding agent.
- [MiniMax Code](https://agent.minimax.io), MiniMax's terminal coding agent.
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

The in-app catalog is the version-pinned source of this list. To add an agent that the catalog does not list, see [Custom providers](/docs/custom-providers#acp-providers).
