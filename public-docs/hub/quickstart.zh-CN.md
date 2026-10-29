---
title: Hub 快速开始
description: 在本地运行 Hub，并用你机器上的 Agent 回复一次 Slack 提及。
nav: 快速开始
---

# Hub 快速开始 {#hub-quickstart}

在你的机器上运行 Hub，无需公开服务器即可连接 Slack，并用仓库中的 Agent 回复一次提及。Hub 的浏览器设置流程会把你引导到终端，`paseo hub init` 会为你编写并部署一个起步触发器。

你需要[已安装并正在运行的 Paseo](/docs)、Node.js，以及一个你可以在其中创建应用的 Slack 工作区。

## 1. 启动 Hub {#1-start-hub}

```sh
npx @getpaseo/hub
```

打开它打印的地址（通常是 <http://localhost:3000>），并按 Hub 的要求创建管理员账号。

首次运行不需要数据库、Docker、环境变量或 API key。Hub 会创建内嵌数据库和你的组织。

Hub 会打开 **Home**，这是一份清单，列出了提及能够启动 Agent 之前必须满足的四件事：连接一个应用、连接一个 daemon、创建一个触发器、运行它。下面的步骤就是这四件事。Home 会根据你的组织实际拥有的内容判断每一项，打印下一步需要的命令，并在四项全部完成后收起。

## 2. 连接 Slack {#2-connect-slack}

**Set up your apps** 说明了如何创建 Slack 应用，并提供一份可以粘贴到 Slack 中的 manifest。保持选择 **Socket Mode**。它由 Hub 主动向外连接，不需要公开地址或 HTTPS。

把 App-level token 和 Bot token 粘贴回 Hub，然后选择 **Connect Slack**。把机器人邀请到你要使用它的频道：

```text
/invite @Paseo
```

GitHub 和 Discord 可以稍后再配置。它们的设置一直在 **Apps** 下可用。

## 3. 连接代码所在的机器 {#3-connect-the-machine-your-code-is-on}

**Connect a daemon** 会显示一条已经填好此 Hub 地址的命令：

```sh
paseo hub login http://localhost:3000
```

在代码所在的机器上、Agent 要工作的仓库中运行它。之后也请在该目录中运行下面的初始化命令，这样它就会成为触发器的工作目录。

在打开的浏览器标签页中批准登录。保持 Hub 标签页打开：它会监测 daemon，并自动显示 **Daemon connected**。daemon 连接后，选择 **Continue**。

## 4. 创建起步触发器 {#4-create-the-starter-trigger}

批准登录后，对 **Connect this daemon to Paseo Hub?** 和 **Allow Hub automations to run agents on this daemon?** 都回答 **Yes**。执行权限默认为否，因此请为本次设置显式开启。如果你回答了否，Home 会显示 daemon 已连接但无法运行 Agent，并给出修复命令：`paseo hub permissions grant hub.execute`。

然后运行：

```sh
paseo hub init
```

选择 **Custom endpoint** 并确认 `http://localhost:3000`。设置流程会复用你的登录和 daemon 连接，然后列出可用于此触发器的应用连接。如果只连接了一个 Slack 工作区，它会自动选择该连接。如果有多个可用连接，请选择 **Trigger connection**。如果没有任何连接就绪，设置流程会把你引导到 **Hub → Apps**，并在选择 Agent 或写入文件之前停止。

| 问题                               | 需要填写的内容                                                             |
| ---------------------------------- | -------------------------------------------------------------------------- |
| 起步 Agent 的 Provider、模型和模式 | 你 daemon 上的 Claude、Codex 或 OpenCode。建议的模型和模式条目即其默认值。 |
| 你的 Slack 成员 ID                 | `U01234567`，唯一允许触发机器人的账号。                                    |
| 现在部署吗？                       | 是，以在 Hub 中激活此触发器。                                              |

Provider 必须提供可选择的模型和执行模式。如果没有默认模式，请选择 Agent 应该使用的模式。Hub 以无人值守的方式运行 Agent，因此只接受 Claude、Codex 和 OpenCode，并会在部署前根据你的 daemon 检查模型、模式和选项。其他 Provider，或 daemon 不提供的值，会在这里就被拒绝，而不是等到第一次运行。

[查找 Slack ID](/docs/hub/triggers/slack#find-your-slack-ids) 说明了如何复制你的成员 ID。Slack 工作区来自所选的应用连接。

设置流程会校验触发器并写入：

```text
.paseo/
└── triggers/
    └── slack-help.yml
```

如果 `slack-help.yml` 已经存在，设置流程会在替换该文件之前询问你。其他文件保持不变。如果你拒绝部署，准备好后请在这个仓库中运行 `paseo hub deploy`。

## 5. 提及机器人 {#5-mention-the-bot}

在你邀请了机器人的频道中：

```text
@Paseo have a look
```

Hub 会在你的 daemon 上启动 Agent，并把它的回复发布在 Slack 子区中。终端会给出 **Triggers** 的链接，你可以在那里管理触发器并查看它的运行记录。如果什么都没运行，[活动](/docs/hub/activity)会告诉你这次提及是被过滤掉了，还是根本没有匹配到任何触发器。

## 接下来 {#next}

- [Hub 工作原理](/docs/hub/concepts)：一个事件如何变成你 daemon 上的一次 workflow 运行。
- [生成的起步触发器](/docs/hub/configuration#generated-starter-trigger)：逐字段解释设置流程写入的文件。
- [Workflow](/docs/hub/workflows)：路由、提示词和 Provider 回复。
- [Hub 安全](/docs/hub/security)：在扩大 `from_users` 或授予 Agent GitHub 权限之前请先阅读。

Hub 把本地状态保存在你的用户数据目录中，通常是 `~/.local/share/paseo-hub`。当本地运行不再满足需求时，[自托管](/docs/hub/self-hosting)介绍了部署和高级配置。
