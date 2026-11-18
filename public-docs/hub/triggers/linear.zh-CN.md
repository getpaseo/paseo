---
title: Linear 触发器
description: 根据 Linear issue 的活动运行 Hub workflow，并向 issue 发布回复。
nav: Linear
---

# Linear 触发器 {#linear-triggers}

先在自托管 Hub 上[连接 Linear 应用](/docs/hub/self-hosting/linear-app)。

| 事件                         | 何时运行                                       |
| ---------------------------- | ---------------------------------------------- |
| `linear.comment_created`     | 新评论符合配置中的作者和文本过滤条件。         |
| `linear.issue_assigned`      | 更新使 issue 分配或重新分配给某位用户。        |
| `linear.issue_entered_scope` | issue 在指定范围内创建，或从范围外进入范围内。 |

在各事件中，将 `connection` 设置为 Hub 连接的 slug。按需使用 `filters.project`、`states`、`assignees`、`labels` 和 `exclude_labels` 限定 issue 范围。issue 必须带有所列的每个必需标签，带有任何排除标签则不匹配。这些过滤条件使用 Linear ID。可以在 Linear 的命令菜单中选择 **Copy model UUID**，也可以在 [Linear API](https://linear.app/developers/graphql) 中查询 ID。

`from_users` 指定允许发表评论或执行分配操作的用户。评论和分配触发器都需要此字段。对评论而言，`pattern` 匹配前缀，`contains` 匹配子串。

`linear.issue_entered_scope` 需要 `project`，自动 workflow 可以省略 `from_users`。事件在 issue 进入范围时运行，已在范围内的 issue 需要等到下一次进入。

## 部署触发器 {#deploy-a-trigger}

将以下内容保存为 `.paseo/triggers/linear-help.yml`。替换连接 slug 和用户 UUID，并将目标设为可以运行 Agent 的[已连接 daemon](/docs/hub/daemons)。使用该 daemon 提供的 Provider 和模式。

```yaml
name: linear-help
on:
  linear.comment_created:
    connection: acme-linear
    filters:
      from_users: ["11111111-1111-4111-8111-111111111111"]
      pattern: "/paseo "
run:
  target:
    daemon: devbox
    cwd: /workspace/project
  agent:
    provider: codex
    mode: full-access
    options:
      approval_policy: never
      sandbox_mode: read-only
  max_runtime: 20m
  prompt: |
    Summarize the request and suggest a next step.
    Post one reply using hub.reply, then call hub.finish_execution.
    ${{ paseo.prompt }}
  outputs:
    linear.reply:
      max: 1
      required: true
```

运行 `paseo hub deploy --dry-run`，然后运行 `paseo hub deploy`。使用允许的 Linear 账号发表一条新评论，例如 `/paseo summarize this request`。前缀匹配评论文本，`hub.reply` 会将评论发布到触发运行的 issue。可以在 [Activity](/docs/hub/activity) 中查看运行记录。
