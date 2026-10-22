---
title: 为 Hub 配置 GitHub
description: 创建 Hub 用于仓库访问和事件触发器的 GitHub App。
nav: GitHub App
---

# 为 Hub 配置 GitHub {#github-for-hub}

Hub 通过一个由你创建并拥有的 GitHub App 与 GitHub 通信。一个 App 服务于一个 Hub；安装它的每个账号或组织都会成为一个连接。

打开 **Apps → GitHub**。Hub 会给出当前的回调 URL、所需的仓库权限、订阅的事件，以及需要从 GitHub 复制回来的字段。保存之前，Hub 会验证这个 App。

## 公开 URL 要求 {#public-url-requirements}

仓库访问和安装不需要 GitHub webhook。GitHub 事件触发器和配置同步则需要：GitHub 必须能够把事件投递到一个公开的 HTTPS URL。

在本地 HTTP 的 Hub 上，Apps 指南允许你配置仓库访问，并说明事件设置不可用。设置 `PASEO_HUB_APP_URL` 后，在 Hub 的公开地址上重新打开它，即可添加 webhook 密钥和事件。

GitHub 会使用以下 Hub URL：

| 设置项       | Hub URL                                                |
| ------------ | ------------------------------------------------------ |
| Homepage URL | `<PASEO_HUB_APP_URL>`                                  |
| Callback URL | `<PASEO_HUB_APP_URL>/api/integrations/github/callback` |
| Setup URL    | `<PASEO_HUB_APP_URL>/api/integrations/github/setup`    |
| Webhook URL  | `<PASEO_HUB_APP_URL>/webhook`                          |

请保持 GitHub 的 SSL 验证开启。

## 订阅 GitHub 事件 {#subscribe-to-github-events}

在 **Subscribe to events** 下，选择 **Issue comment**、**Issues**、**Pull requests**、**Pull request review**、**Pull request review comment** 和 **Push**。`github.pull_request_created` 和 `github.pull_request_label_added` 需要 **Pull requests**。

## 连接仓库 {#connect-repositories}

Hub 验证 App 之后，选择 **Install on GitHub**。选择 App 可以访问的账号或组织以及仓库。

请从 Hub 发起安装，而不是使用 GitHub 自己的安装按钮。这一来一回会把安装绑定到当前的 Hub 组织。

连接会以一个由账号派生的 slug 出现。例如，安装在 `getpaseo` 上会成为 `getpaseo-github`。Hub 组织需要多少安装就可以连接多少。

## 连接提供什么 {#what-the-connection-provides}

- **事件**：来自该安装可见仓库的 issue、评论、审查和推送。参见 [GitHub 触发器](/docs/hub/triggers/github)。
- **配置同步**：仓库可以保存标准的 `.paseo` 配置包。参见[配置](/docs/hub/configuration)。
- **执行凭据**：对于明确请求 GitHub 权限的 workflow step，Hub 会签发限定范围的 GitHub App token。

daemon 上已认证的 `gh` CLI 不会配置 Hub 的 GitHub 集成。它仍然可以在 Hub 限定的 GitHub 权限之外为 Agent 服务，但受 daemon 和 Provider 自身的环境与权限策略约束。

## 通过环境变量配置 {#configure-from-environment}

把应用密钥保存在 Hub 之外的部署可以设置：

```dotenv
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
GITHUB_APP_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=
```

私钥是从 GitHub 下载的 PEM 文件的内容。如果部署挂载了这个文件，请改用 `GITHUB_APP_PRIVATE_KEY_PATH`。

环境变量配置优先于已保存的 GitHub App，并在 **Apps** 下显示为 **Managed by environment**。完整的环境变量配置包含 webhook 密钥，因此需要一个公开的 webhook 地址。
