---
title: 编排
description: 跨 Provider 和机器协调 Agent、委派工作，并用定时任务和 heartbeat 让任务持续推进。
nav: 概览
---

# 编排 {#orchestration}

Paseo 让你的编程 Agent 协调其他 Agent，把工作分配到不同的 Provider 和机器上，并自动推进任务。

你也可以在桌面应用中亲自启动并监督每个任务。[在不同的 worktree 中运行并行任务](/docs/parallel-development)，检查它们的 diff，并在终端和浏览器中测试每个应用，再决定合并哪个。

## 你的 Agent 能做什么 {#what-your-agents-can-do}

- **选择 Provider 和模型**：使用主机上配置的任意 Provider 和模型启动其他 Agent。
- **委派与并行**：把调研、实现和审查分给不同的 Agent，包括来自不同 Provider 的 Agent。
- **相互通信**：Agent 可以[通过 ID 向其他 Agent 发送提示词](/docs/orchestration-workflows#send-a-prompt-to-another-agent)，用来提问、分享发现或请求协助。
- **协调进行中的工作**：查看进度、停止任务并收集结果。
- **创建工作区和 worktree**：为相互独立的改动提供各自的[工作目录](/docs/worktrees)。
- **跨机器工作**：使用 [CLI](/docs/cli#connecting-to-a-remote-daemon) 在另一台可访问的 Paseo 主机上启动和管理 Agent。
- **按专长选择**：使用 [Agent 配置](/docs/agent-profiles)及其说明，为 UI 工作、规划或审查选择设置。
- **创建定时任务**：在[指定时间](/docs/schedules)用新的 Agent 运行一段提示词。
- **创建 heartbeat**：定期提示同一个 Agent，让它[继续它的任务](/docs/orchestration-workflows#keep-an-agent-working-with-a-heartbeat)。

## 开始使用 {#get-started}

使用内置的 Paseo 工具或 CLI。两者都能让 Agent 启动和协调执行者。

### 内置 Paseo 工具（MCP） {#built-in-paseo-tools-mcp}

启用 Paseo 工具后，在 Paseo 中运行的 Agent 可以直接管理其主机上的 Agent 和工作区。

1. 打开 **设置 → 你的主机 → Agents**。
2. 打开 **启用 Paseo tools**。工具注入默认关闭。
3. 启动一个新的 Agent，或重新加载已有的 Agent，让它获得这些工具。
4. 提出要求：

> 用 Paseo 启动第二个 Agent 审查这个分支。让它在不修改文件的前提下报告潜在的 bug，然后总结它的发现。

执行者会出现在 Composer 附近的 **Subagent** 面板中。打开它即可跟进对话。执行者完成时，主 Agent 会收到通知；在它工作期间，你可以继续对话。

工具配置和完整目录见 [MCP 参考](/docs/mcp)。[编排技能](/docs/skills)是可选的可复用工作流。

### CLI {#cli}

有 shell 访问权限的 Agent 也可以使用 Paseo CLI。这种方式不需要启用工具注入。在已安装 Paseo、主机正在运行并且配置了 Codex 的情况下：

```bash
paseo run --provider codex --no-wait \
  "Review this branch without changing files"
paseo ls -a
```

第一条命令启动一个执行者并立即返回；第二条命令还会列出已归档和后台的 Agent。当 Paseo Agent 运行这条命令时，执行者会成为它在同一工作区中的子 Agent。从你自己的终端运行时，它会在一个新的本地工作区中启动。

后续提示词、输出、worktree 和远程主机的用法见 [CLI 参考](/docs/cli)。

## 用配置一次选好设置 {#pick-settings-once-with-profiles}

把 Provider、模型、思考级别、模式和可用的功能设置保存为一个 **Agent 配置**，创建 Agent 时一键选择。

添加 **适用场景** 说明，让负责编排的 Agent 能为任务选择配置：UI 工作、规划或独立审查。[创建配置并编写委派说明](/docs/agent-profiles)。

## 更进一步 {#go-further}

- [委派实现并获取独立审查](/docs/orchestration-workflows#implement-then-review)。
- [在不同的 worktree 中运行并行改动](/docs/orchestration-workflows#parallelize-edits-without-collisions)。
- [协调另一台机器上的工作](/docs/orchestration-workflows#work-on-another-machine)。
- [创建周期性任务](/docs/schedules)，或[用 heartbeat 继续任务](/docs/orchestration-workflows#keep-an-agent-working-with-a-heartbeat)。
- [安装可复用的编排技能](/docs/skills)。
