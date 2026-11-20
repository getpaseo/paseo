---
title: Hub 快速开始
description: 在本地运行 Hub，用你机器上的 Agent 回复 Slack 提及。
nav: 快速开始
---

# Hub 快速开始 {#hub-quickstart}

在你的机器上运行 Hub，通过 Socket Mode 连接 Slack 而无需公开服务器，并用你仓库中的 Agent 回复提及。

你需要已安装并运行的 [Paseo](/docs)、Node.js，以及一个可以创建应用的 Slack 工作区。

## 1. 启动 Hub {#1-start-hub}

在本地运行 Hub：

```sh
npx @getpaseo/hub
```

打开输出的地址（通常为 <http://localhost:3000>）并创建管理员账号。首次运行不需要外部数据库、Docker 或环境变量。Hub 会自动创建内嵌数据库和你的组织。

Hub 会打开 **Home**，提供四步引导流程：连接一个集成、连接一个 daemon、创建一个触发器并运行它。

## 2. 连接 Slack {#2-connect-slack}

打开 **Apps → Slack**，保持选中 **Socket Mode**。Socket Mode 由 Hub 主动向外连接，不需要公开 HTTPS 地址。

按照 Hub 中的步骤，使用生成的 manifest 创建 Slack 应用，创建带有 `connections:write` 权限的 App-level token，然后安装应用。将 App-level token 和 Bot token 粘贴回 Hub，选择 **Connect Slack**。

将机器人邀请到你要提及它的 Slack 频道：

```text
/invite @Paseo
```

之后可以在 **Apps** 下随时配置 GitHub、Linear 和 Discord。

## 3. 连接你的机器 {#3-connect-your-machine}

进入 Agent 要工作的仓库目录，然后登录本地 Hub：

```sh
paseo hub login http://localhost:3000
```

在浏览器中批准登录。在终端中，对是否将此 daemon 连接到 Paseo Hub 以及是否允许 Hub 自动化在此 daemon 上运行 Agent 都选择 **Yes**。

执行权限默认为关闭。如果你选择了否，之后可以在该机器上授予权限：

```sh
paseo hub permissions grant hub.execute
```

## 4. 创建入门触发器 {#4-create-the-starter-trigger}

在同一仓库目录中生成并部署入门触发器：

```sh
paseo hub init
```

选择本地 Hub 地址（`http://localhost:3000`），如果出现提示则选择你的 Slack 连接。设置过程会询问三个问题：

| 提示                            | 需要提供的值                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| 入门 Agent Provider、模型和模式 | daemon 上已启用、且同时提供可选模型和至少一个执行模式的 Provider（例如 Claude、Codex、OpenCode）。 |
| 你的 Slack 成员 ID              | 你的 Slack ID，例如 `U01234567`。只有列出的用户才能触发机器人。                                    |
| 是否立即部署？                  | 选择是，在 Hub 中校验并安装该触发器。                                                              |

不提供执行模式的 Provider（例如 Pi）会被 `paseo hub init` 跳过，但仍可在 Hub 控制台或 `.paseo/triggers/*.yml` 中配置并通过 `paseo hub deploy` 部署。

查看[查找 Slack ID](/docs/hub/triggers/slack#find-your-slack-ids)了解如何复制成员 ID。

设置流程会对照已连接的 daemon 校验 Agent 配置，写入 `.paseo/triggers/slack-help.yml`，并完成部署。如果你在设置时跳过了部署，准备好后在仓库根目录运行 `paseo hub deploy` 即可。

你也可以直接在 Hub 控制台的 **Triggers** 页面创建和编辑触发器。

## 5. 提及机器人 {#5-mention-the-bot}

在邀请了机器人的 Slack 频道中发送提及：

```text
@Paseo summarize this repository
```

Hub 会在你的 daemon 上启动 Agent，并在 Slack 讨论串中发布回复。在 Hub 中打开 **Triggers** 或 **Activity** 可以查看投递和运行记录。当 Hub 运行在 HTTPS 下时，回复还会附带 **Open in Paseo** 链接，方便组织成员直接打开实时会话。

如果没有运行，请检查 [Activity](/docs/hub/activity) 区分被过滤的提及和未路由的事件。

## 下一步 {#next}

- [Hub 的工作原理](/docs/hub/concepts)介绍集成、daemon、触发器和会话延续。
- [触发器](/docs/hub/triggers)列出所有事件来源，包括 GitHub、Linear、定时任务和 webhook。
- [生成的入门触发器](/docs/hub/configuration#generated-starter-trigger)逐字段说明 `.paseo/triggers/slack-help.yml`。
- [Hub 安全](/docs/hub/security)在你扩大白名单或授予更多权限前介绍主机边界和安全配置。

Hub 默认将本地数据保存在 `~/.local/share/paseo-hub`。准备使用 PostgreSQL 或公开 HTTPS 部署时，请参阅[自托管](/docs/hub/self-hosting)。
