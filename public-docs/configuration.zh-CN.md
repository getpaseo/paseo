---
title: 配置
description: 配置托管实例和前台部署。
nav: 配置
---

# 配置 {#configuration}

托管实例从主目录的 `config.json` 和默认值加载配置。前台部署可以用环境变量覆盖这个文件。

## 配置存放在哪里 {#where-config-lives}

Paseo 默认使用 `~/.paseo` 作为主目录。配置文件是：

```bash
~/.paseo/config.json
```

你可以通过设置 `PASEO_HOME` 或在 CLI 命令上使用 `--home` 来更改主目录。

## 优先级 {#precedence}

托管的 `start` 和桌面应用先使用默认值，再应用 `config.json`。继承来的 daemon 设置环境变量会从它们的启动环境中移除。

前台的 `paseo daemon run`、Docker 和直接由进程管理器启动的方式会在文件之后应用环境变量。已有的旧版进程管理器参数在 worker 重启后保持其优先级。修改部署覆盖项需要停止并重新启动该部署。列表类设置会在各个来源之间追加，包括主机名和 CORS 来源。

## 示例 {#example}

配置监听地址、主机名和 MCP 的最小示例：

```json
{
  "$schema": "https://paseo.sh/schemas/paseo.config.v1.json",
  "version": 1,
  "daemon": {
    "listen": "127.0.0.1:6767",
    "hostnames": ["localhost", ".localhost"],
    "mcp": { "enabled": true }
  }
}
```

`daemon.hostnames` 是主要字段。旧的 `daemon.allowedHosts` 名称作为已弃用的别名仍然可用，以保持向后兼容。

## 应用更改 {#apply-changes}

通过 CLI 编辑所选的文件：

```bash
paseo daemon config get daemon.listen --home ~/paseo-test
paseo daemon config set daemon.listen 127.0.0.1:6800 --home ~/paseo-test
paseo daemon config unset features.webUi.enabled --home ~/paseo-test
```

`get [path]` 报告已配置的值，并把缺失的字段标记为 unset。它不会创建主目录。`set` 会把输入解析为 JSON，否则当作字符串；`--string` 强制作为字面字符串。`--json` 选择输出格式。对于包含点号的动态键，请使用整个对象的 JSON。未知路径、无效值和无效的现有文件都会被拒绝，不会写入。密码使用 `set-password`。

编辑成功后会保存经过校验的文件，然后在实例可达时重新加载一次。输出会区分已应用的更改、需要重启的项和部署覆盖项。已停止、未绑定或不可达的实例会报告 **saved; not applied**。重新加载失败时会报告 **saved; reload failed** 并以非零状态退出；文件仍然保存。编辑从不会隐式重启。

直接编辑 `config.json` 后，重新加载它：

```bash
paseo reload
```

daemon 会在应用任何内容之前校验整个文件。它会应用运行时安全的更改，并列出仍然需要重启的设置。如果它报告了需要重启的路径，请运行：

```bash
paseo daemon restart
```

运行时安全的设置包括：中继启用、MCP 设置、浏览器工具、主机名、CORS 来源、受信任的代理、Git 进程限制、Agent 和终端配置、Provider 定义、元数据生成、应用基础 URL、Provider 目录超时，以及全局插件开关。删除其中某个设置会应用该字段缺省时的行为；删除某个 Provider 会把它从之后的启动中移除。

当你删除 `daemon.relay.enabled` 时，新的主目录会保持中继关闭。如果 daemon 启动时其配置就已经省略了这个字段，它会为了兼容而保持旧版的中继开启行为。编辑较旧的配置时，请显式设置 `daemon.relay.enabled`。

空闲运行时清理、监听地址、身份验证、中继端点和 TLS、worktree 分配、服务代理地址、内置的 Web UI、日志、语音合成与识别、语音、凭据以及本地模型设置都需要重启。重新加载会先应用同一文件中的其他有效编辑，再报告这些路径。

部署环境变量和旧版进程管理器参数仍然具有最终决定权。当某个启动覆盖项阻止了文件中已更改的设置生效时，重新加载会在 `overrideControlledPaths` 下报告它。这包括启动设置，例如监听地址、密码、中继端点和 TLS、服务代理和 Web UI 设置、日志、语音合成与识别以及语音配置。主机名和 CORS 来源等列表设置仍然在各个来源之间追加，因此 `config.json` 中的值继续生效。要让文件中的值具有决定权，请停止该部署并在不带覆盖项的情况下重新启动。

## Agent Provider {#agent-providers}

Agent Provider，包括 Paseo 自带的一等 Provider 和你在 `agents.providers` 下添加的自定义条目，都在单独的页面中介绍。

心智模型见 [Provider](/docs/providers)，Paseo 可以启动的全部 Agent 见[支持的 Provider](/docs/supported-providers)。要让 Claude 指向兼容 Anthropic 的端点（Z.AI、Alibaba/Qwen）、使用多个配置、自定义二进制文件、ACP Agent，以及了解 `additionalModels` 的合并行为，见[自定义 Provider](/docs/custom-providers)。完整的字段参考在 GitHub 上的 [docs/custom-providers.md](https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md)。

## 空闲运行时 {#idle-runtimes}

当 daemon 的基础条件允许清理，且 Provider 已实现的安全检查也允许时，Paseo 会在可恢复的 Agent 空闲一小时后释放其进程。你的下一条提示词会恢复同一个会话。要为整个主机禁用此功能，请在 **设置 → 你的主机 → Agents** 中关闭 **释放空闲 Agent**，或设置：

```json
{ "agents": { "idleRuntimeCleanup": false } }
```

此设置默认为 `true`。在设置中更改后立即生效；配置文件中的更改在重新加载配置后生效。重新启用会保留现有的空闲计时。没有单个 Agent 的设置。不提供运行时安全检查的 Provider 使用相同的 daemon 基础条件和一小时空闲期。活动中的工作、后代 Agent 和待发送的完成通知都会阻止清理。ACP 适配器还会在 ACP 终端仍运行时保留运行时，即使终端没有输出；已退出的终端不会阻止清理。此检查不检查 Provider 内部启动的进程。

## worktree {#worktrees}

新的 worktree 默认创建在 `$PASEO_HOME/worktrees` 下。要把新的 worktree 放到其他位置，请设置 `worktrees.root`：

```json
{
  "worktrees": {
    "root": "/mnt/fast/paseo-worktrees"
  }
}
```

相对路径基于 `PASEO_HOME` 解析。已有的 worktree 保持原位；修改此设置只会改变 Paseo 之后创建和发现由 Paseo 管理的 worktree 的位置。

## 语音 {#voice}

语音通过 `features.dictation` 和 `features.voiceMode` 配置，Provider 凭据放在 `providers` 下。

语音的设计理念、架构以及完整的本地和 OpenAI 设置示例，见[语音文档](/docs/voice)。

## 内置的 Web UI {#bundled-web-ui}

daemon 可以在同一个 HTTP 服务器上提供浏览器 Web 客户端。官方 Docker 镜像中默认启用此功能，普通 CLI 和由桌面应用管理的 daemon 默认关闭。

从 CLI 启用它：

```bash
paseo daemon config set features.webUi.enabled true
paseo daemon start
```

或者设置环境变量：

```bash
PASEO_WEB_UI_ENABLED=true paseo daemon run
```

或者把它持久化到 `config.json` 中：

```json
{
  "features": {
    "webUi": {
      "enabled": true
    }
  }
}
```

启用后，打开 daemon 的 HTTP 地址（例如 `http://localhost:6767/`）即可加载 Web 应用。静态 UI 文件无需 daemon 身份验证即可加载；API 和 WebSocket 请求仍然需要配置的密码。

## 日志 {#logging}

daemon 日志默认使用独立的控制台输出和文件输出：

- 控制台：`info` 及以上
- 文件（`$PASEO_HOME/daemon.log`）：`trace` 及以上
- 文件轮转：单个文件最大 `10m`，除当前文件外保留 `3` 个轮转文件

```json
{
  "log": {
    "console": {
      "level": "info",
      "format": "pretty"
    },
    "file": {
      "level": "trace",
      "path": "daemon.log",
      "rotate": {
        "maxSize": "10m",
        "maxFiles": 3
      }
    }
  }
}
```

旧版字段 `log.level` 和 `log.format` 仍然受支持，并映射到新的输出目标设置。

## 密码验证 {#password-authentication}

你可以要求连接 daemon 时提供密码。设置后，所有 HTTP 和 WebSocket 客户端都必须通过验证。只有 `/api/health` 存活检查端点例外，以便进程管理器和负载均衡器无需凭据即可探测。

设置密码最简单的方式是使用 CLI：

```bash
paseo daemon set-password
```

它会提示你输入密码，把 bcrypt 哈希写入 `config.json`，并提示你重启 daemon。身份验证属于启动设置，因此 `paseo reload` 也会把它报告为需要重启。

或者设置 `PASEO_PASSWORD` 环境变量（明文，启动时自动哈希）：

```bash
PASEO_PASSWORD=my-secret paseo daemon start
```

或者直接把哈希写入 `config.json`：

```json
{
  "daemon": {
    "auth": {
      "password": "$2b$12$..."
    }
  }
}
```

设置密码后，重启 daemon 使更改生效。

### 使用密码连接 {#connecting-with-a-password}

CLI 按以下顺序获取密码：

1. `tcp://` 主机 URI 上的 `password` 查询参数：

   ```bash
   paseo --host "tcp://192.168.1.10:6767?password=my-secret" ls
   ```

2. `PASEO_PASSWORD` 环境变量，在主机未携带内嵌密码时作为后备使用（适用于 `localhost:6767`、裸的 `host:port`，或不带 `password=` 查询参数的 `tcp://` 主机）：

   ```bash
   PASEO_PASSWORD=my-secret paseo ls
   PASEO_PASSWORD=my-secret paseo --host 192.168.1.10:6767 ls
   ```

URI 中的 `password=` 总是优先于环境变量，因此你可以全局设置 `PASEO_PASSWORD`，同时通过在 URI 中写明密码来连接另一个 daemon。

在移动应用中，在直接连接的设置界面输入密码。

## 中继 {#relay}

新的主目录会写入 `daemon.relay.enabled: false`。配对设备时，Paseo 会先询问再启用中继；已有的主目录保留其已保存的值。选择和配置连接方式见[连接方式](/docs/connectivity)，中继的加密模型见[安全](/docs/security)。

在 `config.json` 中设置持久化的值：

```json
{
  "daemon": {
    "relay": {
      "enabled": true
    }
  }
}
```

`PASEO_RELAY_ENABLED=true|false` 会为前台部署覆盖文件中的值。托管的 `start` 使用文件中的值。在通过应用或 `paseo daemon pair --relay` 修改中继之前，请结束并重新启动部署以移除它的覆盖项。

## 常用环境变量 {#common-env-vars}

- `PASEO_HOME`，设置 Paseo 主目录
- `PASEO_HOST`，设置 CLI 命令的 daemon 目标
- `PASEO_PASSWORD`，在 daemon 上表示要求的密码（明文，启动时哈希）；在 CLI 上表示主机 URI 未包含密码时用于连接的密码
- `PASEO_LISTEN`，覆盖 `daemon.listen`
- `PASEO_RELAY_ENABLED`，为本次 daemon 启动启用或关闭出站中继
- `PASEO_HOSTNAMES`，覆盖或扩展 `daemon.hostnames`
- `PASEO_ALLOWED_HOSTS`，`PASEO_HOSTNAMES` 的已弃用别名
- `PASEO_WEB_UI_ENABLED`，启用或关闭由 daemon 提供的 Web UI
- `PASEO_WEB_UI_DIST_DIR`，覆盖 daemon Web UI 的构建目录
- `PASEO_TRUSTED_PROXIES`，为 `X-Forwarded-*` 请求头配置受信任的反向代理范围
- `PASEO_LOG_CONSOLE_LEVEL`，覆盖 `log.console.level`
- `PASEO_LOG_FILE_LEVEL`，覆盖 `log.file.level`
- `PASEO_LOG_FILE_PATH`，覆盖 `log.file.path`
- `PASEO_LOG_FILE_ROTATE_SIZE`，覆盖 `log.file.rotate.maxSize`
- `PASEO_LOG_FILE_ROTATE_COUNT`，覆盖 `log.file.rotate.maxFiles`
- `PASEO_LOG`、`PASEO_LOG_FORMAT`，旧版日志覆盖项（仍受支持）
- `OPENAI_API_KEY`，覆盖 OpenAI Provider 密钥
- `OPENAI_STT_API_KEY`、`OPENAI_STT_BASE_URL`，OpenAI 语音转文字端点（听写和语音模式 STT）
- `OPENAI_TTS_API_KEY`、`OPENAI_TTS_BASE_URL`，OpenAI 文字转语音端点（语音模式 TTS）
- `PASEO_VOICE_LLM_PROVIDER`，覆盖语音 LLM Provider（`claude`、`codex`、`opencode`）
- `PASEO_DICTATION_STT_PROVIDER`、`PASEO_VOICE_STT_PROVIDER`、`PASEO_VOICE_TTS_PROVIDER`，覆盖语音 Provider 的选择（`local` 或 `openai`）
- `PASEO_LOCAL_MODELS_DIR`，控制本地模型目录
- `PASEO_DICTATION_LOCAL_STT_MODEL`，覆盖本地听写 STT 模型
- `PASEO_VOICE_LOCAL_STT_MODEL`、`PASEO_VOICE_LOCAL_TTS_MODEL`，覆盖本地语音 STT/TTS 模型
- `PASEO_DICTATION_LANGUAGE`、`PASEO_VOICE_LANGUAGE`，覆盖听写和语音 STT 的语言
- `PASEO_VOICE_LOCAL_TTS_SPEAKER_ID`、`PASEO_VOICE_LOCAL_TTS_SPEED`，可选的本地语音 TTS 调优

## Schema {#schema}

要在编辑器中获得自动补全和校验，请把 `$schema` 设为：

```
https://paseo.sh/schemas/paseo.config.v1.json
```
