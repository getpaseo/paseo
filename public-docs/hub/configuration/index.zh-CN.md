---
title: Hub 配置
description: 使用 Paseo CLI 从仓库编写、校验和部署自包含触发器。
nav: 配置
---

# Hub 配置 {#hub-configuration}

每个 Hub 触发器都是一个自包含的 YAML 文件。你可以在 Hub 控制台的 **Triggers** 中编辑触发器，也可以将它们保存在仓库中并用 `paseo hub deploy` 部署：

```text
.paseo/
└── triggers/
    └── <trigger>.yml
```

所有支持的字段见[触发器 YAML 参考](/docs/hub/configuration/reference)。

## 生成的入门触发器 {#generated-starter-trigger}

在 Agent 要工作的仓库中运行 `paseo hub init`。设置流程会按需连接 daemon，让你选择就绪的集成和该 daemon 上可用的 Agent 运行时，询问允许触发机器人的用户，校验结果并写入一个入门文件，然后询问是否立即部署。

对于名为 `my-team` 的 Slack 集成，生成的文档如下：

```yaml
# .paseo/triggers/slack-help.yml
name: slack-help
enabled: true
on:
  slack.mention:
    connection: my-team
    filters:
      from_users: [U01234567]
max_runtime: 2h
run:
  target:
    daemon: my-macbook
    cwd: /Users/you/code/your-repo
  agent:
    provider: codex
    model: gpt-5
    mode: full-access
  continuation:
    mode: conversation
  max_runtime: 90m
  idle_timeout: 10m
  prompt: |
    Answer with hub.reply, then complete this request and call hub.finish_execution when done.

    <user-prompt>
    ${{ paseo.prompt }}
    </user-prompt>
  outputs:
    slack.reply:
      max: 1
      required: true
```

`connection` 是你组织中的集成 slug。`target.daemon` 是已连接 daemon 的 slug，`target.cwd` 是仓库的绝对路径。`agent` 记录从该 daemon 选择的 Provider、模型和模式。

`continuation.mode: conversation` 会将同一讨论串中的后续提及保留在同一个 Agent 上。提示词要求 Agent 回复并调用 `finish_execution`，因为仅回复不会结束运行。

Discord 入门触发器使用 `discord.mention`、你的 Discord 用户 ID 和 `discord.reply`。GitHub 入门触发器使用 `github.issue_comment`，将 `repo` 限定为当前 GitHub 远程仓库，并同时要求 `@paseo` 和你的 GitHub 用户名。

如果入门文件已存在，设置流程会在替换前询问，并保留其他触发器文件。扩大 `from_users` 或 Agent 权限前，请先阅读 [Hub 安全](/docs/hub/security)。

## 启动超时 {#startup-timeout}

Hub 默认最多等待 2 分钟供 Agent 启动，包括创建 worktree、启动 Provider 和接受初始提示词。对于较慢的机器或大型仓库，可以设置 `run.startup_timeout`：

```yaml
name: inspect
on:
  manual.run: {}
run:
  target:
    daemon: devbox
    cwd: /workspace/project
  agent:
    provider: codex
    mode: full-access
  startup_timeout: 5m
  prompt: Inspect this repository and summarize its current state. Call finish_execution when done.
```

使用带单位的正时长（`ms`、`s`、`m` 或 `h`），最长 `24h`。`max_runtime` 和 `idle_timeout` 在启动阶段同样生效，可能更早到期。

## 从 CLI 部署 {#deploy-from-the-cli}

在仓库根目录运行：

```sh
paseo hub login https://hub.example.com
paseo hub deploy --dry-run
paseo hub deploy
```

两个命令都会按确定的路径顺序读取直接位于 `.paseo/triggers/*.yml` 下的文件。CLI 会拒绝嵌套目录、`.yaml` 扩展名、符号链接和不可读文件，并且不会向上搜索父目录。

`--dry-run` 会对照 Hub 和已连接的 daemon 校验所有文件，但不写入版本。`paseo hub deploy` 会先校验全部文件，再按 YAML 中的 `name` 逐个安装。

如果后面的触发器安装失败，错误信息会列出已成功安装的文件。重新部署同名的 webhook 触发器会保留它的 webhook URL 和密钥。

地址优先级：

1. 显式命令地址或 `--hub`
2. `PASEO_HUB_URL`
3. 当前已保存的 CLI 登录
4. `https://hub.paseo.sh`

凭据优先级：

1. `--api-key`
2. `PASEO_HUB_API_KEY`
3. 与精确解析地址匹配的已保存 CLI 登录

命令行标志和环境变量传入的 API 密钥永远不会写入磁盘。

下一步：[触发器 YAML 参考](/docs/hub/configuration/reference)。
