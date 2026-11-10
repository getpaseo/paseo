---
title: Hub 工作原理
description: Provider 事件如何到达 workflow 和 Paseo daemon。
nav: 工作原理
---

# Hub 工作原理 {#how-hub-works}

Hub 把请求到达的地方与运行 Agent 的机器连接起来。

```text
GitHub / Slack / Discord / manual request
                    ↓
                  Hub
        matches a project trigger
                    ↓
                workflow
          runs ordered agent steps
                    ↓
             Paseo daemon
             starts the agent
```

## 组成部分 {#the-pieces}

- **连接**让 Hub 接收来自 GitHub、Slack 或 Discord 的事件。
- **daemon** 是一台运行 Paseo daemon 的已注册机器。
- **项目**把一份配置与它使用的连接和 daemon 组织在一起。
- **环境**指定 workflow step 在哪里运行：一个 daemon、它的工作目录，以及可选的 worktree。
- **触发器**说明哪个 Provider 事件可以启动 workflow，以及允许哪些事件通过。
- **workflow** 是触发器匹配后运行的一组有序 step。
- **step** 启动一次 Agent 执行，有自己的提示词、Agent 选择、凭据、回复能力和限制。

当项目使用 GitHub 来源时，配置位于 `.paseo/hub.yml` 以及按约定发现的 `.paseo/workflows/*.yml` 文件中。一个项目同一时间只有一个生效的配置版本。

## 从事件到 Agent {#from-event-to-agent}

1. Provider 向 Hub 发送事件。GitHub 和 Slack 使用 webhook；Discord 使用它的 gateway 连接；手动运行使用 Hub API。
2. Hub 验证 Provider 事件，并识别它对应的项目资源，例如仓库、工作区或服务器。
3. Hub 评估触发器及其过滤器，包括必填的 `from_users` 允许列表。
4. 匹配的触发器根据当前生效的配置版本创建一次 workflow 运行。
5. workflow 评估下一个 step。`if` 条件为假时跳过该 step；为真时在配置的 daemon 上启动它。
6. daemon 启动 Agent，Hub 记录它的回复、结构化输出、状态和完成情况。
7. 下一个 step 可以看到已完成 step 的输出。没有剩余 step 时，workflow 运行完成。

完整的配置示例见 [Workflow](/docs/hub/workflows)。

## 激活 {#activation}

Hub 同步配置包时，会校验每个源文件并解析其中的引用：

- `filters.repo`、`filters.workspace` 和 `filters.guild` 必须指向通过组织的连接可以访问的资源。
- `environment.daemon` 必须匹配一个已注册 daemon 的友好 slug。
- step id、表达式、输入过滤器、输出 schema 和时长必须有效。
- 每个有限的环境或命名 Agent 结果都必须存在并通过校验。
- 提示词片段必须能在该提交中 `.paseo/workflows/partials/` 下解析到。

如果激活失败，Hub 会保留之前生效的版本。Configuration 标签页会显示失败的同步及其校验错误；Activity 继续反映上一个生效的版本。

## 安全边界 {#security-boundaries}

对于来自外部的事件，触发器要求 `from_users` 允许列表不能为空。请保护好配置仓库，因为任何能够修改生效配置的人，都可以决定项目使用哪些连接、daemon 和 Agent 能力。

这些控制措施不会把 Agent 放进沙箱，也不会让输入变得安全。主机边界、Provider 原生策略和纵深防御方面的指导见 [Hub 安全](/docs/hub/security)。

触发器从不隐含 GitHub 凭据。无论运行由什么启动，只有当 step 声明了 [`github` 块](/docs/hub/github)时，它才拥有 GitHub 权限。
