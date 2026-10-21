---
title: Provider
description: Paseo 如何看待编程 Agent：封装现有 CLI、原生支持与 ACP 支持，以及接下来去哪里。
nav: Provider
---

# Provider {#providers}

Paseo 在带有编辑器、终端、diff（桌面端还有浏览器）的工作区中运行**你已安装并完成认证的现有编程 Agent**。你可以并行运行多个 Agent，为每个任务选择 Provider，并在同一个应用中审查它们的工作。你的订阅、配置、技能和 MCP 服务器都保持不变。

想体验这套工作流，可以[在不同的 worktree 中运行并行任务](/docs/parallel-development)。

## 心智模型 {#mental-model}

Provider 是 Paseo 与某个外部 Agent CLI 之间的约定：如何启动它、如何流式读取输出、如何回传输入、支持哪些模式。实际的二进制文件位于你的机器上，作为普通子进程运行。

## 两个层级 {#two-tiers}

- **原生支持**：Paseo 为主流 Agent（Claude Code、Codex、OpenCode、Pi、[Antigravity](/docs/supported-providers#antigravity)、[Muse Code](/docs/muse-code)）内置了适配器。安装底层 CLI 后会被自动发现，并在适用时提供模式元数据和语音支持。
- **ACP 目录**：任何使用 [Agent Client Protocol](https://agentclientprotocol.com) 的 Agent 都可以通过通用适配器获得支持。Paseo 提供一个精选目录，支持一键安装（Cursor、Gemini、GitHub Copilot、Hermes、Kimi、Qwen Code 等 25 个以上），你也可以自行添加任何其他 ACP Agent。

无论哪种方式，**底层 CLI 都由你安装**，Paseo 负责运行它。

## 接下来 {#where-to-go-next}

- [支持的 Provider](/docs/supported-providers)：完整列表和安装链接。
- [Agent 配置](/docs/agent-profiles)：把模型、模式和思考设置保存在一起，并附上指导委派的说明。
- [自定义 Provider](/docs/custom-providers)：添加你自己的 Provider、把现有 Provider 指向其他端点、配置多个 Provider 别名，或在 `~/.paseo/config.json` 中覆盖二进制文件。
- [paseo.sh/agents](/agents)：每个支持的 Provider 的落地页。
