---
title: Linear 触发器
description: 根据 Linear issue 评论、分配和项目范围变化启动 Hub Agent。
nav: Linear
---

# Linear 触发器 {#linear-triggers}

根据 Linear issue 活动在你的 Paseo daemon 上启动 Agent，并将回复发布回该 issue。请先在 **Integrations** 下连接 Linear 工作区（自托管 Hub 请先配置 [Linear 应用](/docs/hub/self-hosting/linear-app)）。

## 支持的事件 {#supported-events}

| `on`                         | 触发时机                                       |
| ---------------------------- | ---------------------------------------------- |
| `linear.comment_created`     | 新评论符合允许的作者和文本过滤条件。           |
| `linear.issue_assigned`      | 更新使 issue 被分配或重新分配给某位用户。      |
| `linear.issue_entered_scope` | issue 在配置范围内创建，或从范围外进入范围内。 |

同一个 Linear issue 上的事件默认会继续同一个 Agent 会话（`continuation: { mode: conversation }`）。

## 回复 issue 评论 {#respond-to-issue-comments}

将以下内容保存为 `.paseo/triggers/linear-help.yml`，替换连接 slug 和用户 UUID，并将 `run.target` 设为[已连接的 daemon](/docs/hub/daemons)：

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
  max_runtime: 30m
  idle_timeout: 10m
  prompt: |
    Summarize the request and suggest a next step.
    Post one reply using reply, then call finish_execution.

    <user-prompt>
    ${{ paseo.prompt }}
    </user-prompt>
  outputs:
    linear.reply:
      max: 1
      required: true
```

在仓库根目录部署触发器：

```sh
paseo hub deploy --dry-run
paseo hub deploy
```

使用允许的 Linear 账号发表一条 issue 评论，例如 `/paseo summarize this request`。Hub 会匹配前缀、在 `devbox` 上运行 Agent，并将回复作为评论发布到该 Linear issue。Hub 运行在 HTTPS 下时，回复会附带 **Open in Paseo** 链接。在 [Activity](/docs/hub/activity) 中可以查看运行记录。

## 在 issue 进入范围时开始工作 {#start-work-when-an-issue-enters-scope}

`linear.issue_entered_scope` 会在 issue 进入配置的过滤范围时运行一次，无论是创建时即在范围内，还是通过更新进入范围。对已在范围内的 issue 做后续编辑不会再次触发运行。

该事件要求设置 `filters.project`，对于自动项目 workflow 可以省略 `from_users`：

```yaml
name: linear-project-worker
on:
  linear.issue_entered_scope:
    connection: acme-linear
    filters:
      project: "22222222-2222-4222-8222-222222222222"
      states: ["33333333-3333-4333-8333-333333333333"]
      labels: ["44444444-4444-4444-8444-444444444444"]
      exclude_labels: ["55555555-5555-4555-8555-555555555555"]
run:
  target:
    daemon: devbox
    cwd: /workspace/project
    worktree:
      mode: branch-off
      newBranch: trigger-${{ paseo.execution.id }}
      base: origin/main
  agent:
    provider: codex
    mode: full-access
  max_runtime: 90m
  idle_timeout: 10m
  github:
    connection: acme-github
    repositories: [acme/project]
    permissions:
      contents: write
      pull_requests: write
  prompt: |
    Implement the Linear issue, open a pull request with gh, and post the PR URL using reply.
    Issue context:
    ${{ paseo.context }}
    Call finish_execution when done.
```

如果要改为在分配时触发，请使用 `linear.issue_assigned`，并用 `from_users` 指定允许执行分配的用户，用 `assignees` 指定目标 Linear 用户 UUID。

## 过滤条件与 Linear UUID {#filters-and-linear-uuids}

所有 Linear 过滤条件按逻辑与组合，且使用 Linear UUID 而不是显示名称：

| 过滤条件         | 必填场景                                          | 匹配内容                                        |
| ---------------- | ------------------------------------------------- | ----------------------------------------------- |
| `from_users`     | `linear.comment_created`、`linear.issue_assigned` | 允许发表评论或执行分配的用户 UUID。             |
| `project`        | `linear.issue_entered_scope`                      | Linear 项目 UUID。                              |
| `states`         | 可选                                              | issue 工作流状态 UUID（匹配列出的任一状态）。   |
| `assignees`      | 可选                                              | issue 负责人用户 UUID（匹配列出的任一负责人）。 |
| `labels`         | 可选                                              | issue 必须同时带有列出的每一个标签 UUID。       |
| `exclude_labels` | 可选                                              | 带有列出的任一标签 UUID 即阻止匹配。            |
| `pattern`        | 可选（`linear.comment_created`）                  | 评论正文开头必须匹配的前缀。                    |
| `contains`       | 可选（`linear.comment_created`）                  | 评论正文中任意位置必须包含的子串。              |

要在 Linear 中查找 UUID，请在 issue、项目或标签页面打开命令菜单（`Cmd+K` 或 `Ctrl+K`）并选择 **Copy model UUID**，或者通过 [Linear GraphQL API](https://linear.app/developers/graphql) 查询。

## 上下文与回复 {#context-and-replies}

在 `run.prompt` 中包含 `${{ paseo.context }}`，即可以 JSON 形式传入 issue 详情（编号、标题、描述、URL、项目、状态、负责人、标签）以及最多 49 条之前的 issue 评论。

Linear 触发器会自动授予 `reply` 工具（`linear.reply`），用于在触发运行的 issue 下发表评论。声明 `run.outputs.linear.reply` 可以设置 `max` 或 `required: true`。
