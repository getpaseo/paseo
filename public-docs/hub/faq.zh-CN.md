---
title: Hub 常见问题
description: 关于 Paseo Hub 中项目、连接、配置和 daemon 的常见问题。
nav: 常见问题
---

# Hub 常见问题 {#hub-faq}

## 使用 Paseo 需要 Hub 吗？ {#do-i-need-hub-to-use-paseo}

不需要。没有 Hub，Paseo 也能在你的机器上运行 Agent。Hub 增加的是单个 daemon 自身做不到的事：由外部活动启动 Agent、版本化的配置、共享的运行记录，以及团队访问。

## 一个组织可以连接多个 GitHub 组织吗？ {#can-one-organization-connect-several-github-organizations}

可以。连接属于组织，添加数量没有上限。每个连接都有自己的 slug。

## 应该如何把工作划分为项目？ {#how-should-i-split-my-work-into-projects}

按你现有的划分方式：每个产品一个、每个团队一个，或每个仓库一个。一个项目拥有一组环境和触发器，因此需要一起配置和部署的内容应该放在同一个项目中。

项目共享组织的连接和 daemon，所以新建项目并不意味着要重新连接 GitHub 或重新注册 daemon。

## 两个项目可以监听同一个仓库吗？ {#can-two-projects-watch-the-same-repository}

可以，两个都会运行。仓库不归某个项目所有。

## 配置可以放在被监听的仓库之外吗？ {#can-the-configuration-live-somewhere-other-than-the-repository-being-watched}

可以。`filters.repo` 可以指定组织能访问的任意仓库，因此一个私有仓库可以保存监听公开仓库的 workflow 的 `.paseo` 配置包。请保护好推送权限，因为配置包决定了组织的连接、daemon、Agent 和输出。

## 现在触发器放在哪里？ {#where-do-triggers-go-now}

每个触发器及其有序的 step 都放在一个直接位于 `.paseo/workflows/*.yml` 的文件中。`hub.yml` 只包含命名的环境和 Agent。Hub 会拒绝整体式的 `triggers` 配置，而不是转换它。

## 可以在控制台中编辑配置吗？ {#can-i-edit-configuration-in-the-dashboard}

可以，前提是使用手动来源。使用 GitHub 来源的项目在控制台中是只读的，因为仓库才是唯一的事实来源。切换到手动会把当前生效的版本复制到编辑器中，并停止同步。

## 谁可以触发 Agent？ {#who-can-trigger-an-agent}

只有触发器 `from_users` 中列出的用户。该字段是必填的，不能为空。

## 如果 daemon 离线会怎样？ {#what-happens-if-the-daemon-is-offline}

派发失败，事件会被记录为失败。不会排队，所以请在 daemon 恢复后重新触发。

## 退出登录会断开我的 daemon 吗？ {#does-logging-out-disconnect-my-daemon}

不会。保存的 CLI 登录是一个人员的组织凭据；已注册的 daemon 有自己的关系凭据。交互式的 `paseo hub logout` 会询问是否断开与同一 Hub 相关的 daemon。拒绝是正常的；除非你传入 `--disconnect-daemon`，JSON 或非交互式的退出登录永远不会断开 daemon。

## Agent 可以回复到 Slack 或 Discord 吗？ {#can-an-agent-reply-back-to-slack-or-discord}

可以。在 step 上设置 `allow_outputs`，并在提示词中告诉 Agent 调用 `hub.reply`。[告诉 Agent 调用哪个工具](/docs/hub/workflows#tell-the-agent-which-tool-to-call)展示了提示词写法；回复次数限制和 `required` 见[输出能力参考](/docs/hub/configuration/hub-yml#output-capabilities)。

GitHub 没有回复能力；请给 step 添加 [`github` 块](/docs/hub/github)，Agent 会通过 `gh` CLI 执行操作。

## 不用 GitHub 可以吗？ {#can-i-use-it-without-github}

可以。使用手动配置并连接 Discord 或 Slack 的项目可以正常工作。只有当你想从仓库同步配置时才需要 GitHub。
