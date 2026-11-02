---
title: Hub 活动
description: 查看 Hub 如何处理一个事件，区分被过滤和未路由的事件，并排查没有任何反应的触发器。
nav: 活动
---

# Hub 活动 {#hub-activity}

Hub 接受的每个事件都会被记录，无论它是否运行了任何内容。这份记录就是你排查触发器的依据。

## 在哪里查看 {#where-to-look}

**Project → Activity** 列出已路由的触发器运行及其执行状态。

**Connections → Known unrouted events** 是组织级视图，列出已接受但没有启动任何已配置触发器的 Provider 事件。Hub 会记录以下四种原因之一：

| 原因                        | 含义                                         |
| --------------------------- | -------------------------------------------- |
| `no_project_route`          | 没有为该事件配置项目路由                     |
| `no_trigger_for_source`     | 没有已配置的触发器处理该事件来源             |
| `trigger_filters_rejected`  | 有触发器处理该来源，但它的过滤器拒绝了该事件 |
| `configuration_unavailable` | 无法解析相关的配置或连接                     |

## 我提及了机器人，但什么都没发生 {#nothing-happened-when-i-mentioned-the-bot}

按这个列表逐项排查。

1. **事件是否出现在项目的 Activity 中？** 如果没有，请查看 **Connections → Known unrouted events**，根据其中的原因区分路由、来源、过滤器和配置方面的失败。
2. **事件是否出现在任何地方？** 如果没有，说明事件从未到达 Hub。请查看 Provider 自己的投递日志：GitHub 的 App → Advanced → Recent Deliveries，或 Slack 的 Event Subscriptions 页面。然后确认应用订阅了该事件类型。
3. **你的用户是否在 `from_users` 中？** 这是最常见的原因。GitHub 使用你的登录名；Slack 和 Discord 使用用户 ID，而不是显示名称。参见[查找 Slack ID](/docs/hub/triggers/slack#find-your-slack-ids) 和[查找 Discord ID](/docs/hub/triggers/discord#find-your-discord-ids)。
4. **调用是否匹配？** 在 GitHub 上，评论正文中必须出现 `contains`。在 Slack 和 Discord 上，必须提及机器人，并且提及之后的文本必须以 `pattern`（或其旧别名 `contains`）开头。
5. **你以为生效的配置是否真的生效？** Configuration 标签页显示当前生效的版本和上一次同步尝试。推送失败时，旧版本会继续生效。
6. **daemon 是否已连接？** daemon 离线时派发会失败，并报告 `daemon_not_connected`。
7. **是否运行了但提前停止？** 把这次执行与 step 中编写的 `idle_timeout`、`max_runtime` 以及 workflow 的 `max_runtime` 进行比较。这三个限制都在 workflow 中显式声明。
8. **是否运行了但什么都没投递？** 检查 step 的提示词。没有被告知调用 `hub.reply` 和 `hub.finish_execution` 的 Agent，可能只在自己的对话记录中回答，而从不回报。参见[告诉 Agent 调用哪个工具](/docs/hub/workflows#tell-the-agent-which-tool-to-call)。

## 同步失败 {#sync-failures}

Configuration 标签页显示最近的同步状态：

| 状态                    | 处理方式                                 |
| ----------------------- | ---------------------------------------- |
| Fetch failed            | 该提交中缺少文件，或者 App 无法读取仓库  |
| Invalid                 | 校验失败，或者配置引用了无法访问的内容   |
| Superseded push ignored | 更新的提交已经移动了分支头；没有任何问题 |

“引用了无法访问的内容”通常是指安装未覆盖的仓库、已被重命名的 daemon，或已不存在的连接 slug。参见 [Hub 工作原理](/docs/hub/concepts)。

## 不会重试 {#nothing-is-retried}

Hub 不会让事件排队。因 daemon 离线而失败的派发会一直保持失败，所以请在 daemon 恢复后重新触发。
