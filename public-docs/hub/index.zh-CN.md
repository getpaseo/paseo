---
title: Hub
description: 通过 GitHub、Linear、Slack、Discord、定时任务和 webhook，在你的 Paseo daemon 上自动化运行编程 Agent。
nav: 概览
---

# Hub {#hub}

Paseo daemon 在一台机器上运行编程 Agent。Paseo Hub 位于你的 daemon 之上，让外部事件、定时任务和 webhook 可以在这些机器上启动 Agent，并与团队共享运行历史。

```text
GitHub · Linear · Slack · Discord · Schedules · Webhooks
                           │
                           ▼
                          Hub
               ┌───────────┼───────────┐
               ▼           ▼           ▼
            laptop       devbox   build server
```

Hub 为你的团队提供四项能力：

- 由 GitHub、Linear、Slack、Discord、周期性定时任务和入站 webhook 自动启动的事件驱动 Agent。
- 可以在浏览器中编辑，或保存在 `.paseo/triggers/*.yml` 中并通过 CLI 部署的触发器。
- 受控的集成工具，让任意触发器都能读取或发送到 Slack 和 Discord，或在 GitHub 上执行操作。
- 一个共享的活动记录，汇总事件投递、路由结果、运行记录和回复。

你的 daemon 仍然在你自己的机器上运行 Agent，使用你现有的订阅、模型和技能。Hub 只负责决定何时调用它们。

## 仓库中有什么 {#what-lives-in-your-repository}

你可以在 Hub 控制台中管理触发器，也可以将每个触发器保存为仓库中的一个 YAML 文件：

```text
.paseo/
└── triggers/
    └── slack-help.yml
```

每个文件都是自包含的。它指定事件、允许的发送者、目标 daemon、工作目录、Agent 配置、提示词，以及所需的工具或回复限制。运行 `paseo hub init` 生成入门文件，或运行 `paseo hub deploy` 校验并安装触发器。

## 阅读顺序 {#reading-order}

1. [快速开始](/docs/hub/quickstart)
2. [工作原理](/docs/hub/concepts)
3. [Daemon](/docs/hub/daemons)
4. [触发器](/docs/hub/triggers)
5. [集成工具](/docs/hub/tools)
6. [GitHub 访问](/docs/hub/github)
7. [配置](/docs/hub/configuration)
8. [安全](/docs/hub/security)

在授予触发器工作目录、GitHub 权限或聊天频道访问权限之前，请先阅读 [Hub 安全](/docs/hub/security)。

## 托管或自托管 {#hosted-or-self-hosted}

[托管 Hub](/docs/hub/hosted) 为你运维服务器和 Provider 应用。前往 [hub.paseo.sh](https://hub.paseo.sh) 创建免费账号，无需绑卡，也不会过期。

如果要在自己的机器或服务器上运行 Hub，可以先运行 `npx @getpaseo/hub` 使用内嵌数据库，按需再切换到 PostgreSQL 或公开 HTTPS 部署。参见[自托管](/docs/hub/self-hosting)。
