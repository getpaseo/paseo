# 在 Docker 中运行 Paseo

Paseo 发布了一个容器镜像，用于在服务器、虚拟机、NAS
或家庭实验室机器上运行守护进程。该镜像还提供捆绑的浏览器 web UI，因此一个
容器同时提供守护进程 API 和自托管 UI。

镜像源码位于 [`docker/`](../docker/)。

## 工作原理

官方镜像：

- 从源码构建的工作区 tarball 构建 `@getpaseo/server` 和 `@getpaseo/cli`
- 以非 root 用户 `paseo` 运行守护进程
- 在容器内部监听 `0.0.0.0:6767`
- 通过 `PASEO_WEB_UI_ENABLED=true` 启用捆绑的守护进程 web UI
- 将守护进程状态和 agent 凭证存储在 `/home/paseo` 下
- 不在基础镜像中包含 agent CLI

打开容器的 HTTP 源（例如 `http://localhost:6767`）来加载
web UI。被提供的应用会收到一个同源连接提示，并连接回
该守护进程。静态 UI 文件加载无需守护进程认证；当配置了
`PASEO_PASSWORD` 时，API 和 WebSocket 请求仍然需要密码。

## 快速开始

```bash
docker run -d --name paseo \
  -p 6767:6767 \
  -e PASEO_PASSWORD=change-me \
  -v "$PWD/paseo-home:/home/paseo" \
  -v "$PWD:/workspace" \
  ghcr.io/getpaseo/paseo:latest
```

然后打开：

```text
http://localhost:6767
```

如果你设置了 `PASEO_PASSWORD`，在 web UI 或其他 Paseo 客户端中添加
直连守护进程时输入相同的密码。

## Docker Compose

使用 [`docker/docker-compose.example.yml`](../docker/docker-compose.example.yml)：

```bash
cp docker/docker-compose.example.yml docker-compose.yml
$EDITOR docker-compose.yml
docker compose up -d
```

最简示例：

```yaml
services:
  paseo:
    image: ghcr.io/getpaseo/paseo:latest
    restart: unless-stopped
    ports:
      - "6767:6767"
    environment:
      PASEO_PASSWORD: "change-me"
    volumes:
      - ./paseo-home:/home/paseo
      - ./workspace:/workspace
```

## 安装 Agent

基础镜像不预装 Claude Code、Codex、OpenCode、Copilot、Pi 或
其他 agent CLI。这样可以保持默认镜像较小，并避免将 Paseo
发布与第三方 agent 发布周期耦合。

为你使用的 agent 创建一个子镜像：

```Dockerfile
FROM ghcr.io/getpaseo/paseo:latest

USER root
RUN npm install -g @openai/codex @anthropic-ai/claude-code opencode-ai
```

构建它：

```bash
docker build -f Dockerfile -t paseo-with-agents .
```

然后在 Compose 中使用 `image: paseo-with-agents`。

将子镜像用户保留为 root。基础入口点仅首次运行时以 root 身份
设置目录，然后将守护进程和启动的 agent 降级到非 root 的 `paseo` 用户。

示例子镜像位于
[`docker/Dockerfile.agents.example`](../docker/Dockerfile.agents.example)。

你也可以从宿主机挂载凭证，或在容器内部运行一次 agent 登录：

```bash
docker exec -it --user paseo paseo codex
docker exec -it --user paseo paseo claude
```

Agent 凭证和配置与守护进程状态一起持久化在 `/home/paseo` 中。
Provider 环境变量如 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、
`OPENAI_BASE_URL` 或 `ANTHROPIC_BASE_URL` 可以通过 `docker run -e`
或 `compose.environment` 传入；Paseo 会将它们传递给启动的 agent。

## 卷

| 挂载点         | 用途                                                                 |
| ------------- | -------------------------------------------------------------------- |
| `/home/paseo` | Paseo 状态位于 `.paseo` 下，加上 agent 配置如 `.codex`、`.claude`   |
| `/workspace`  | Paseo 和启动的 agent 可以读写代码                                   |

镜像默认值：

| 变量             | 默认值                |
| ---------------- | --------------------- |
| `HOME`           | `/home/paseo`         |
| `PASEO_HOME`     | `/home/paseo/.paseo`  |
| `PASEO_LISTEN`   | `0.0.0.0:6767`        |

如果你在 Linux 上绑定挂载宿主机目录，请确保容器用户可以
写入它们。内置的 `paseo` 用户的 uid/gid 为 `1000:1000`。对于不同的
宿主机 uid/gid，可以调整挂载目录的所有权，或使用 Docker 的 `--user` /
Compose 的 `user:` 选项运行容器。

## 反向代理

当在反向代理后面提供 Paseo 服务时，将正常的 HTTP 请求和
WebSocket 升级都转发到同一个守护进程端口。

Caddy 示例：

```caddy
paseo.example.com {
  reverse_proxy 127.0.0.1:6767
}
```

Nginx 示例：

```nginx
server {
    listen 443 ssl;
    server_name paseo.example.com;

    location / {
        proxy_pass http://127.0.0.1:6767;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

如果你通过 DNS 名称访问守护进程，请设置 `PASEO_HOSTNAMES` 以便
host-header 验证允许该名称：

```yaml
environment:
  PASEO_HOSTNAMES: "paseo.example.com,.lan"
```

IP 和 `localhost` 默认被允许。

## 安全

- 对任何已发布的端口或网络可达的部署设置 `PASEO_PASSWORD`。
- 对于直接浏览器访问，优先在反向代理处使用 HTTPS。
- 当你不想直接暴露守护进程端口时，对不受信任的网络或移动端访问使用 Paseo 中继。
- 容器是 agent 的隔离边界。Agent 可以读写你挂载到 `/workspace` 中的任何内容以及你放在
  `/home/paseo` 中的任何凭证。
- 捆绑的 web UI 静态文件在守护进程源上是公开的。守护进程
  API 和 WebSocket 在配置了密码时仍受密码认证保护。

守护进程信任模型见 [SECURITY.md](../SECURITY.md)。

## 本地构建

```bash
docker build -f docker/base/Dockerfile -t paseo:local .
```

在构建时指定源码树版本：

```bash
docker build \
  --build-arg PASEO_VERSION=0.1.102 \
  -t paseo:0.1.102 \
  -f docker/base/Dockerfile \
  .
```

Docker 工作流在拉取请求（PR）和 `main` 分支上构建镜像作为
非发布检查。稳定版 `vX.Y.Z` 标签推送会发布
`ghcr.io/getpaseo/paseo:X.Y.Z` 和 `ghcr.io/getpaseo/paseo:latest`。Beta 标签
仅发布精确的预发布标签，例如
`ghcr.io/getpaseo/paseo:0.1.102-beta.1`，不更新 `latest`。

要在不重新构建桌面端、APK 或 EAS
移动端发布产物的情况下原地替换 Docker 镜像，请手动触发 Docker 工作流，而不是
推送 `v*` 发布标签：

```bash
gh workflow run docker.yml \
  --ref main \
  -f paseo_version=0.1.102-beta.1 \
  -f publish=true
```

手动 Docker 发布需要显式的 `paseo_version`。工作流
从检出的源码树构建，对于预发布版本仅发布精确的预发布镜像
标签。

发布的镜像是 `linux/amd64` 和 `linux/arm64` 的多架构镜像。

## 故障排除

- **Web UI 加载但无法连接**：如果设置了 `PASEO_PASSWORD`，添加一个
  使用相同密码的直连。
- **403 Host not allowed**：将 `PASEO_HOSTNAMES` 设置为你使用的 DNS 名称。
- **Provider not available**：在子镜像中安装该 agent CLI，或挂载一个
  运行时并确保二进制文件在 `PATH` 上。
- **`/workspace` 权限错误**：使挂载的目录可由
  uid/gid `1000:1000` 写入，或以宿主机 uid/gid 运行容器。
- **日志**：检查 `docker logs paseo` 或容器内的
  `/home/paseo/.paseo/daemon.log`。
