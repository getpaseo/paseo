---
title: GitHub 访问
description: 为 workflow 中的某个 step 授予限定范围的 GitHub token 和 git 设置。
nav: GitHub 访问
---

# GitHub 访问 {#github-access}

触发器不授予任何 GitHub 凭据。请在需要仓库权限的 step 上添加 `github` 块：

```yaml
name: implement-request
on: github.issue_comment
max_runtime: 2h
filters:
  repo: example/project
  contains: "@paseo"
  from_users: [maintainer]
steps:
  - id: implement
    environment: development
    max_runtime: 90m
    idle_timeout: 10m
    agent: codex
    github:
      connection: example-github
      repositories: [example/project]
      permissions:
        contents: write
        pull_requests: write
    prompt:
      - text: |
          Implement the request, push a branch, and open a pull request with gh.
          Call hub.finish_execution when done.
          ${{ paseo.prompt }}
```

Agent 可以在声明的仓库和权限范围内使用 `git` 和 `gh`。当请求延续某个 Agent 时 token 的生命周期，见 [Agent 延续](/docs/hub/configuration/hub-yml#agent-continuation)。

## 字段 {#fields}

| 字段           | 说明                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------- |
| `connection`   | 项目的 GitHub 连接 slug。                                                                    |
| `repositories` | token 可以访问的仓库。在由 GitHub 触发的运行中，默认是触发它的仓库。其他 Provider 必须填写。 |
| `permissions`  | 安装 token 的权限，例如 `contents`、`pull_requests` 和 `issues`。默认为 `contents: read`。   |
| `duration`     | token 的有效期，为正数，最长 `1h`。默认为 `1h`，即 GitHub 允许的最大值。                     |

请求的权限不能超过 GitHub App 安装所具有的权限。如果无法解析连接、仓库或权限，激活和派发会明确失败。

## Agent 环境 {#agent-environment}

Hub 通过环境变量提供 `GH_TOKEN` 以及进程级的 git 配置：

- 提交使用 App 机器人的登录名作为 `user.name`，使用 `<app-id>+<bot-login>@users.noreply.github.com` 作为 `user.email`。
- `git@github.com:` 和 `ssh://git@github.com/` 远程地址会被改写为 HTTPS。
- `gh auth git-credential` 负责处理该 step 的 GitHub 凭据。
- 用户全局和系统级的 git 配置会被忽略，终端凭据提示会被禁用。
- 不会读取或修改 daemon 主机的 git 身份和凭据。

当 step 带有 `github` 块时，`GH_TOKEN` 和 Hub 的 git 配置变量是保留的；workflow 的 `env` 不能替换它们。

## 把权限留给执行者 {#keep-authority-on-the-worker}

分类器可以在没有 GitHub 权限的情况下读取不受信任的请求文本。只在之后真正做出改动的分支上添加 `github` 块。[Workflow 路由](/docs/hub/workflows#route-from-a-classifier)展示了按顺序排列的分类器/执行者结构。

其他集成的连接值仍然是显式的 step 环境变量值：

```yaml
env:
  SOME_TOKEN: "${{ paseo.connections.some-connection.token }}"
```

Hub 在准备 Agent 的环境时解析这个值。Provider 和主机的边界见 [Hub 安全](/docs/hub/security)。
