---
title: GitHub 触发器
description: 由特定的 GitHub issue、PR、评论和标签启动 Hub workflow。
nav: GitHub
---

# GitHub 触发器 {#github-triggers}

使用语义化的 GitHub 事件，由某一个 GitHub 操作启动 workflow。把下面的 workflow 添加到一个仓库中（该仓库的 `.paseo/hub.yml` 定义了 `dev` 环境和 `codex` Agent），然后激活配置包。

## 分拣新 issue {#triage-new-issues}

`.paseo/workflows/triage-issue.yml`：

```yaml
name: triage-issue
on: github.issue_created
max_runtime: 2h
filters:
  repo: example/project
  from_users: [maintainer]
steps:
  - id: triage
    environment: dev
    max_runtime: 30m
    idle_timeout: 5m
    agent: codex
    github:
      connection: example-github
      repositories: [example/project]
      permissions:
        issues: write
    prompt:
      - text: |
          Triage the new issue. Add the appropriate labels and leave a short comment
          explaining the result with gh. Use this event context:
          ${{ paseo.context }}
          Call hub.finish_execution when done.
```

`github.issue_created` 只在有人创建 issue 时触发。`from_users` 是必填的，匹配引发该事件的 GitHub 登录名。

## 审查新的 PR {#review-new-pull-requests}

`.paseo/workflows/review-pull-request.yml`：

```yaml
name: review-pull-request
on: github.pull_request_created
max_runtime: 2h
filters:
  repo: example/project
  from_users: [maintainer]
steps:
  - id: review
    environment: dev
    max_runtime: 90m
    idle_timeout: 10m
    agent: codex
    github:
      connection: example-github
      repositories: [example/project]
      permissions:
        contents: read
        pull_requests: write
    prompt:
      - text: |
          Review the new pull request and submit your findings with gh. Use this event context:
          ${{ paseo.context }}
          Call hub.finish_execution when done.
```

`github.pull_request_created` 只在有人创建 PR 时触发。

## 回复新评论 {#respond-to-new-comments}

`.paseo/workflows/respond-to-issue-comment.yml`：

```yaml
name: respond-to-issue-comment
on: github.issue_comment_created
max_runtime: 2h
filters:
  repo: example/project
  contains: "@paseo"
  from_users: [maintainer]
steps:
  - id: respond
    environment: dev
    max_runtime: 30m
    idle_timeout: 5m
    agent: codex
    github:
      connection: example-github
      repositories: [example/project]
      permissions:
        issues: write
    prompt:
      - text: |
          Respond to the new issue comment with gh. Address this request:
          ${{ paseo.prompt }}
          Use this event context:
          ${{ paseo.context }}
          Call hub.finish_execution when done.
```

`.paseo/workflows/respond-to-pull-request-comment.yml`：

```yaml
name: respond-to-pull-request-comment
on: github.pull_request_comment_created
max_runtime: 2h
filters:
  repo: example/project
  contains: "@paseo"
  from_users: [maintainer]
steps:
  - id: respond
    environment: dev
    max_runtime: 30m
    idle_timeout: 5m
    agent: codex
    github:
      connection: example-github
      repositories: [example/project]
      permissions:
        pull_requests: write
    prompt:
      - text: |
          Respond to the new pull-request conversation comment with gh. Address this request:
          ${{ paseo.prompt }}
          Use this event context:
          ${{ paseo.context }}
          Call hub.finish_execution when done.
```

issue 讨论使用 `github.issue_comment_created`，PR 对话使用 `github.pull_request_comment_created`。针对某一行改动的评论属于 diff 评论，由旧的 `github.pull_request_review_comment` 事件处理。

对于 `github.issue_comment_created`、`github.pull_request_comment_created`、`github.issue_comment` 和 `github.pull_request_review_comment`，Hub 接受投递时会回应 👀，Agent 启动时回应 🚀，完成时回应 👍，失败时回应 👎。

## issue 就绪时开始工作 {#start-work-when-an-issue-becomes-ready}

`.paseo/workflows/implement-ready-issue.yml`：

```yaml
name: implement-ready-issue
on: github.issue_label_added
max_runtime: 2h
filters:
  repo: example/project
  label: ready-for-agent
  from_users: [maintainer]
steps:
  - id: implement
    environment: dev
    max_runtime: 90m
    idle_timeout: 10m
    agent: codex
    github:
      connection: example-github
      repositories: [example/project]
      permissions:
        contents: write
        issues: write
        pull_requests: write
    prompt:
      - text: |
          Implement the issue that was marked ready for an agent. Create a branch,
          push it, and open a pull request with gh. Use this event context:
          ${{ paseo.context }}
          Call hub.finish_execution when done.
```

`label` 匹配此次事件添加的标签。匹配不区分大小写，因此 `ready-for-agent` 也能匹配 `Ready-For-Agent`。

## 选择事件 {#choose-the-event}

| `on`                                  | 触发时机               |
| ------------------------------------- | ---------------------- |
| `github.issue_created`                | 创建 issue。           |
| `github.pull_request_created`         | 创建 PR。              |
| `github.issue_comment_created`        | 在 issue 上创建评论。  |
| `github.pull_request_comment_created` | 在 PR 上创建对话评论。 |
| `github.issue_label_added`            | 为 issue 添加标签。    |
| `github.pull_request_label_added`     | 为 PR 添加标签。       |

issue 上的评论选择 `github.issue_comment_created`，PR 上的对话评论选择 `github.pull_request_comment_created`。GitHub 把两者都作为 issue 评论投递；Hub 会替你区分它们。针对某一行改动的评论属于 diff 评论，由旧的 `github.pull_request_review_comment` 事件处理。

## 过滤 GitHub 事件 {#filter-github-events}

每个来源于外部的 workflow 都需要一个非空的 `from_users` 允许列表。GitHub 过滤器以 AND 方式组合：仓库、连接、发送者、内容、变化的标签以及要求当前具有的标签都必须匹配。

对于 issue 和 PR 事件，`contains` 和 `pattern` 检查标题加正文。对于评论事件，它们检查评论正文。`contains` 是子串匹配；`pattern` 匹配开头。

当被添加的标签本身很重要时，请在 `github.issue_label_added` 或 `github.pull_request_label_added` 中使用 `label`。当条目必须当前具有列出的每一个标签时，请使用 `labels`。两者比较标签时都不区分大小写。例如，`labels: [bug, backend]` 要求同时具有这两个标签，而不是其中任意一个。

[配置参考](/docs/hub/configuration/hub-yml#github-events-and-filters)列出了所有 GitHub 事件和过滤器。

## 旧事件兼容 {#legacy-event-compatibility}

现有的 workflow 使用 `github.issues`、`github.issue_comment`、`github.pull_request_review`、`github.pull_request_review_comment` 和 `github.push` 时行为保持不变。新的 workflow 请优先使用上面的语义化事件。语义化 workflow 和旧 workflow 可能同时匹配同一次投递，因此会各自启动一次运行。

GitHub 触发器不授予任何 token。权限来自需要它的 step 上的 `github` 块。GitHub 没有 `hub.reply` 能力；Agent 在声明的连接、仓库和权限范围内通过 `gh` 执行操作。
