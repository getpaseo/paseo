---
title: 自托管 Hub
description: 使用内嵌数据库在本地运行 Hub，或配合 PostgreSQL、Docker Compose 或 Fly 部署。
nav: 自托管
---

# 自托管 Hub {#self-hosting-hub}

本地运行 Hub 最快只需一条命令：

```sh
npx @getpaseo/hub
```

打开 <http://localhost:3000>。全新的 Hub 会创建内嵌数据库和认证密钥，然后引导你创建管理员账号，并配置所需的 GitHub、Linear、Slack 或 Discord 应用。

按照[快速开始](/docs/hub/quickstart)，通过 Socket Mode 连接 Slack，无需公开服务器即可运行第一个触发器。

## 本地数据 {#local-data}

如果没有设置 `DATABASE_URL`，Hub 会将内嵌的 PGlite 数据库及其生成的认证密钥保存在 `$XDG_DATA_HOME/paseo-hub` 下。如果 `XDG_DATA_HOME` 未设为绝对路径，Hub 会使用 `~/.local/share/paseo-hub`。两者在重启后均会保留。

通过 `PASEO_HUB_DATA_DIR` 指定自定义目录：

```sh
PASEO_HUB_DATA_DIR=/path/to/paseo-hub-data npx @getpaseo/hub
```

内嵌模式每个数据目录只支持一个 Hub 进程，适合个人或单进程 Hub。升级或迁移前，请备份整个数据目录。

## 公开地址 {#public-addresses}

Hub 默认监听 `http://localhost:3000`。对于控制台、daemon、Slack Socket Mode、Discord gateway 和定时任务，这个地址已经足够。

以下功能需要公开 HTTPS 地址：

- GitHub 事件 webhook（没有 webhook 时 GitHub 仓库访问仍可工作）
- Linear OAuth 回调和 webhook
- Slack Webhooks 传输方式（Socket Mode 不需要 HTTPS）
- 入站 webhook 触发器（`/webhooks/wh_...`）
- 附带在对话回复中的 **Open in Paseo** 链接

在启动 Hub 前设置你的公开 HTTPS 地址：

```sh
PASEO_HUB_APP_URL=https://hub.example.com npx @getpaseo/hub
```

之后如果修改了公开地址，请同步更新各 Provider 应用中的回调和 webhook URL。**Apps** 页面会为 Hub 当前使用的地址生成这些 URL。

## PostgreSQL {#postgresql}

设置 `DATABASE_URL` 即可改用 PostgreSQL 代替内嵌数据库：

```sh
DATABASE_URL=postgres://paseo:password@localhost:5432/paseo_hub \
  npx @getpaseo/hub
```

对于持久的服务器部署、多个 Hub 进程或标准数据库备份，请使用 PostgreSQL。数据库迁移会在启动时自动运行，迁移失败时 Hub 不会开始监听。

数据库同时保存 Hub 生成的认证密钥。仅当平台必须从外部密钥存储注入该密钥时，才设置 `PASEO_HUB_AUTH_SECRET`。

设置该覆盖项期间，Hub 会使用它而不替换已存储的密钥。修改生效密钥会让控制台用户退出登录，正在进行的执行会保留原有凭据直到结束。

## 应用配置 {#app-configuration}

实例管理员在 **Apps** 下配置 GitHub、Linear、Slack 和 Discord。Hub 会先校验凭据再保存到数据库，并启动与环境变量配置相同的 Provider 运行时。

在 Hub 之外管理密钥的部署仍可使用环境变量。完整的环境变量配置优先于已保存的应用，并在 **Apps** 下显示为 **Managed by environment**。

```sh
# GitHub
GITHUB_APP_SLUG=
GITHUB_APP_ID=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
GITHUB_APP_PRIVATE_KEY=          # or GITHUB_APP_PRIVATE_KEY_PATH
GITHUB_WEBHOOK_SECRET=

# Linear
LINEAR_CLIENT_ID=
LINEAR_CLIENT_SECRET=
LINEAR_WEBHOOK_SECRET=

# Slack Socket Mode
SLACK_TRANSPORT=socket
SLACK_APP_ID=
SLACK_APP_TOKEN=

# Slack Webhooks instead of Socket Mode
SLACK_TRANSPORT=webhook
SLACK_APP_ID=
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
SLACK_SIGNING_SECRET=

# Discord
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_BOT_TOKEN=
```

各 Provider 的配置指南：

- [GitHub 应用](/docs/hub/self-hosting/github-app)
- [Linear 应用](/docs/hub/self-hosting/linear-app)
- [Slack 应用](/docs/hub/self-hosting/slack-app)
- [Discord 应用](/docs/hub/self-hosting/discord-app)

## 通过环境变量初始化 {#bootstrap-from-environment}

全新数据库默认通过浏览器完成初始化。无人值守部署可以改用环境变量创建第一个管理员：

```dotenv
PASEO_BOOTSTRAP_ORGANIZATION=My organization
PASEO_BOOTSTRAP_OWNER_EMAIL=me@example.com
PASEO_BOOTSTRAP_OWNER_PASSWORD=replace-with-a-temporary-password
```

密码至少需要 12 个字符。登录一次并在控制台中修改密码后，移除 `PASEO_BOOTSTRAP_OWNER_PASSWORD`。Hub 会保留该账号和组织。

## Docker Compose {#docker-compose}

Hub 仓库包含由 Hub 和 PostgreSQL 组成的 Compose 栈：

```sh
git clone https://github.com/getpaseo/hub.git
cd hub
cp .env.example .env
docker compose up -d
```

打开 <http://localhost:3000> 并完成浏览器设置。公开部署请在启动前在 `.env` 中设置 `PASEO_HUB_APP_URL` 及反向代理设置。

该栈在端口 `3000` 上暴露 Hub，并将 PostgreSQL 数据保存在命名卷中。已发布的容器镜像为 `ghcr.io/getpaseo/hub:latest`。

### 使用 Caddy 提供 HTTPS {#https-with-caddy}

Compose 在端口 `3000` 上提供纯 HTTP。在同一主机上运行 Caddy 终止 TLS：

```caddyfile
hub.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

将 `hub.example.com` 指向该主机并开放 80 和 443 端口。Caddy 会[自动申请并续期证书](https://caddyserver.com/docs/automatic-https)。

在 `.env` 中设置以下值：

```dotenv
PASEO_HUB_APP_URL=https://hub.example.com
PASEO_HUB_TRUSTED_CLIENT_IP_HEADER=x-forwarded-for
```

如果不想将端口 `3000` 暴露在公网接口上，将 `compose.yml` 中 `hub` 的端口改为 `"127.0.0.1:3000:3000"`。

## Fly {#fly}

克隆仓库并复制示例配置：

```sh
git clone https://github.com/getpaseo/hub.git
cd hub
cp fly.example.toml fly.toml
```

在 `fly.toml` 中，将 `app` 设为你的 Fly 应用名（例如 `your-hub`），将 `primary_region` 设为你的 Fly 区域，并在 `[env]` 下将 `PASEO_HUB_APP_URL` 设为你的公开 Hub URL（例如 `https://your-hub.fly.dev`）。

使用同一应用名创建应用并挂载 PostgreSQL 数据库：

```sh
fly apps create your-hub
fly postgres create --name your-hub-db
fly postgres attach your-hub-db -a your-hub
```

使用你的 `fly.toml` 部署：

```sh
fly deploy
```

打开 Fly 地址并完成浏览器设置，或在部署前配置[初始化环境变量](#bootstrap-from-environment)。

请保持一台机器持续运行。Hub 维护着 Slack Socket Mode 和 Discord gateway 连接、运行定时任务时钟并向 daemon 派发事件，机器停止期间会错过事件。

## 升级 {#upgrades}

拉取新镜像或源码并部署。数据库迁移仅支持向前升级。升级前请先备份内嵌数据目录或 PostgreSQL 数据库，其中包含账号、应用凭据、触发器、集成和执行历史。
