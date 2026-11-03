---
title: 编排技能
description: 用于移交任务、获取第二意见以及多 Agent 规划的可复用工作流。
nav: 技能
---

# 编排技能 {#orchestration-skills}

技能为你的 Agent 提供可复用的指令，用于委派、移交和审查。你也可以不安装技能，[直接要求执行这些工作流](/docs/orchestration-workflows)。

| 技能               | 用途                                               |
| ------------------ | -------------------------------------------------- |
| `/paseo`           | 查阅如何管理 Agent、工作区、定时任务和 heartbeat。 |
| `/paseo-handoff`   | 把任务及其上下文移交给另一个 Agent。               |
| `/paseo-committee` | 对一个难题获取两份独立分析。                       |
| `/paseo-advisor`   | 对你当前的工作获取第二意见。                       |

## 安装 {#installation}

- **在 Paseo 中**：打开 **设置 → 你的主机 → Agents → 编排 skills**，选择要在该主机上安装的技能。
- **在终端中**：在运行 Agent 的机器上执行 `npx skills add getpaseo/paseo`。

使用同一张设置卡片更新或卸载技能。主机启动时也会刷新已选择安装的 Paseo 技能。

## `/paseo`：Paseo 参考 {#paseo-paseo-reference}

其他技能所依赖的基础参考。它教 Agent 在委派之前先查看你的 [Agent 配置及其说明](/docs/agent-profiles#guide-delegation-with-notes)，然后应用选定的启动设置。如果没有合适的配置，它会引导 Agent 发现可用的 Provider 和模型，并告诉你采用了哪个备选方案。

> /paseo 告诉我如何在工作区中创建一个使用 worktree 隔离的 Agent

## `/paseo-handoff`：任务移交 {#paseo-handoff-task-handoff}

带着一份简报移交当前任务：相关文件、进展、决策、约束和验收标准。技能会在选择接收方 Agent 之前查看配置；你也可以指定想要的配置。

> /paseo-handoff 把认证修复移交给一个实现 Agent，让它在自己的 worktree 中进行

接收方 Agent 会获得继续工作所需的上下文。如果它需要独立编辑，请要求使用单独的 worktree。

## `/paseo-committee`：委员会规划 {#paseo-committee-committee-planning}

让两个 Agent 独立分析一个难题。技能会查看配置说明中适合规划和分析的配置，并尽可能选择不同的 Provider 系列。

> /paseo-committee 为什么 websocket 连接在高负载下会断开？

委员会成员只返回分析，不编辑文件。主 Agent 综合它们的方案，实现解决方案，再把 diff 发回去审查。

## `/paseo-advisor`：顾问 {#paseo-advisor-advisor}

就某个设计、diff 或问题征求另一个 Agent 的判断。技能会选择说明与该工作相符的配置，或使用你指定的配置。

> /paseo-advisor 这份迁移计划我有没有遗漏什么？

顾问只返回第二意见，不编辑文件。
