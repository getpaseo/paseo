---
title: Hub 活动
description: 查看触发器运行记录、区分被过滤事件与未路由事件，以及排查未触发的问题。
nav: 活动
---

# Hub 活动 {#hub-activity}

Hub 会记录每一次已接受的事件，无论它是否启动了运行。使用 **Activity** 和 **Integrations** 查看投递并排查触发器。

## 在哪里查看 {#where-to-look}

**Activity** 列出组织的触发器运行记录，包括触发来源、daemon、执行状态、回复和错误。

**Integrations → Known unrouted events** 列出已接受但未启动触发器的 Provider 事件。Hub 记录以下四种原因之一：

| 原因                        | 含义                                   |
| --------------------------- | -------------------------------------- |
| `no_project_route`          | 没有已启用的路由匹配该事件的集成或资源 |
| `no_trigger_for_source`     | 没有已启用的触发器处理该事件来源       |
| `trigger_filters_rejected`  | 有触发器处理该来源，但被过滤条件拒绝   |
| `configuration_unavailable` | 无法解析引用的触发器或集成             |

## 事件到达后没有任何反应 {#nothing-happened-when-an-event-arrived}

按以下顺序排查：

1. 打开 **Activity**。如果事件未出现在那里，请检查 **Integrations → Known unrouted events** 并查看记录的原因。
2. 如果两处都没有，说明事件从未到达 Hub。检查 Provider 自己的投递日志（GitHub **App → Advanced → Recent Deliveries**、Linear webhook 日志或 Slack **Event Subscriptions**），并确认应用已订阅对应事件类型。
3. 检查 `from_users`。GitHub 使用登录名，Linear、Slack 和 Discord 使用用户 ID（参见 [Linear](/docs/hub/triggers/linear#filters-and-linear-uuids)、[Slack](/docs/hub/triggers/slack#find-your-slack-ids)、[Discord](/docs/hub/triggers/discord#find-your-discord-ids)）。
4. 检查文本过滤条件（`contains`、`pattern` 以及 GitHub 的 `exclude_contains`）。在 Slack 和 Discord 上，消息必须提及机器人，且任何 `pattern` 都必须紧跟在提及之后。
5. 在 **Triggers** 下确认触发器已启用。
6. 在 **Daemons** 下确认目标 daemon 已连接并拥有 `hub.execute` 权限。
7. 如果运行已启动但提前停止，请将其持续时间与 `max_runtime`、`idle_timeout` 和 `startup_timeout` 进行对比。
8. 如果运行已完成但没有回复，请检查 `run.prompt`。提示词必须明确告诉 Agent 调用 `reply`（或 `slack_post` / `discord_post`）和 `finish_execution`。

## Webhook 与定时运行 {#webhook-and-schedule-runs}

入站 webhook 投递会以 `webhook.received` 出现在 **Activity** 中。如果 HTTP `POST` 返回错误状态码（`400`、`401`、`403`、`409`、`413` 或 `429`），参见[入站 webhook](/docs/hub/triggers/webhooks#request-limits-and-responses)。

定时运行会以 `schedule.tick` 出现在 **Activity** 中。当某次定时运行仍在进行时，Hub 会跳过该触发器新到期的计划，直到当前运行完成或失败。
