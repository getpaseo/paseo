---
title: 为 Hub 配置 GitHub
description: 创建自托管 Hub 用于仓库访问和事件触发器的 GitHub App。
nav: GitHub App
---

# 为 Hub 配置 GitHub {#github-for-hub}

自托管 Hub 通过你自己创建并拥有的 GitHub App 与 GitHub 通信。一个 App 服务于整个 Hub 实例，安装该 App 的每个账号或组织都会在 **Integrations** 下成为一个连接。

打开 **Apps → GitHub**。Hub 会给出准确的回调 URL、所需仓库权限、订阅事件，以及需要从 GitHub 复制回来的字段。Hub 会先校验该 App 再保存。

## 公开 URL 要求 {#public-url-requirements}

仓库访问和 App 安装不需要 webhook。GitHub 事件触发器需要[公开 HTTPS 地址](/docs/hub/self-hosting#public-addresses)，以便 GitHub 投递 webhook。

在本地 HTTP Hub 上，**Apps → GitHub** 允许你配置仓库访问，并将事件 webhook 标记为不可用。设置 `PASEO_HUB_APP_URL` 后，通过公开 HTTPS 地址重新打开 Hub 即可添加 webhook 密钥和事件。

GitHub 会调用这些 Hub URL：

| 设置         | Hub URL                                                |
| ------------ | ------------------------------------------------------ |
| Homepage URL | `<PASEO_HUB_APP_URL>`                                  |
| Callback URL | `<PASEO_HUB_APP_URL>/api/integrations/github/callback` |
| Setup URL    | `<PASEO_HUB_APP_URL>/api/integrations/github/setup`    |
| Webhook URL  | `<PASEO_HUB_APP_URL>/webhook`                          |

保持 GitHub SSL 验证开启。

## 订阅 GitHub 事件 {#subscribe-to-github-events}

在 **Subscribe to events** 下，勾选 **Issue comment**、**Issues**、**Pull requests**、**Pull request review**、**Pull request review comment** 和 **Push**。`github.pull_request_created`、`github.pull_request_ready_for_review`、`github.pull_request_synchronized` 和 `github.pull_request_label_added` 都需要勾选 **Pull requests**。

## 连接仓库 {#connect-repositories}

Hub 校验 App 后，选择 **Connect GitHub** 并挑选 App 可访问的账号或组织及仓库。请从 Hub 而不是 GitHub 侧发起安装，让往返流程把安装绑定到当前 Hub 组织。

连接会以基于账号名生成的 slug（例如 `acme-github`）出现在 **Integrations** 下。一个 Hub 组织可以连接多个 GitHub 安装。

已连接的 GitHub 安装提供两项能力：

- 面向 issue、Pull Request、评论、审查和推送的事件触发器。参见 [GitHub 触发器](/docs/hub/triggers/github)。
- 为声明了 [`run.github` 块](/docs/hub/github)的触发器签发受控安装令牌。

daemon 上已认证的 `gh` CLI 不会配置 Hub 的 GitHub 集成。

## 通过环境变量配置 {#configure-from-environment}

在 Hub 之外管理应用密钥的部署可以设置以下环境变量：

```dotenv
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
GITHUB_APP_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=
```

`GITHUB_APP_PRIVATE_KEY` 填写下载的 PEM 文件内容。如果部署挂载了 PEM 文件，请改用 `GITHUB_APP_PRIVATE_KEY_PATH`。

环境变量配置优先于已保存的 GitHub App，并在 **Apps** 下显示为 **Managed by environment**。由于其中包含 `GITHUB_WEBHOOK_SECRET`，它要求公开的 HTTPS 地址。
