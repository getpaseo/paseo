---
title: 支持的 Provider
description: Paseo 可以启动的所有编程 Agent，包括原生支持的 Provider 和通过 ACP 运行的 Agent。
nav: 支持的 Provider
---

# 支持的 Provider {#supported-providers}

Paseo 运行由你在 daemon 主机上安装并登录的编程 Agent。关于 Paseo 如何管理 Provider，请参见 [Provider](/docs/providers)。要添加这里未列出的 Agent，请参见[自定义 Provider](/docs/custom-providers)。

## 原生支持 {#native-support}

Paseo 为以下每个 Agent 都提供了集成。

- [Antigravity](/docs/supported-providers/antigravity)：通过你已安装的 `agy` CLI 运行。
- [Claude Code](/docs/supported-providers/claude-code)：Anthropic 的编程 Agent。
- [Codex](/docs/supported-providers/codex)：OpenAI 的工作区 Agent。
- [fx](/docs/supported-providers/fx)：Vercel Labs 的编程 Agent。
- [GitHub Copilot](/docs/supported-providers/github-copilot)：GitHub 的 AI 结对编程助手。
- [Hoplite](/docs/supported-providers/hoplite)：云端编程 Agent。
- [Muse Code](/docs/supported-providers/muse-code)：Meta 的终端编程 Agent。
- [Oh My Pi](/docs/supported-providers/omp)：支持多家 Provider 的编程 Agent。
- [OpenCode](/docs/supported-providers/opencode)：开源编程助手。
- [Pi](/docs/supported-providers/pi)：极简的终端编程 Agent。

## 通过 ACP 运行的更多 Agent {#more-agents-through-acp}

Paseo 可以运行任何使用 [Agent Client Protocol](https://agentclientprotocol.com)（ACP）的 Agent。应用内目录列出了以下 Agent。

要添加其中一个，请打开 **设置 → Hosts → 你的主机 → Providers**，在目录里找到该 Agent 并选择 **添加**。通过 `npx` 或 `uvx` 启动的条目只需要 daemon 主机上有该工具。其他条目请先安装该 Agent 的 CLI。每个条目都附有安装说明的链接。

- [Agoragentic](https://agoragentic.com)：拥有 174 种以上 AI 能力的 Agent 市场。
- [Amp](https://github.com/tao12345666333/amp-acp)：前沿的编程 Agent。
- [Auggie CLI](https://www.augmentcode.com/)：Augment Code 的 Agent，由其上下文引擎支撑。
- [Autohand Code](https://www.autohand.ai/cli/)：Autohand AI 的编程 Agent。
- [Cline](https://cline.bot/cli)：自主编程 Agent。
- [Codebuddy Code](https://www.codebuddy.cn/cli/)：腾讯云的编程工具。
- [CodeWhale](https://codewhale.net/)：面向 DeepSeek V4 和开放模型的终端编程 Agent。
- [Cortex Code](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli)：Snowflake 的编程 Agent。
- [Corust Agent](https://github.com/Corust-ai/corust-agent-release/releases)：专注于 Rust 的编程伙伴。
- [crow-cli](https://crow-ai.dev/)：极简的原生 ACP 编程 Agent。
- [Cursor](https://cursor.com/docs/cli/overview)：Cursor 的编程 Agent。
- [DeepAgents](https://docs.langchain.com/oss/javascript/deepagents/overview)：基于 LangChain 的编程 Agent。
- [Devin CLI](https://cli.devin.ai/docs)：Cognition 面向终端的 Devin。
- [DimCode](https://dimcode.dev/docs/acp.html)：多模型编程 Agent。
- [Dirac](https://dirac.run)：开源 Agent，支持基于哈希锚点的并行编辑。
- [Factory Droid](https://factory.ai/product/cli)：Factory AI 的编程 Agent。
- [fast-agent](https://fast-agent.ai/acp/)：支持多家 Provider 的编程 Agent。
- [Gajae Code](https://gajae-code.com)：订阅制编程 Agent，采用先规划再修改的工作流。
- [Gemini CLI](https://geminicli.com)：Google 官方的 Gemini CLI。
- [GLM Agent](https://github.com/stefandevo/glm-acp-agent)：智谱 AI 的 GLM 编程 Agent。
- [goose](https://block.github.io/goose/)：Block 的本地开源 AI Agent。
- [Grok](https://docs.x.ai/build/overview)：xAI 的 Grok Build Agent 编程 CLI。
- [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp)：Nous Research 的自我改进型 Agent。
- [Junie](https://junie.jetbrains.com/docs/junie-cli-acp.html)：JetBrains 的编程 Agent。
- [Kilo Code](https://kilo.ai/docs/code-with-ai/platforms/cli)：开源编程 Agent。
- [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)：月之暗面的编程助手。
- [Kiro CLI](https://kiro.dev/docs/cli/acp/)：Amazon 的编程 Agent。
- [MiniMax Code](https://agent.minimax.io)：MiniMax 的终端编程 Agent。
- [Minion Code](https://github.com/femto/minion-code)：基于 Minion 框架的编程 Agent。
- [Mistral Vibe](https://github.com/mistralai/mistral-vibe)：Mistral 的开源 CLI 助手。
- [Nova](https://www.compassap.ai/portfolio/nova.html)：Compass AI 的软件工程师。
- [Poolside](https://docs.poolside.ai/cli/pool)：Poolside 的编程 Agent。
- [Qoder](https://qoder.com)：Agent 式编程助手。
- [Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/users/overview)：阿里巴巴的通义千问编程助手。
- [siGit Code](https://github.com/getsigit/sigit)：本地优先的编程 Agent，可选使用设备端 LLM。
- [Stakpak](https://stakpak.dev/)：基于 Rust 的 DevOps Agent。
- [TRAE CLI](https://docs.trae.cn/cli_get-started-with-trae-cli)：字节跳动官方的 TRAE 编程 Agent。
- [VT Code](https://github.com/vinhnx/VTCode/blob/main/docs/guides/zed-acp.md)：开源的多 Provider 编程 Agent。

应用内目录是此列表的固定版本来源。要添加目录中没有的 Agent，请参见[自定义 Provider](/docs/custom-providers#acp-providers)。
