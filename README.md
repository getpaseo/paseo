<p align="center">
  <img src="packages/website/public/logo.svg" width="64" height="64" alt="Paseo logo">
</p>

<h1 align="center">Paseo</h1>

<p align="center">
  <a href="https://github.com/getpaseo/paseo/stargazers">
    <img src="https://img.shields.io/github/stars/getpaseo/paseo?style=flat&logo=github" alt="GitHub stars">
  </a>
  <a href="https://github.com/getpaseo/paseo/releases">
    <img src="https://img.shields.io/github/v/release/getpaseo/paseo?style=flat&logo=github" alt="GitHub release">
  </a>
  <a href="https://x.com/moboudra">
    <img src="https://img.shields.io/badge/%40moboudra-555?logo=x" alt="X">
  </a>
  <a href="https://discord.gg/jz8T2uahpH">
    <img src="https://img.shields.io/badge/Discord-555?logo=discord" alt="Discord">
  </a>
</p>

<p align="center">统一管理 Claude Code、Codex 和 OpenCode 代理的单一界面。</p>

<p align="center">
  <img src="https://paseo.sh/hero-mockup.png" alt="Paseo app screenshot" width="100%">
</p>

<p align="center">
  <img src="https://paseo.sh/mobile-mockup.png" alt="Paseo mobile app" width="100%">
</p>

---

让多个代理在你自己的机器上并行运行。无论你在手机前还是电脑前，都能随时推进工作。

- **自托管：** 代理直接运行在你的机器上，使用你现有的开发环境、工具、配置和技能。
- **多 Provider：** 在同一个界面中统一接入 Claude Code、Codex 和 OpenCode，为不同任务选择合适的模型。
- **语音控制：** 可通过语音输入任务或边说边梳理问题，需要时可以解放双手。
- **跨设备：** 支持 iOS、Android、桌面端、Web 和 CLI。你可以在桌面上开始任务，在手机上查看进度，也可以在终端里脚本化操作。
- **隐私优先：** Paseo 不包含遥测、追踪或强制登录。

## 快速开始

Paseo 会运行一个本地服务，称为 `daemon`，专门负责管理你的编码代理。桌面端、移动端、Web 端和 CLI 等客户端都通过它进行连接。

### 前置条件

你至少需要安装并配置好一个代理 CLI，并确保已经完成凭据配置：

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [Codex](https://github.com/openai/codex)
- [OpenCode](https://github.com/anomalyco/opencode)

### 桌面应用（推荐）

可从 [paseo.sh/download](https://paseo.sh/download) 或 [GitHub Releases](https://github.com/getpaseo/paseo/releases) 下载。打开应用后，`daemon` 会自动启动，不需要额外安装其他组件。

如果要从手机连接，只需扫描设置页中展示的二维码。

### CLI / 无头模式

安装 CLI 并启动 Paseo：

```bash
npm install -g @getpaseo/cli
paseo
```

终端中会显示一个二维码，任意客户端都可以通过它连接。这个方式特别适合服务器或远程机器。

完整安装与配置说明见：
- [文档](https://paseo.sh/docs)
- [配置参考](https://paseo.sh/docs/configuration)

## 微信直连（MVP）

当前仓库已经加入一个参考 `Tencent/openclaw-weixin` 思路实现的微信直连 MVP，目标是让 Paseo 自己完成扫码登录、长轮询收消息，并把微信私聊文本路由到 agent，再把 agent 文本回复发回微信。

目前已支持：

- 扫码登录微信账号
- 本地持久化微信账号 token / `get_updates_buf`
- 后台长轮询 `getupdates`
- 按 `账号 + 对端用户` 自动创建独立 agent 会话
- 文本消息进 agent、agent 文本回复回微信

当前限制：

- 只支持私聊文本消息
- 还没有做图片 / 文件 / 语音 / 视频收发
- 还没有做 typing 状态、复杂多账号路由和精细权限策略

要启用它，在 `~/.paseo/config.json` 的 `channels.wechat` 中加入一段配置：

```json
{
  "channels": {
    "wechat": {
      "enabled": true,
      "autoStart": true,
      "provider": "codex",
      "cwd": "/absolute/path/to/your/workspace",
      "modeId": "auto"
    }
  }
}
```

启动 daemon 后，可用以下接口完成首次绑定：

```bash
# 1. 获取二维码
curl -X POST http://127.0.0.1:6767/api/wechat/login/start

# 2. 等待扫码确认
curl -X POST http://127.0.0.1:6767/api/wechat/login/wait \\
  -H 'Content-Type: application/json' \\
  -d '{\"sessionKey\":\"<上一步返回的 sessionKey>\"}'

# 3. 查看已登录账号
curl http://127.0.0.1:6767/api/wechat/accounts
```

如果你已经装好了 CLI，也可以直接在终端里扫码登录：

```bash
# 子命令形式
paseo wechat login

# 顶层快捷命令
paseo wechat-login
```

如果 daemon 不在默认地址：

```bash
paseo wechat-login --host 127.0.0.1:6767
```

登录完成后，可以继续用下面两条命令查看状态：

```bash
# 查看已登录微信账号和在线状态
paseo wechat status

# 查看“微信用户 -> agent 会话”的映射关系
paseo wechat sessions
```

## 命令行（CLI）

应用里能做的事情，基本都可以在终端里完成。

```bash
paseo run --provider claude/opus-4.6 "implement user authentication"
paseo run --provider codex/gpt-5.4 --worktree feature-x "implement feature X"

paseo ls                           # 列出正在运行的代理
paseo attach abc123                # 实时查看输出流
paseo send abc123 "also add tests" # 继续补充后续任务

# 在远程 daemon 上运行
paseo --host workstation.local:6767 run "run the full test suite"
```

更多内容请参考 [完整 CLI 文档](https://paseo.sh/docs/cli)。

## 编排技能（不稳定）

这里提供了一些实验性技能，教代理如何使用 Paseo CLI 去编排其他代理。我还在持续快速迭代这些技能，接口和行为可能随时变化，也可能和我自己的使用环境耦合，请自行评估风险。

```bash
npx skills add getpaseo/paseo
```

然后你就可以在任意代理对话中这样使用：

```bash
# handoff 适合你先和一个代理讨论，再把实现工作交给另一个代理。
# 例如先用 Claude 做规划，再交给 Codex 实现。
/paseo-handoff hand off the authentication fix to codex 5.4 in a worktree

# loop 适合有明确验收标准的循环任务（也就是 Ralph loops）。
/paseo-loop loop a codex agent to fix the backend tests, use sonnet to verify, max 10 iterations

# orchestrator 用于拉起一个团队，并通过聊天室协调多个代理协作。
# 这个模式偏强约束，默认假设 Claude 和 Codex 都可用。
/paseo-orchestrator spin up a team to implement the database refactor, use chat to coordinate. use claude to plan and codex to implement and review
```

## 开发

Monorepo 中各主要包的职责如下：
- `packages/server`: Paseo daemon，负责代理进程编排、WebSocket API 和 MCP 服务
- `packages/app`: Expo 客户端（iOS、Android、Web）
- `packages/cli`: `paseo` CLI，用于 daemon 和代理工作流操作
- `packages/desktop`: Electron 桌面应用
- `packages/relay`: 用于远程连接的 Relay 包
- `packages/website`: 官网与文档站点（`paseo.sh`）

常用命令：

```bash
# 启动所有本地开发服务
npm run dev

# 分别启动单个端
npm run dev:server
npm run dev:app
npm run dev:desktop
npm run dev:website

# 构建 daemon
npm run build:daemon

# 仓库级类型检查
npm run typecheck
```

如果你要在 macOS 上本地构建桌面安装包，可以使用：

```bash
# 先构建 Web 资源
npm run build:web --workspace=@getpaseo/app

# 再构建桌面安装包（Apple Silicon 示例）
npm run build --workspace=@getpaseo/desktop -- --publish never --mac --arm64 -c.mac.notarize=false -c.mac.identity=null
```

## 许可证

AGPL-3.0
