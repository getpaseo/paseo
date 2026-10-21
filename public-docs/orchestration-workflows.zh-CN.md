---
title: 常用编排工作流
description: 用 Paseo 委派、并行、审查和延续 Agent 工作的提示词。
nav: 常用工作流
---

# 常用编排工作流 {#common-orchestration-workflows}

[启用 Paseo 工具](/docs/orchestration#get-started)，然后让你的主 Agent 执行下面的某个工作流。请根据你的项目调整任务。[Agent 配置](/docs/agent-profiles)让你可以保存设置，并说明每类工作应该使用哪个 Agent。

## 把工作交给另一个模型 {#send-work-to-a-different-model}

在主聊天中继续做规划，把实现委派出去：

> 用 Paseo 查看我的 Agent 配置及其说明。选择一个用于实现的配置，创建一个使用 worktree 隔离的工作区，并在那里启动一个子 Agent 来实现解析器的改动。让它运行相关测试并汇报结果。

执行者会在自己的 worktree 中完成改动。如果没有合适的配置，Agent 可以发现你配置的 Provider 和模型，并告诉你它选择了什么。

## 分头调研 {#fan-out-research}

把相互独立的问题分给多个执行者：

> 在这个工作区中创建三个 Paseo 子 Agent。一个追踪请求路径，一个检查测试，一个查找相关的回归问题。不要编辑文件。三个都汇报后，综合它们的发现。

执行者共享你的文件，并出现在 **Subagent** 面板中。你的主 Agent 会把它们的发现汇总成一个回答。

## 并行编辑而不冲突 {#parallelize-edits-without-collisions}

为每个独立的改动分配各自的 worktree：

> 把这两个 issue 分给两个 Paseo 子 Agent。为每个 issue 从 main 创建一个单独的、使用 worktree 隔离的工作区。查看我的配置，选择合适的实现设置，并让每个 Agent 为自己的改动运行相关检查。完成后总结两份 diff。

每个执行者编辑各自的检出。你会得到两个可以检查的改动，以及它们的检查结果。

## 先实现，再审查 {#implement-then-review}

为完成改动和评判改动选择不同的 Agent：

> 查看我的 Paseo 配置及其说明，找出用于实现和审查的配置。创建一个使用 worktree 隔离的工作区，并在那里启动一个实现执行者。完成后，在该工作区中启动一个独立的审查者，检查正确性、缺失的测试和不必要的复杂度。把审查结果带回这里。

审查者在一段新的对话中查看执行者的文件。如果想听取另一个模型的判断，请使用来自不同 Provider 的配置。

## 向另一个 Agent 发送提示词 {#send-a-prompt-to-another-agent}

Agent 可以通过 **Agent ID** 相互发送提示词，Agent ID 是 Paseo 用来指定某个 Agent 的标识符。它们可以在同一主机上跨工作区通信，包括与不是由自己启动的 Agent 通信。

1. 右键点击接收方 Agent 的标签页，选择 **复制 Agent ID**。
2. 把这个 ID 粘贴到你与发送方 Agent 的对话中，然后提出要求：

> 用 Paseo 把这段提示词发送给 Agent [在此粘贴 Agent ID]：“审查你工作区中解析器的改动，并报告缺失的测试用例。”

接收方 Agent 会在它现有的对话中收到这段提示词。由 Agent 发起的发送默认会引导正在进行的一轮；无法引导时则退回为中断。把 MCP 的 `activeTurnBehavior` 或 CLI 的 `--behavior` 设置为 `steer` 或 `interrupt` 可以覆盖这个默认行为。如果希望它另外回发一条消息，请把发送方的 Agent ID 也告诉它。

在底层，Agent 会用接收方的 `agentId` 和一段 `prompt` 调用 `send_agent_prompt`。Agent 也可以用 `list_agents` 发现 ID；CLI 使用 [`paseo send <id>`](/docs/cli#sending-messages)。对于另一台主机，请使用[远程 CLI 工作流](#work-on-another-machine)。

## 检查、调整或继续工作 {#check-redirect-or-continue-work}

按需分别发送这些提示词：

> 总结子 Agent 们正在做什么，并标出任何被阻塞的地方。

你会在主对话中得到一份进度总结。

> 告诉解析器执行者添加畸形输入的用例，并重新运行它的测试文件。

执行者会在它现有的对话中继续。

> 取消 UI 执行者当前这一轮，但保留这个 Agent，以便我调整它的方向。

当前任务停止；执行者仍然可以接收后续提示词。

## 在另一台机器上工作 {#work-on-another-machine}

CLI 可以以另一台 Paseo 主机为目标。先[把它连接到远程 daemon](/docs/cli#connecting-to-a-remote-daemon)，并确定那台主机上的一个工作区。仓库和所需的 Provider 必须在那里可用。

> 使用我提供的远程主机和工作区，通过 Paseo CLI 在那里启动一个 Agent 调查失败的构建，检查它的输出，并在这里总结发现。不要修改文件。

执行者在远程机器上运行。请用 CLI 的全局 `--host` 选项指定目标；注入的 Paseo 工具作用于主 Agent 自己的主机。

## 用 heartbeat 让 Agent 持续工作 {#keep-an-agent-working-with-a-heartbeat}

heartbeat 会定期提示同一个 Agent，并保留它的对话：

> 用 Paseo 创建一个每 10 分钟一次的 heartbeat。以小步推进这次迁移，每一步之后运行相关检查，迁移完成后删除这个 heartbeat。设置它在两小时后过期。

Agent 会按这个节奏继续任务。如果希望每次运行都使用新的 Agent，请改为[创建定时任务](/docs/schedules)。

## 工作出现在哪里 {#where-the-work-appears}

打开 Composer 附近的 **Subagent** 面板查看委派出去的工作。

|          | Paseo 子 Agent                       | Provider 原生子 Agent          |
| -------- | ------------------------------------ | ------------------------------ |
| Provider | 任意已配置的 Provider                | 在父 Provider 自己的体系内选择 |
| 工作区   | 当前或显式选择的工作区               | 由 Provider 管理               |
| 对话     | 可以与之对话的完整 Agent 会话        | 只读的时间线                   |
| 控制     | 后续提示词、修改设置、归档或解除关系 | 生命周期由 Provider 管理       |

位于另一个工作区的 Paseo 子 Agent 仍然属于它父 Agent 的 track。它也会在自己的工作区中以标签页打开。要让它成为顶层 Agent，请在应用中或用 [`paseo agent detach`](/docs/cli#agent-modes) 解除父子关系。

工作区和父子关系的规则见 [MCP 参考](/docs/mcp#mental-model)。
