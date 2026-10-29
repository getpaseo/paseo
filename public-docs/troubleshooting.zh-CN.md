---
title: 故障排查
description: 修复 Linux AppImage 启动错误、找不到 Provider 以及环境不一致的问题。
nav: 常见问题
---

# 故障排查 {#troubleshooting}

## Linux 上 AppImage 无法打开 {#appimage-wont-open-on-linux}

让下载的 AppImage 可执行，然后在终端中启动它，查看错误信息：

```bash
chmod +x Paseo-x86_64.AppImage
./Paseo-x86_64.AppImage
```

如果报告 `error loading libfuse.so.2`，请不使用 FUSE 运行：

```bash
./Paseo-x86_64.AppImage --appimage-extract-and-run
```

Paseo 窗口应该会打开。你也可以从[下载页面](https://paseo.sh/download)获取 `.deb`（Debian/Ubuntu）或 `.rpm`（Fedora）进行安装。

## Paseo 找不到我的 Provider {#paseo-cant-find-my-provider}

你已经安装的 Provider 显示为 **未安装**。

Paseo 启动的是你已经安装的 Agent CLI，它并不自带这些 CLI（参见 [Provider](/docs/providers)）。所以它必须在自己的 `PATH` 中找到命令。如果你的 shell 只在特定条件下才把该位置加入 `PATH`，Paseo 就可能找不到它。

### 查看 Paseo 看到的内容 {#see-what-paseo-sees}

打开 **设置 → 你的主机 → Providers**，点击该 Provider，然后点击 **诊断**。重要的几行：

- **Resolved path**：Paseo 找到二进制文件的位置，或 `not found`。
- **Daemon PATH**：Paseo 正在搜索的 `PATH`。把它和新终端中 `echo $PATH` 的结果进行比较。
- **Version**：二进制文件是否真的能运行。

在终端或 Agent 中，可以向受影响的 daemon 请求同样的诊断信息：

```bash
paseo provider diagnostic <provider>
paseo --host <host:port> provider diagnostic <provider> --json
```

当受影响的 daemon 不是 CLI 默认的本地 daemon 时，请使用全局的 `--host` 选项。

最常见的情况是：显示 `not found`，并且 **Daemon PATH** 中缺少你的二进制文件所在的目录。也就是说，这个目录在你终端的 `PATH` 中，却不在 Paseo 的 `PATH` 中。

### 修复 {#fix-it}

持久的修复方法是确保该命令在普通登录 shell 的 `PATH` 中，然后重启 Paseo。为什么要以此为准，请参见 [Paseo 的环境为何可能与终端不同](#why-paseos-environment-can-differ-from-your-terminal)。

如果你更想直接固定路径，请在 `~/.paseo/config.json` 中设置二进制文件路径：

```json
{
  "agents": {
    "providers": {
      "claude": {
        "command": ["/absolute/path/to/claude"]
      }
    }
  }
}
```

`command` 的格式是 `[binary, ...args]`，它会完全替换该 Provider 的默认启动命令。用 `which -a claude` 查找真实路径。`type -a claude` 还能告诉你 `claude` 是否只是一个 shell 别名或函数；这些都不起作用，因为 Paseo 直接运行二进制文件，所以请使用它指向的路径。编辑后重新加载配置（见[下文](#i-changed-configjson-but-nothing-happened)）。

关于替代端点、多个配置、自定义二进制文件和 ACP Agent，请参见[自定义 Provider](/docs/custom-providers)。各 Agent 的安装链接见[支持的 Provider](/docs/supported-providers)。

## Paseo 的环境为何可能与终端不同 {#why-paseos-environment-can-differ-from-your-terminal}

只要 Paseo 运行你的工具、Agent 或终端，就可能出现同样的不一致：你每天都在用的命令被报告为 `command not found`。

当你从 Dock 或 Finder 打开**桌面应用**时，操作系统给它的是一个精简过的环境，而不是你终端里的 `PATH`。为了弥补这一点，Paseo 会在启动时运行一次你的登录 shell（`$SHELL -i -l -c`），捕获它的环境，并把它交给 daemon 及其启动的所有进程。经验法则：**如果一个全新的终端能运行该命令，Paseo 也应该能。** 这也是检验方法：打开一个新终端，在那里试一试。

当你自己在终端中启动 daemon（`paseo`）时，没有登录 shell 这一步，它直接继承该终端的环境。

无论哪种方式，缺少工具的修复都在你的 shell 配置（`.zshrc`、`.zprofile` 等）中，而不在 Paseo 中。通过版本管理器（asdf、mise、nvm 等）安装的工具最常出问题，请确保它们在干净的登录 shell 中也会初始化，而不仅仅是在你已经打开的 shell 中。

这一登录 shell 步骤在 macOS 和 Linux 上运行。在 Windows 上，Paseo 使用它启动时所带的环境。

## 查看日志 {#reading-the-logs}

- **桌面应用**：登录 shell 的解析过程记录在这里。查找 `[login-shell-env]`：`applied` 表示成功（会记录前后的 `PATH`）；`failed; keeping inherited env` 表示它退回到了精简环境，并附带 `reason`（超时、shell 配置以非零状态退出、没有输出等）。最常见的原因是 `.zshrc`/`.zprofile` 运行缓慢或出错。
- **daemon**：`~/.paseo/daemon.log`（如果你设置了自定义 home，则是 `$PASEO_HOME/daemon.log`）。

桌面应用日志位置：

| 平台    | 路径                            |
| ------- | ------------------------------- |
| macOS   | `~/Library/Logs/Paseo/main.log` |
| Linux   | `~/.config/Paseo/logs/main.log` |
| Windows | `%APPDATA%\Paseo\logs\main.log` |

## 我修改了 config.json，但什么都没发生 {#i-changed-configjson-but-nothing-happened}

编辑后重新加载文件：

```bash
paseo reload
```

Paseo 会应用可以在运行时安全生效的设置，并列出需要重启的路径。JSON 无效或 schema 错误时，不会应用任何内容；修复报告的错误后再次运行该命令。如果某个改动的设置由启动时的环境变量或参数决定，reload 会单独报告它。

只有当 reload 要求时才运行 `paseo daemon restart`。在应用中，打开 **设置 → 你的主机 → 概览** 并使用 **重启 Daemon**。正在运行的 Agent 会继续运行，客户端会自动重连。

## 仍然无法解决？ {#still-stuck}

- [自定义 Provider](/docs/custom-providers)：端点、多个配置、二进制文件、ACP Agent。
- [配置](/docs/configuration)：`config.json`、环境变量、日志。
- [Paseo 如何解析你的登录 shell](https://github.com/getpaseo/paseo/blob/main/packages/desktop/src/login-shell-env.ts)：加载你的 shell 环境的具体代码。
- [报告问题](https://github.com/getpaseo/paseo/issues)。
