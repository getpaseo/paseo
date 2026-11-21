---
title: GitHub 访问
description: 为 Hub 触发器授予受控的 GitHub 安装令牌和隔离的 git 配置。
nav: GitHub 访问
---

# GitHub 访问 {#github-access}

触发器默认不授予 `GH_TOKEN` 或 git 推送权限。如果 Agent 需要通过 `git` 或 `gh` 推送分支、创建 Pull Request 或编辑 issue，请为触发器添加 `run.github` 块：

```yaml
name: implement-request
on:
  github.issue_comment_created:
    connection: acme-github
    filters:
      repo: acme/project
      contains: "@paseo"
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
      pull_requests: write
  prompt: |
    Implement the request, push a branch, and open a pull request with gh.
    Reply with the PR link using reply, then call finish_execution.

    <user-prompt>
    ${{ paseo.prompt }}
    </user-prompt>
```

`run.github` 适用于任意触发器来源，包括 Linear、Slack、Discord、定时任务和 webhook。

## 字段 {#fields}

| 字段           | 说明                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `connection`   | 来自 **Integrations** 的 GitHub 集成 slug。                                                                         |
| `repositories` | 令牌可访问的仓库列表。GitHub 事件触发时默认指向触发仓库；其他事件来源为必填项。                                     |
| `permissions`  | 安装令牌权限，例如 `contents`、`pull_requests` 和 `issues`（`read`、`write` 或 `admin`）。默认为 `contents: read`。 |
| `duration`     | 正的令牌有效期，最长 `1h`。默认为 `1h`（GitHub 上限）。                                                             |

请求的权限不能超过 GitHub App 安装本身被授予的权限。

保存或部署触发器时，Hub 会校验 `run.github` 字段结构、GitHub 事件过滤条件（`on.github.*`）以及 Agent 配置。Hub 会在运行启动时才查找 `run.github.connection` 并签发安装令牌，因此不存在的 slug、无法访问的仓库或超出范围的权限会在启动时失败，而不是在部署时失败。

## Agent 环境 {#agent-environment}

配置 `run.github` 后，Hub 会签发短期 GitHub App 安装令牌，并将 `GH_TOKEN` 和进程级 git 配置注入 Agent 环境：

- 提交使用 App 机器人登录名作为 `user.name`，使用 `<app-id>+<bot-login>@users.noreply.github.com` 作为 `user.email`。
- `git@github.com:` 和 `ssh://git@github.com/` 远程地址会重写为 HTTPS。
- `gh auth git-credential` 为 git 操作提供凭据。
- 会忽略用户全局和系统级 git 配置，并禁用交互式凭据提示。
- 不会读取或修改 daemon 主机自身的 git 身份和 SSH 凭据。

配置 `run.github` 时，`GH_TOKEN` 和 Hub 的 git 配置变量属于保留变量，`run.env` 不能覆盖它们。

## 会话延续与令牌生命周期 {#continuation-and-token-lifecycle}

使用 `run.github` 或在 `run.env` 中引用连接令牌时，同一活动会话上的后续请求会共享租用的令牌，直到所有活动请求结束。随后 Hub 会撤销租用的令牌，下一次到达会启动新 Agent 并签发新令牌。对于使用临时 GitHub 令牌的定时或 webhook 触发器，建议使用 `continuation: { mode: new }`。

## 其他连接值 {#other-connection-values}

可以通过 `run.env` 显式将其他组织连接的值传入 Agent 环境：

```yaml
run:
  env:
    SOME_TOKEN: "${{ paseo.connections.some-connection.token }}"
```

Hub 会在准备 Agent 环境时解析该表达式。主机与权限边界见 [Hub 安全](/docs/hub/security)。
