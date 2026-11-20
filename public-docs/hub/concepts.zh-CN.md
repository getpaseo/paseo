---
title: Hub 的工作原理
description: 事件、定时任务和 webhook 如何匹配触发器，并在你的 Paseo daemon 上启动 Agent。
nav: 工作原理
---

# Hub 的工作原理 {#how-hub-works}

Hub 将外部事件、定时任务和 webhook 连接到在你 Paseo daemon 上运行的编程 Agent。

```text
GitHub / Linear / Slack / Discord / Schedule / Webhook
                          │
                          ▼
                         Hub
         verifies input and matches triggers
                          │
                          ▼
                     Paseo daemon
             starts or continues an agent
```

## 核心概念 {#core-concepts}

- **App** 是在自托管 Hub 的 **Apps** 下配置的 Provider 应用（GitHub App、Linear OAuth 应用、Slack 应用或 Discord 应用）。托管 Hub 运行自己的应用。
- **Integration** 是在 **Integrations** 下连接到你 Hub 组织的工作区、账号或服务器。每个已连接的账号都有唯一的连接 slug（例如 `acme-github` 或 `acme-slack`），供触发器引用。
- **Daemon** 是运行 Paseo daemon 并注册到你 Hub 组织 **Daemons** 下的机器。只有在机器上授予 `hub.execute` 后，daemon 才会接受 Agent 启动请求。
- **Trigger** 是一条自包含规则，将事件、定时任务或 webhook 映射到目标 daemon、工作目录、Agent 配置、提示词，以及可选的工具或输出。
- **Activity** 记录组织内每一次已接受的投递、路由决策、执行状态、回复和错误。

## 从事件到 Agent {#from-event-to-agent}

1. 事件到达。GitHub、Linear、Slack（Webhooks 传输方式）和入站 webhook 向 Hub 发送带签名或已认证的 HTTPS 请求。Slack Socket Mode 和 Discord 由 Hub 主动向外连接。定时任务按 Hub 自身的时钟触发。
2. Hub 验证发送者或签名，并查找匹配的已启用触发器。
3. 对于外部 Provider 事件，Hub 会评估触发器的连接、资源过滤条件和发送者白名单（`from_users`）。
4. 对每个匹配的触发器，Hub 创建一次运行，并通过 Paseo 应用和 CLI 使用的同一套 RPC 协议向目标 daemon 发送启动意图。
5. 默认情况下，同一个 Slack 讨论串、Discord 讨论串、GitHub issue 或 Pull Request，以及同一个 Linear issue 上的事件会继续现有 Agent 会话，而不是启动新的 Agent。
6. Agent 在你的机器上运行并挂载 Hub MCP 服务器。它调用 `reply` 回复对话，调用已授予的集成工具，并在完成后调用 `finish_execution`。

## 编写与校验 {#authoring-and-validation}

你可以通过两种方式创建和编辑触发器：

- 在 Hub 控制台的 **Triggers** 页面使用可视化表单或 YAML 编辑器。
- 在仓库中保存 `.paseo/triggers/*.yml` 文件，并通过 `paseo hub deploy` 部署。

两种方式使用相同的 YAML 结构和校验逻辑。保存或部署触发器时，Hub 会校验 YAML 结构，解析引用的连接和 daemon slug，并请已连接的 daemon 校验所选的 Provider、模型、模式、思考选项和 Provider 选项。无效配置会在保存时立即被拒绝，而不是等到第一次运行时失败。

## Open in Paseo 链接 {#open-in-paseo-links}

当 Hub 配置了公开 HTTPS 地址且运行记录了 daemon Agent 时，Hub 会在 GitHub、Linear、Slack 和 Discord 的对话回复中附带 **Open in Paseo** 链接。

点击链接时，Hub 会先验证访问者是否为该 Hub 组织的已登录成员，然后提供在 Paseo 中打开对应 Agent、在 Hub 中查看运行记录或安装 Paseo 的入口。未登录的访客和非组织成员不会看到任何运行数据。

拥有受控发送工具（`run.tools.slack` 或 `run.tools.discord`）的 Agent 也会在请求上下文中收到同一个 URL，方便摘要和报告主动链接回此次运行。

## 安全边界 {#security-boundaries}

Hub 负责验证入站请求、执行发送者白名单、签发受控 GitHub 令牌，并在服务端对每次 Hub MCP 工具调用做鉴权。它不会在你机器上为编程 Agent 进程提供沙箱隔离。

请保护你的 Hub 组织访问权限，以及任何用于部署 `.paseo/triggers/*.yml` 的仓库。在扩大白名单或授予仓库写入权限之前，请先阅读 [Hub 安全](/docs/hub/security)。
