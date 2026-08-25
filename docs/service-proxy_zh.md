# 服务代理

Paseo 将 HTTP 流量代理到工作区中运行的服务。本地主机服务 URL 始终启用；可选的公共别名和独立的仅服务监听器可以通过配置叠加上去。

## 工作原理

当 `paseo.json` 中 `"type": "service"` 的脚本启动时，Paseo 为其分配一个本地端口并在服务代理中注册一个路由。`Host` 头部匹配脚本生成的主机名的传入请求被转发到该端口。

生成的主机名由脚本名称、分支和项目构建：

```
<script>--<branch>--<project>.localhost
```

如果分支是 `main` 或 `master`，则省略分支段：

```
<script>--<project>.localhost
```

**示例：** 一个名为 `dev` 的脚本，在 `miniweb` 项目中，位于 `feature/auth` 分支上，可通过以下地址访问：

```
dev--feature-auth--miniweb.localhost
```

本地和公共路由使用一个组合的最左侧标签（`script--branch--project`）。这使主机名与正常的单级通配符 DNS 和 TLS 兼容。如果组合标签超过 DNS 的 63 字符标签限制，Paseo 会使用确定性哈希后缀截断它以避免冲突。

## 配置

在 `~/.paseo/config.json` 的 `daemon` 下添加 `serviceProxy` 块：

```json
{
  "version": 1,
  "daemon": {
    "serviceProxy": {
      "listen": "0.0.0.0:8080",
      "publicBaseUrl": "https://paseoapps.my.domain.com"
    }
  }
}
```

| 字段             | 必需 | 描述                                                                                                     |
| ---------------- | ---- | -------------------------------------------------------------------------------------------------------- |
| `listen`         | 否   | 在此地址启动一个独立的仅服务监听器。如果省略，服务仍然可以通过 localhost 主机在 daemon 监听器上访问。     |
| `publicBaseUrl`  | 否   | 添加公共服务主机别名和公共服务链接。如果省略，链接仅使用 localhost 地址。                                 |

`enabled` 被旧配置接受，但不再启用模式。`enabled: false` 仅抑制可选的 `listen`/`publicBaseUrl` 层；localhost 服务代理始终保持启用。

## DNS 和反向代理设置

要使生成的 URL 可访问，你需要通配符 DNS 指向运行 Paseo daemon 的机器。

**示例：** 在 `https://dev--miniweb.paseoapps.my.domain.com` 暴露服务，其中 daemon 主机是 `10.1.1.1`：

1. 配置通配符 DNS 记录：

   ```
   *.paseoapps.my.domain.com  →  10.1.1.1
   ```

2. 在配置中设置 `publicBaseUrl` 为 `https://paseoapps.my.domain.com`。

3. 如果你在 Paseo 前面放置了反向代理（nginx、Caddy、Traefik 等），将其指向 daemon 监听器或可选的仅服务监听器，并确保它不改变地转发 `Host` 头部。代理使用 `Host` 头部将请求路由到正确的服务——重写它会破坏路由。

公共服务 URL 暴露工作区服务本身。Daemon 密码认证保护 daemon API；它不保护代理的开发服务。

如果同一个反向代理通过 HTTPS 提供 daemon Web UI，它还必须设置 `X-Forwarded-Proto`，以便 Web UI 可以使用 `wss://` 自动连接。Daemon 默认信任来自回环代理的转发头部。如果你的代理从另一个地址访问 daemon，请明确配置代理范围：

```json
{
  "version": 1,
  "daemon": {
    "trustedProxies": ["loopback", "172.16.0.0/12"]
  }
}
```

`PASEO_TRUSTED_PROXIES` 接受相同的逗号分隔值，例如 `loopback,172.16.0.0/12`。仅当最终受信代理覆盖客户端提供的 `X-Forwarded-*` 头部时才使用 `true`。

Nginx 示例：

```nginx
server {
    listen 443 ssl;
    server_name *.paseoapps.my.domain.com;

    location / {
        proxy_pass http://10.1.1.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 环境变量

监听地址和公共基础 URL 也可以通过环境变量设置，它们优先于 `config.json`：

| 变量                                  | 描述                                                 |
| ------------------------------------- | ---------------------------------------------------- |
| `PASEO_SERVICE_PROXY_ENABLED`         | 兼容性 shim；`false` 仅抑制可选的公共/监听层         |
| `PASEO_SERVICE_PROXY_LISTEN`          | 启动可选的仅服务监听器，例如 `0.0.0.0:8080`          |
| `PASEO_SERVICE_PROXY_PUBLIC_BASE_URL` | 添加公共服务别名和链接                               |
