---
title: 自托管 Web UI
description: 从你自己的 daemon 提供 Paseo Web 应用，并通过你自己的局域网、VPN、反向代理或隧道访问它。
nav: Web UI
---

# 自托管 Web UI {#self-hosting-the-web-ui}

Paseo 的 daemon 可以自己提供浏览器 Web 应用，地址与它已用于 API 的地址相同。你不需要使用托管在 [app.paseo.sh](https://app.paseo.sh) 的应用：让浏览器指向你自己的 daemon，就能获得完整的 UI，连接到你自己的 Agent，运行在你掌控的基础设施上。

以下情况适合这样做：

- 在你自己的机器或服务器上运行整个 UI。
- 把它放在你自己的反向代理、HTTPS 或隧道之后。
- 让整套设置完全自托管，不依赖托管版 Web 应用。

Web 应用随 daemon 软件包一起发布，因此你提供的 UI 总是与 daemon 版本一致。不需要单独构建并保持同步，也不需要处理 UI 与 daemon 的版本偏差。

## 启用 {#enable-it}

内置的 Web UI 默认关闭。保存设置，然后启动 daemon：

```bash
paseo daemon config set features.webUi.enabled true
paseo daemon start
```

或者用环境变量运行一个前台部署：

```bash
PASEO_WEB_UI_ENABLED=true paseo daemon run
```

或者把它持久化到 `config.json` 中，使其在重启后依然生效：

```json
{
  "features": {
    "webUi": {
      "enabled": true
    }
  }
}
```

然后在浏览器中打开 daemon 的地址：

```
http://localhost:6767/
```

如果你的 daemon 不认识 `--web-ui`，请更新它；这个参数是随内置 Web UI 一起加入的。

## 连接的工作方式 {#how-the-connection-works}

页面与 daemon 的 API 和 WebSocket 来自同一个源。打开页面时，应用会自动连接回同一个源，因此你通常可以完全跳过“添加主机”步骤：打开 `http://localhost:6767/`，就能看到你的 Agent。

同一个 HTTP 服务器继续提供 API（`/api/*`）、MCP（`/mcp/*`）、服务代理路由和 WebSocket 升级。新增的只有静态文件。要让提供的 UI 指向*另一个* daemon，请照常在 UI 中把那个 daemon 添加为主机。

## 部署拓扑 {#topologies}

三种常见的运行方式，按暴露程度从低到高排列：

- **同一台机器。** daemon 和浏览器在同一台机器上。打开 `http://localhost:6767/`，无需其他配置。
- **私有网络（局域网或 VPN）。** 从你信任的网络中的其他设备访问 daemon，例如家庭局域网或 [Tailscale](https://tailscale.com) tailnet。完整的直接连接设置见[连接方式指南](/docs/connectivity#tailscale)。
- **公开的反向代理或隧道。** 通过 HTTPS 在一个域名上暴露 UI，在反向代理或隧道处终止 TLS。这是完整的自托管设置。

本页其余部分从本地逐步构建到公开访问。**在前面加代理之前，先确认直接连接可以正常工作**，这样可以把 daemon 的问题和代理的问题区分开。

## 在 localhost 之外暴露 {#exposing-beyond-localhost}

daemon 默认监听 `127.0.0.1:6767`，只能从同一台机器访问。要从其他设备访问，请把它绑定到某个网络接口：

```bash
paseo daemon config set daemon.listen 0.0.0.0:6767
paseo daemon start
```

> **任何能访问该监听地址的人都可以使用你的 Agent**。在绑定到 localhost 之外之前，请设置密码并检查你的主机白名单。中继配对方式让 daemon 保持绑定在 localhost 上，从而完全避免这个问题，见[安全](/docs/security)。

直接暴露 daemon 时需要配置两件事：

1. **设置密码**，只让获得授权的客户端连接：

   ```bash
   paseo daemon set-password
   ```

   持久化设置见[密码验证](/docs/configuration#password-authentication)。密码验证控制访问，但不加密流量；在任何不受信任的网络上，请在它前面加上 TLS（见下文）。

2. **允许你的主机名**，让 daemon 的 DNS 重绑定防护接受发往你的域名的请求：

   ```bash
   paseo daemon config set daemon.hostnames '[".example.com"]'
   ```

   主机白名单的工作方式见 [DNS 重绑定防护](/docs/security#dns-rebinding-protection)。

> **Web 应用在身份验证之前加载，这是有意设计的**。静态 UI 文件无需 daemon 密码即可提供，以便显示登录界面；API 和 WebSocket 在返回任何 Agent 数据或执行任何命令之前仍然需要密码。不要把“页面加载了”当成“daemon 是开放的”，但在绑定到网络之前一定要设置密码，让页面背后的数据受到保护。

## 反向代理 {#reverse-proxy}

要在一个域名上通过 HTTPS 提供 UI，请在反向代理处终止 TLS，并把所有请求转发给 daemon。让 daemon 保持在 localhost 上，只让代理对外暴露。

可用的代理必须：

- **转发 WebSocket 升级。** 应用通过 `/ws` 上的 WebSocket 流式传输 Agent 输出；不支持升级时，UI 能加载但永远连不上。
- **不缓冲响应。** 终端输出和其他实时流是长连接；缓冲会让 UI 看起来像卡住了。
- **使用较长的读取超时。** 这些流在整个会话期间保持打开。
- **允许较大的请求体。** 提示词和文件上传可能很大。
- **保留 `Host` 请求头并传递 `X-Forwarded-Proto`。** daemon 用它们告诉应用应连接回哪个源以及使用哪种协议（`wss://` 还是 `ws://`）。丢掉它们，自动连接就会指向错误的地方。

### Nginx {#nginx}

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 443 ssl;
  server_name paseo.example.com;

  ssl_certificate     /etc/letsencrypt/live/paseo.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/paseo.example.com/privkey.pem;

  client_max_body_size 100m;

  location / {
    proxy_pass http://127.0.0.1:6767;
    proxy_http_version 1.1;

    # WebSocket upgrade
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;

    # Preserve origin + scheme so the UI connects back over wss://
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    # Long-lived, unbuffered streams
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }
}
```

### Caddy {#caddy}

Caddy 会为你处理 TLS、WebSocket 升级、请求头转发和流式传输：

```caddy
paseo.example.com {
  reverse_proxy 127.0.0.1:6767
}
```

这就是全部配置。Caddy 会自动申请证书，并默认保留 `Host` 和 `X-Forwarded-Proto`。

## HTTPS 与 TLS {#https-and-tls}

在代理（或隧道）处终止 TLS，并通过 localhost 上的普通 HTTP 转发给 daemon，上面的配置就是这样做的。当页面通过 HTTPS 提供且代理传递 `X-Forwarded-Proto: https` 时，应用会自动通过 `wss://` 连接回来。你不需要在任何地方配置协议；它跟随边缘节点。

daemon 默认信任来自回环地址代理的转发请求头，上面所有的设置都是如此：代理或隧道转发到 `127.0.0.1:6767`。

如果你的代理从其他地址访问 daemon，例如在某些 Docker、局域网或负载均衡器设置中，请配置受信任的代理范围：

```json
{
  "daemon": {
    "trustedProxies": ["loopback", "172.16.0.0/12"]
  }
}
```

`PASEO_TRUSTED_PROXIES` 接受相同的逗号分隔值：

```bash
PASEO_TRUSTED_PROXIES=loopback,172.16.0.0/12 PASEO_WEB_UI_ENABLED=true paseo daemon run
```

只有当你最后一层受信任的代理会覆盖客户端提供的 `X-Forwarded-*` 请求头时，才使用 `trustedProxies: true`。否则客户端可以伪造转发请求头的值。

如果你通过 HTTPS 提供 UI，但应用尝试通过 `ws://` 连接（浏览器会把它当作混合内容拦截），说明你的代理没有转发 `X-Forwarded-Proto`，或者 daemon 不信任代理的地址。修复相应的那一项。

对于远程或中继方式（通过 Paseo 中继而不是反向代理驱动 daemon），中继有它自己的公开与内部 TLS 设置，见[安全](/docs/security)。

## 隧道 {#tunnels}

如果你不想管理反向代理或开放端口，隧道可以提供一个转发到本地 daemon 的 HTTPS URL。

- **Tailscale Serve** 把它保留在你的 tailnet 内，不公开暴露，并为你处理 TLS：

  ```bash
  tailscale serve --bg http://127.0.0.1:6767
  ```

  通过 `https://<your-machine>.<tailnet>.ts.net/` 访问。只有你的 tailnet 中的设备可以连接。

- **Cloudflare Tunnel** 通过一个支持 TLS 和 WebSocket 的公开主机名暴露它：

  ```bash
  cloudflared tunnel --url http://localhost:6767
  ```

  Cloudflare 会终止 TLS 并设置 `X-Forwarded-Proto: https`，因此自动连接可以正常工作。由于 URL 是公开的，**请设置 daemon 密码**。

## 安全 {#security}

自托管 Web UI 意味着由你决定谁能访问 daemon。要点如下：

- **在绑定到 localhost 之外之前设置密码。** 静态页面无需密码即可加载，但 Agent 数据和命令都在密码之后。见[安全](/docs/security#password-authentication)。
- **在任何不受信任的网络前加上 TLS。** 密码验证保护的是访问，而不是机密性。
- **尽可能让 daemon 保持在 localhost 上**，只让反向代理或隧道对外暴露。
- **在自定义域名上提供服务时，检查你的主机白名单。**

完整的威胁模型、中继加密和 DNS 重绑定细节，见[安全](/docs/security)和 [SECURITY.md](https://github.com/getpaseo/paseo/blob/main/SECURITY.md)。

## 故障排查 {#troubleshooting}

- **`/` 显示空白页或 404。** Web UI 没有启用。用 `--web-ui` 启动 daemon，并用 `paseo daemon status` 确认你访问的就是这个 daemon。
- **页面加载了但一直连不上。** 代理没有转发 WebSocket 升级，或者剥离了 `Host` 请求头。检查代理配置中的升级请求头。
- **连上之后输出卡住。** 开启了响应缓冲，或者读取超时太短。关闭缓冲并提高超时时间。
- **HTTPS 下出现“Mixed content”或连接被拦截。** 应用退回到了 `ws://`。要么代理没有发送 `X-Forwarded-Proto: https`，要么 daemon 不信任代理的地址。转发该请求头；如果代理不在回环地址上，再配置 `daemon.trustedProxies`。
- **`403 Invalid Host header`。** 你的域名不在白名单中。用 `--hostnames` 或 `daemon.hostnames` 添加它，见 [DNS 重绑定防护](/docs/security#dns-rebinding-protection)。
- **较大的提示词或上传失败。** 调高代理的最大请求体大小（Nginx 中的 `client_max_body_size`）。

## 另请参阅 {#see-also}

- [安全](/docs/security)：连接方式、中继加密、密码验证、主机白名单。
- [配置](/docs/configuration)：`config.json`、环境变量和 CLI 覆盖项。
- [CLI](/docs/cli)：`paseo daemon` 命令。
- [社区项目](/docs/community)：社区构建的自托管工具。
