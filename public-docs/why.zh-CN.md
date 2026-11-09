---
title: 为什么选择 Paseo？
description: 一个完整的 Agent 开发环境，用于运行编程 Agent、编辑文件、审查改动和测试你的工作。
nav: 为什么选择 Paseo？
---

# 为什么选择 Paseo？ {#why-paseo}

Paseo 是一个完整的 Agent 开发环境。你可以运行编程 Agent、编辑文件、审查 diff 和 PR，并用终端和内置的桌面浏览器测试你的应用。对于由 Agent 驱动的开发，Paseo 可以替代你的 IDE：在一个应用里把任务从第一条提示词一路推进到审查和测试。

## 在一个工作区中开发 {#develop-in-one-workspace}

打开桌面应用，选择一个项目和一个 Agent，然后开始工作。对话、编辑器、终端、diff 和浏览器以分栏的形式放在一起。运行你的应用、检查结果、让 Agent 修改，都不用离开工作区。

桌面应用支持 macOS、Windows 和 Linux。它会自动启动和管理本地 daemon。

## 并行运行任务 {#run-tasks-in-parallel}

为相互独立的任务分配各自的 worktree 和分支。同时运行多个 Agent，检查每份 diff，测试每个实现，再决定合并哪个。你可以为每个任务使用同一个 Provider，也可以为每个任务选择不同的 Provider 和模型。

配置[工作区脚本](/docs/worktrees#scripts-and-services)，为每个 worktree 在不同端口上启动开发服务器。[试试并行开发工作流](/docs/parallel-development)。

## 使用你的 Agent 和工具 {#use-your-agents-and-tools}

Paseo 运行你已经在用的编程 Agent，沿用你的订阅、凭据、配置、技能和 MCP 服务器。你的 Agent 使用你机器上的文件和工具。参见[支持的 Provider](/docs/supported-providers)。

你可以口述任务，或使用[语音模式](/docs/voice)。语音转文字和文字转语音默认在本地运行，也可以在设置中选择云端 Provider。

## 在另一台设备上继续 {#continue-from-another-device}

daemon 持有正在运行的 Agent 和工作区。桌面应用在本地连接它；移动端、网页端和 CLI 客户端连接到同一个环境。这种分离让你可以在另一台设备上继续工作，或者把环境运行在服务器上。

你可以完全在笔记本电脑上使用 Paseo，也可以在需要时连接另一台机器。原生的 iOS 和 Android 应用让你在手机上使用 Agent、文件、终端和 diff。内置浏览器在桌面应用中运行。你可以直接[连接你的设备](/docs/connectivity)，也可以通过可选的端到端加密中继连接。

## 自动化并扩展你的工作流 {#automate-and-extend-your-workflow}

为 Agent 提供 [Paseo 工具](/docs/orchestration)，让它们创建 worktree、启动其他 Agent、发送提示词并收集结果。使用 [CLI](/docs/cli) 或 [TypeScript SDK](/docs/sdk) 自动化 Agent 和工作区操作。

[插件](/docs/plugins)可以添加 Provider、工作区面板、命令和工作流。[Hub](/docs/hub) 把外部事件连接到在你机器上运行的 Agent。

Paseo 基于 Apache-2.0 开源，没有遥测和跟踪，也不需要 Paseo 账号。
