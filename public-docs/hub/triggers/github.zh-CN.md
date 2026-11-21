---
title: GitHub 触发器
description: 根据 GitHub issue、Pull Request、评论、推送和标签启动 Hub Agent。
nav: GitHub
---

# GitHub 触发器 {#github-triggers}

使用语义化 GitHub 事件，从单个 GitHub 操作启动 Agent。请先在 **Integrations** 下连接 GitHub 账号（自托管 Hub 请先配置 [GitHub App](/docs/hub/self-hosting/github-app)）。

## 分拣新 issue {#triage-new-issues}

`.paseo/triggers/triage-issue.yml`：

```yaml
name: triage-issue
on:
  github.issue_created:
    connection: acme-github
    filters:
      repo: acme/project
      from_users: [maintainer]
run:
  target:
    daemon: devbox
    cwd: /workspace/project
  agent:
    provider: codex
    mode: full-access
  max_runtime: 30m
  idle_timeout: 5m
  github:
    connection: acme-github
    repositories: [acme/project]
    permissions:
      issues: write
  prompt: |
    Triage the new issue, apply appropriate labels with gh, and post a short summary using reply.
    Event context:
    ${{ paseo.context }}
    Call finish_execution when done.
```

`github.issue_created` 仅在打开新 issue 时触发。`from_users` 为必填项，匹配触发该事件的 GitHub 登录名。

## 审查 Pull Request {#review-pull-requests}

`.paseo/triggers/review-pr.yml`：

```yaml
name: review-pr
on:
  github.pull_request_ready_for_review:
    connection: acme-github
    filters:
      repo: acme/project
      from_users: [maintainer]
run:
  target:
    daemon: devbox
    cwd: /workspace/project
  agent:
    provider: codex
    mode: full-access
  max_runtime: 90m
  idle_timeout: 10m
  github:
    connection: acme-github
    repositories: [acme/project]
    permissions:
      contents: read
      pull_requests: write
  prompt: |
    Review the pull request and submit your findings with gh.
    Fetch live PR state with gh pr view before reviewing and before posting.
    Skip posting if the PR is draft or its head SHA changed.
    Event context:
    ${{ paseo.context }}
    Call finish_execution when done.
```

使用 `github.pull_request_created` 在 Pull Request 打开时运行，使用 `github.pull_request_ready_for_review` 等待草稿转为可审查，或使用 `github.pull_request_synchronized` 在向打开的 Pull Request 推送新提交时运行。

Pull Request 上下文包含 `github.pull_request.draft` 和 `github.pull_request.head_sha`。把 Pull Request 转回草稿不会取消已经在运行中的任务，因此在提交审查前请通过 `gh pr view` 检查实时状态。

## 回复评论 {#respond-to-comments}

`.paseo/triggers/respond-issue-comment.yml`：

```yaml
name: respond-issue-comment
on:
  github.issue_comment_created:
    connection: acme-github
    filters:
      repo: acme/project
      contains: "@paseo"
      exclude_contains: "@paseo-deploy"
      from_users: [maintainer]
run:
  target:
    daemon: devbox
    cwd: /workspace/project
  agent:
    provider: codex
    mode: full-access
  max_runtime: 30m
  idle_timeout: 5m
  prompt: |
    Answer the issue comment using reply, then call finish_execution.

    <user-prompt>
    ${{ paseo.prompt }}
    </user-prompt>
    Event context:
    ${{ paseo.context }}
  outputs:
    github.reply:
      max: 1
      required: true
```

issue 评论使用 `github.issue_comment_created`，Pull Request 对话评论使用 `github.pull_request_comment_created`。GitHub 会把两者都当作 issue 评论投递，Hub 会替你区分。

`exclude_contains` 会跳过包含其他触发器专用文本的评论，例如另一个命令前缀。

对于 `github.issue_comment_created`、`github.pull_request_comment_created`、`github.issue_comment` 和 `github.pull_request_review_comment`，Hub 会随运行状态添加表情回应：接收时 👀、启动时 🚀、完成时 👍、失败时 👎。

## 根据标签开始工作 {#start-work-on-a-label}

`.paseo/triggers/implement-ready-issue.yml`：

```yaml
name: implement-ready-issue
on:
  github.issue_label_added:
    connection: acme-github
    filters:
      repo: acme/project
      label: ready-for-agent
      from_users: [maintainer]
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
      issues: write
      pull_requests: write
  prompt: |
    Implement the labeled issue on this worktree branch, push it, and open a pull request with gh.
    Post the PR link to the issue using reply, then call finish_execution.
    Event context:
    ${{ paseo.context }}
```

`label` 匹配本次事件添加的精确标签（不区分大小写）。为 Pull Request 添加标签时请使用 `github.pull_request_label_added`。

## 支持的事件 {#supported-events}

| `on`                                   | 触发时机                             |
| -------------------------------------- | ------------------------------------ |
| `github.issue_created`                 | 打开了 issue。                       |
| `github.pull_request_created`          | 打开了 Pull Request。                |
| `github.pull_request_ready_for_review` | 草稿 Pull Request 被标记为可审查。   |
| `github.pull_request_synchronized`     | 向打开的 Pull Request 推送了新提交。 |
| `github.issue_comment_created`         | issue 上发表了评论。                 |
| `github.pull_request_comment_created`  | Pull Request 上发表了对话评论。      |
| `github.issue_label_added`             | 为 issue 添加了标签。                |
| `github.pull_request_label_added`      | 为 Pull Request 添加了标签。         |

当你需要 diff 审查评论或推送事件时，Hub 也接受原始 webhook 事件名称（`github.issues`、`github.issue_comment`、`github.pull_request`、`github.pull_request_review`、`github.pull_request_review_comment`、`github.push`）。新建触发器建议优先使用语义化事件。

## 过滤条件 {#filters}

每个 GitHub 触发器都要求设置非空的 `from_users` 白名单。所有提供的过滤条件按逻辑与组合。

对于 `github.push`，请使用 `from_users: ["*"]` 接受来自任意发送者的推送。Hub 不会从推送事件中提取发送者的登录名，因此指定登录名的列表始终无法匹配。

| 过滤条件           | 适用于                                                        | 含义                                                       |
| ------------------ | ------------------------------------------------------------- | ---------------------------------------------------------- |
| `from_users`       | 所有 GitHub 事件                                              | 允许触发运行的 GitHub 登录名。                             |
| `repo`             | 所有 GitHub 事件                                              | `owner/name` 形式的仓库。                                  |
| `contains`         | issue、Pull Request 和评论事件                                | issue 或 PR 标题加正文中的子串，或评论正文中的子串。       |
| `exclude_contains` | issue、Pull Request 和评论事件                                | 命中后会阻止匹配的子串。                                   |
| `pattern`          | issue、Pull Request 和评论事件                                | 上述同一文本开头的前缀。                                   |
| `label`            | `github.issue_label_added`、`github.pull_request_label_added` | 必填。本次投递添加的标签，不区分大小写。                   |
| `labels`           | issue、Pull Request 和评论事件                                | issue 或 PR 当前必须同时具备所有列出的标签，不区分大小写。 |

## 回复与 GitHub 令牌 {#replies-and-github-tokens}

针对 issue 或 Pull Request 的 GitHub 触发器会自动授予 `reply` 工具（`github.reply`），用于在对应 issue 或 Pull Request 下发表评论，并在 Hub 使用 HTTPS 时附带 **Open in Paseo** 链接。如需限制 `max` 次数或设置 `required: true`，请添加 `run.outputs.github.reply`。

GitHub 触发器默认不授予 `GH_TOKEN`。如果 Agent 需要通过 `git` 或 `gh` 推送分支、创建 Pull Request 或编辑标签，请添加 [`run.github` 块](/docs/hub/github)。
