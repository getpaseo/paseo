---
title: 支持的 Provider
description: Paseo 可以启动的所有编程 Agent，包括原生支持的 Provider 和 ACP 目录。
nav: 支持的 Provider
---

# 支持的 Provider {#supported-providers}

关于 Provider 的概念以及 Paseo 如何管理 Provider，请参见 [Provider](/docs/providers)。要添加或配置你自己的 Provider，请参见[自定义 Provider](/docs/custom-providers)。

## 原生支持 {#native-support}

安装底层 CLI 并完成认证后即可开箱使用。

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)。Anthropic 的编程 Agent，支持 MCP、流式输出和深度推理。
- [Codex](/docs/codex)。OpenAI 的工作区 Agent，带有沙箱控制和可选的网络访问。
- [OpenCode](https://opencode.ai/)。开源编程助手，支持多家 Provider 的模型。
- [Pi](https://pi.dev)。极简的终端编程 Agent，支持多家 Provider 的 LLM。
- [Antigravity](#antigravity)。通过内置的 Provider 插件使用你已安装的 `agy` CLI。
- [Muse Code](/docs/muse-code)。Meta 的终端编程 Agent，以 Provider 插件的形式内置。

### Antigravity {#antigravity}

在 daemon 主机上安装 Antigravity CLI（`agy`），然后运行一次 `agy` 登录。在 Paseo 中选择 **Antigravity**。该 Provider 随 Paseo 一起提供，无需另外安装插件。

**Full access** 是唯一的权限模式。当由其他应用驱动时，Antigravity 无法请求权限，因此 Paseo 会以 `--dangerously-skip-permissions` 启动 `agy`。每次工具调用（包括 shell 命令）都不会询问就直接运行。每个会话开始时都会显示一条说明此事的警告，重新打开聊天时也会显示。Antigravity 自己的策略仍然可以拒绝某个操作。

daemon 重启后，Antigravity 会记得对话，但 Paseo 的对话记录会重新开始，因为 `agy` 不会重放它的历史。

此集成使用你已安装的 CLI 和登录状态，未经 Google 认可。

Paseo MCP 工具和引导功能不可用。你自己为 `agy` 配置的 MCP 服务器仍然可用。附加的图片会以文件引用的形式传给 Agent 读取。

如果 `agy` 不在 daemon 的 PATH 中，请在 `~/.paseo/config.json` 中覆盖它的命令。使用 `env` 设置 Provider 专用的环境变量：

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

命令和环境变量覆盖见[自定义 Provider](/docs/custom-providers)。

## ACP 目录 {#acp-catalog}

在应用内的 Provider 目录中选择以下任意一个。每个条目都可以一键安装底层 CLI。

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
- [DimCode](https://dimcode.dev/docs/acp.html)：多模型编程 Agent。
- [Dirac](https://dirac.run)：开源 Agent，支持基于哈希锚点的并行编辑。
- [Factory Droid](https://factory.ai/product/cli)：Factory AI 的编程 Agent。
- [fast-agent](https://fast-agent.ai/acp/)：支持多家 Provider 的编程 Agent。
- [Gajae Code](https://gajae-code.com)：订阅制编程 Agent，采用先规划再修改的工作流。
- [Gemini CLI](https://geminicli.com)：Google 官方的 Gemini CLI。
- [GitHub Copilot](https://github.com/features/copilot/cli/)：通过 ACP 接入的 GitHub AI 结对编程助手。
- [GLM Agent](https://github.com/stefandevo/glm-acp-agent)：智谱 AI 的 GLM 编程 Agent。
- [goose](https://block.github.io/goose/)：Block 的本地开源 AI Agent。
- [Grok](https://docs.x.ai/build/overview)：xAI 的 Grok Build Agent 编程 CLI。
- [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp)：Nous Research 的自我改进型 Agent。
- [Hoplite](#hoplite)：通过本地 ACP 桥接入的云端编程 Agent。
- [Junie](https://junie.jetbrains.com/docs/junie-cli-acp.html)：JetBrains 的编程 Agent。
- [Kilo Code](https://kilo.ai/docs/code-with-ai/platforms/cli)：开源编程 Agent。
- [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)：月之暗面的编程助手。
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

应用内目录是权威的、固定版本的来源。这里未列出的 Agent 仍然可以手动添加，参见[自定义 Provider](/docs/custom-providers)。

### Hoplite {#hoplite}

在 daemon 主机上安装 [Hoplite CLI](https://hoplite.sh/docs/cli) 并运行 `hoplite login`。在 **设置 → Hosts → 你的主机 → Providers** 中，在目录里找到 **Hoplite** 并选择 **添加**。Paseo 会通过通用 ACP 适配器启动 `hoplite acp`。

Hoplite 在云端工作区中运行 Agent。请打开一个关联了 Hoplite 项目的仓库，或者设置 `agents.providers.hoplite.env.HOPLITE_PROJECT_ID`，在所有地方使用同一个项目。如果既没有关联的仓库也没有固定的项目，发现过程会报告 `No Hoplite project`。你的本地文件和 Paseo 的回环 MCP 工具在该云端工作区中不可用。

认证和项目设置见 [Hoplite 的 ACP 指南](https://hoplite.sh/docs/cli/acp)。如果 `hoplite` 不在 daemon 的 PATH 中，请使用[命令覆盖](/docs/custom-providers)，并在参数中保留 `acp`。
