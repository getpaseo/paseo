---
title: 运行并行任务
description: 在 Paseo 中让编程 Agent 在不同的 worktree 中运行，审查它们的 diff，并用终端和内置浏览器测试每个改动。
nav: 运行并行任务
---

# 运行并行任务 {#run-parallel-tasks}

使用 Paseo 桌面应用为多个编程 Agent 分配相互独立的任务，审查它们的改动，并运行结果。每个任务都有一个工作区，带有自己的 git worktree 和分支，Agent、文件、diff、终端和浏览器标签页都放在一起。

开始之前，请准备好[桌面应用](/docs#desktop-app-recommended)、一个本地 git 仓库，以及至少一个[已安装并完成认证的编程 Agent](/docs/supported-providers)。下面的示例使用一个带有 `origin/main` 分支的仓库。

## 启动两个任务 {#start-two-tasks}

1. 打开 **新建 workspace** 并选择你的项目。
2. 把 **隔离** 设置为 **新建 worktree**，并选择 `origin/main` 作为起始 ref。
3. 选择 Agent 和模型，然后提交一个任务，例如：“为项目列表添加筛选功能。运行相关测试。”
4. 从同一个起始 ref 用 **新建 worktree** 创建第二个工作区。给它的 Agent 另一个任务：“为设置页面添加键盘导航。运行相关测试。”

两个 Agent 会同时运行。在侧边栏中选择任一工作区即可查看进度或发送后续提示词。两个任务可以使用同一个 Provider，也可以各用不同的 Provider。

不同的 worktree 让各自的文件修改保留在不同的分支上。如果想得到同一功能的两种实现，可以给两个 Agent 相同的任务，比较结果后再选择一个。

## 审查每个改动 {#review-each-change}

选择一个工作区，从 Command Center 打开 **变更** 查看它的 diff。打开 **文件** 浏览和编辑源码。使用分栏，让 Agent 对话和你正在审查的代码并排显示。

把修改意见发送给该工作区的 Agent。如果想听听别的意见，在同一个工作区中使用 **新建 Agent**，让它在不编辑文件的前提下审查改动。同一工作区中的 Agent 共享它的工作目录。

## 运行并测试应用 {#run-and-test-the-app}

在选中的工作区中，从 Command Center 使用 **新建 Terminal**。在那里安装依赖，并运行项目的测试或开发命令。

每个 worktree 都有自己的文件，但进程仍然共享机器的网络端口。请为每个正在运行的副本分配不同的开发服务器端口。要让 setup 和服务端口可重复配置，请设置 [worktree setup 和脚本](/docs/worktrees#paseojson)。

对于网页应用，使用 **新建浏览器** 并输入该工作区的开发服务器 URL。走一遍改动过的流程，然后切换工作区测试另一个实现。浏览器标签页在桌面应用中运行。

你也可以让 Agent 在这些标签页中检查应用。启用[浏览器自动化](/docs/browser#enabling)，然后给它 URL 和具体的验证步骤，例如：

> 打开 http://localhost:3001，按名称筛选项目列表，并验证清除筛选后会恢复完整列表。报告任何失败，并截取结果的屏幕截图。

## 选择要合并的内容 {#choose-what-to-merge}

审查每个工作区的 diff 和测试结果。在提交并为该分支创建 PR 之前，先提出剩下的修改要求；可以在工作区终端中使用你平常的 Git 工作流，也可以交给它的 Agent。

对于相互独立的任务，审查并合并每个分支。对于相互竞争的实现，选择你想保留的版本。不再需要某个工作区时就把它归档；[worktree 清理](/docs/worktrees#manage-the-workspace)会在最后一个工作区归档后删除受管理的目录。

## 让 Agent 协调这些任务 {#let-an-agent-coordinate-the-tasks}

如果你想让 Agent 创建工作区、启动执行者并收集结果，请使用[编排](/docs/orchestration)。执行者会出现在 Paseo 中，你可以在它们工作时查看对话和改动。
