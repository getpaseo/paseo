---
title: Hub 常见问题
description: 关于 Paseo Hub 中触发器、Provider、集成、daemon 和回复的常见问题。
nav: 常见问题
---

# Hub 常见问题 {#hub-faq}

## 使用 Paseo 必须搭配 Hub 吗？ {#do-i-need-hub-to-use-paseo}

不需要。没有 Hub，Paseo 也可以在你的机器上运行 Agent。Hub 在你的 daemon 之上增加了事件触发器、周期性定时任务、入站 webhook、共享运行历史和团队访问能力。

## Hub 可以运行哪些 Agent Provider？ {#which-agent-providers-can-hub-run}

Hub 可以运行你已连接的 Paseo daemon 上配置的任意 Provider，包括 Claude Code、Codex、OpenCode、Pi，以及自定义或插件 Provider。创建或编辑触发器时，Hub 会向该 daemon 查询可用的 Provider、模型、执行模式和思考选项。

## 触发器保存在哪里？ {#where-do-triggers-live}

你可以直接在 Hub 控制台的 **Triggers** 中创建和编辑触发器，也可以将它们作为自包含的 `.paseo/triggers/*.yml` 文件保存在仓库中，并通过 `paseo hub deploy` 部署。两种方式使用相同的 YAML 结构和校验。

## 一个组织可以连接多个 GitHub、Linear、Slack 或 Discord 工作区吗？ {#can-one-organization-connect-multiple-github-linear-slack-or-discord-workspaces}

可以。集成归组织所有，位于 **Integrations** 下，每个已连接的工作区、服务器或 GitHub 安装都有自己的 slug。在触发器事件上设置 `connection` 即可指定某一个集成。

## 谁可以触发 Agent？ {#who-can-trigger-an-agent}

对于 GitHub、Slack、Discord 以及 Linear 评论和分配触发器，Hub 会对照 `from_users` 检查发送者。设置为 `from_users: ["*"]`（控制台 **Audience: Everyone** 的默认值）时允许任意发送者，列出具名登录名或用户 ID 时则只允许这些账号。

`linear.issue_entered_scope` 要求设置 `filters.project` 且可以省略 `from_users`。入站 webhook 通过 Bearer 密钥（`whsec_...`）验证调用方，定时任务则按 Hub 自己的时钟触发。

## Agent 可以回复到 GitHub、Linear、Slack 或 Discord 吗？ {#can-an-agent-reply-back-to-github-linear-slack-or-discord}

可以。对话类触发器（`github.*`、`linear.*`、`slack.*`、`discord.*`）会自动授予 Hub MCP `reply` 工具，将回复发布回触发运行的 issue、Pull Request 或讨论串。

添加 `run.outputs` 可设置 `max` 或 `required: true`，并在 `run.prompt` 中指示 Agent 调用 `reply` 和 `finish_execution`。当 Hub 运行在 HTTPS 下时，回复会为已登录的组织成员附带 **Open in Paseo** 链接。

## 定时任务或 webhook 可以发送到 Slack 或 Discord 吗？ {#can-a-schedule-or-webhook-post-to-slack-or-discord}

可以。添加 [`run.tools`](/docs/hub/tools)（或在控制台中配置 **Integration tools**），即可为任意触发器授予针对显式 Slack 或 Discord 频道 ID 的受控 `read` 或 `post` 工具。

## daemon 离线时会发生什么？ {#what-happens-when-a-daemon-is-offline}

如果目标 daemon 离线时 Hub 接受了 Provider 事件或入站 webhook，Hub 会将该运行保留在队列中并重试派发，直到达到 `max_runtime` 截止时间。如果 daemon 在截止时间前重新上线，排队中的运行会自动启动，因此重新发送事件可能会造成重复运行。

请等到 **Activity** 显示该运行已进入终态失败后再发送新事件。定时触发器会在未来计划时间继续触发，并在前一次运行活跃时跳过重叠的计划。

## 退出登录会断开我的 daemon 吗？ {#does-logging-out-disconnect-my-daemon}

不会。CLI 登录是保存在 `PASEO_HOME` 下的个人凭据，而已注册的 daemon 持有自己的关系凭据。

交互式 `paseo hub logout` 会在删除登录前询问是否断开连接到同一 Hub 的 daemon。非交互式和 `--json` 退出登录除非传入 `--disconnect-daemon`，否则不会断开 daemon。

## 不使用 GitHub 也能用 Hub 吗？ {#can-i-use-hub-without-github}

可以。不连接 GitHub 也可以使用 Linear、Slack、Discord、定时任务和入站 webhook。只有在需要 GitHub 触发器或 [`run.github`](/docs/hub/github) 仓库令牌时才需要 GitHub。
