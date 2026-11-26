---
title: 连接
description: 通过 SSH、中继或 Tailscale 把 Paseo 客户端连接到你的 daemon。
nav: 连接
---

# 连接 {#connectivity}

你的 Paseo 应用连接的是运行在你电脑或服务器上的 daemon。Paseo 桌面端和 CLI 可以通过 SSH 隧道连接。移动客户端可以通过 Paseo 中继连接，或者用 Tailscale 直接连接。

这里说的是客户端到 daemon 的传输。如果你要找的是由 GitHub、Slack 和 Discord 事件启动 Agent 的服务，那是 [Hub](/docs/hub)。

- [SSH](#ssh)
- [Paseo 中继](#paseo-relay)
- [Tailscale](#tailscale)

## SSH {#ssh}

SSH 传输通过你本地的 OpenSSH 客户端连接到一个已有的 daemon。它不会在远程主机上安装、启动或配置 Paseo。

连接之前：

1. 在远程主机上启动 Paseo daemon。
2. 确认 `ssh user@host` 可以通过密钥或 SSH agent 登录。Paseo 使用非交互式 SSH，并遵循你的 OpenSSH 配置。

CLI 接受 SSH URI 作为主机：

```bash
paseo --host ssh://user@host ls -a
```

daemon 应位于远程主机的 `127.0.0.1:6767`。SSH URL 中的端口是 SSH 服务器的端口：

```bash
paseo --host ssh://user@host:2222 ls -a
```

用 `daemonPort` 设置不同的远程 daemon 端口：

```bash
paseo --host 'ssh://user@host?daemonPort=7777' ls -a
```

请把 `--host` 放在命令之前。`paseo daemon status` 查看的是默认的本地 home；要查询远程 daemon，请使用 `paseo --host ssh://user@host daemon status`。`paseo --host ssh://user@host run --cwd /path/on/remote ...` 需要一个在远程主机上存在的工作目录。

在 Paseo 桌面端中，打开 **设置 → 添加主机 → 远程 SSH**，输入同样的 `ssh://` 目标地址；如果端口与默认值不同，请带上 `:port` 或 `?daemonPort=`。

如果远程 daemon 设置了密码，请在 **守护进程密码** 中输入；它会随主机一起保存，并在每次连接时发送，与直连的密码一样。SSH 登录本身仍然基于密钥，Paseo 从不提示输入 SSH 密码。

## Paseo 中继 {#paseo-relay}

中继无需 Tailscale、端口转发或网络配置即可工作。流量经过[端到端加密](/docs/security)。

在你启用之前，中继是关闭的。

### 在 Paseo 桌面端启用中继 {#enable-relay-from-paseo-desktop}

1. 打开 **设置 → 你的主机 → 设备 → 中继**。
2. 选择 **启用中继**。
3. 用手机上的 Paseo 扫描二维码，或者复制配对链接并粘贴到手机应用中。

### 在 CLI 中启用中继 {#enable-relay-from-the-cli}

运行：

```bash
paseo daemon pair
```

在提示时确认。Paseo 会打印二维码和配对链接。用手机上的 Paseo 扫描二维码，或在手机应用中选择 **粘贴配对链接**。

## Tailscale {#tailscale}

在 daemon 所在的机器和你的手机上安装 [Tailscale](https://tailscale.com/download)，并在两台设备上登录同一个 tailnet。

1. 在已连接到主机的设备上，打开 **设置 → 你的主机 → 设备**。你也可以在初始设置的手机步骤中操作。
2. 打开 **Tailscale** 并复制地址。
3. 在手机上的 Paseo 中，打开 **设置 → 添加主机 → 直接连接**。
4. 在 **Host** 中输入 IP，在 **端口** 中输入端口号。保持 **使用 SSL** 关闭，然后选择 **连接**。

如果你已通过中继配对此主机，Paseo 会将直连添加到同一主机。

## 故障排查 {#troubleshooting}

- **SSH 认证失败**：在终端中运行 `ssh user@host`，在那里修复密钥、agent、主机密钥或 `~/.ssh/config` 条目。Paseo 不会提示输入 SSH 密码。
- **SSH 能连上但 Paseo 被拒绝**：在远程主机上运行 `paseo daemon status`。SSH 传输不会启动 daemon。
- **SSH 能连上但 Paseo 报告 “Password required”**：远程 daemon 受密码保护。从主机中移除这个 SSH 连接并重新添加，这次在 **守护进程密码** 中输入 daemon 密码。
- **连接超时**：检查两台设备上的 Tailscale 是否都已连接，以及你使用的是否是 daemon 机器的 Tailscale IP。
- **连接被拒绝**：运行 `paseo daemon status`，确认 daemon 正在配置的 IP 和端口上运行。
- **配置修改没有生效**：运行 `paseo reload`。如果命令报告主监听地址发生变化，请重启。
