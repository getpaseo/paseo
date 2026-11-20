---
title: Hub
description: 位于 daemon 之上的一层。注册 daemon，为它们赋予能力，并与团队共享。
nav: 概览
---

# Hub {#hub}

daemon 在一台机器上为你运行 Agent。Paseo Hub 是位于 daemon 之上的一层。你把 daemon 注册到 Hub，它就为这些 daemon 提供它们自身不具备的能力。

```text
             Hub
    ┌─────────┼─────────┐
    ▼         ▼         ▼
 laptop    devbox    build server
```

目前它能为你提供：

- 由 GitHub、Slack 和 Discord 中的活动自动启动的 Agent。
- 可以保存在仓库中、通过 CLI 部署的触发器。
- 一份记录：收到了什么、匹配到了什么、运行了什么。
- 一个让团队查看所有这些内容的地方。

你的 daemon 照常在原来的地方运行 Agent，Hub 决定何时让它们运行。

## 仓库中有什么 {#what-lives-in-your-repository}

`paseo hub init` 会创建一个自包含的起步触发器：

```text
.paseo/
└── triggers/
    └── slack-help.yml
```

这个文件指定了应用连接、允许的用户、daemon、工作目录、Agent 运行时、提示词和输出。设置流程会校验它并询问是否部署。之后提及机器人，就会在你的机器上启动一个 Agent。[快速开始](/docs/hub/quickstart)完整地跑通了这个过程；[生成的起步触发器](/docs/hub/configuration#generated-starter-trigger)展示了设置流程写入的内容。

## 阅读顺序 {#reading-order}

1. [快速开始](/docs/hub/quickstart)
2. [工作原理](/docs/hub/concepts)
3. [Daemon](/docs/hub/daemons)
4. [触发器](/docs/hub/triggers)
5. [Workflow](/docs/hub/workflows)
6. [GitHub 访问](/docs/hub/github)
7. [配置](/docs/hub/configuration)
8. [安全](/docs/hub/security)

如果某个 workflow 接受来自 GitHub、Slack、Discord 或 API 的请求，在让 Agent 访问工作目录或输出能力之前，请先阅读 [Hub 安全](/docs/hub/security)。

## 自己运行 Hub {#run-hub-yourself}

先在你的机器上使用内嵌数据库启动，等确实需要时再添加 PostgreSQL 或公开部署。[自托管](/docs/hub/self-hosting)介绍了每一步。

[托管 Hub](/docs/hub/hosted) 使用相同的触发器、daemon 和活动模型。[创建免费账号](https://hub.paseo.sh)，无需绑卡，也不会过期。
