---
title: Hub 配置
description: 从你的仓库生成、编辑和部署组织触发器。
nav: 配置
---

# Hub 配置 {#hub-configuration}

每个组织触发器都是一个自包含的 YAML 文件。把触发器保存在你的仓库中，并用 `paseo hub deploy` 部署：

```text
.paseo/
└── triggers/
    └── <trigger>.yml
```

## 生成的起步触发器 {#generated-starter-trigger}

在 Agent 要工作的仓库中运行 `paseo hub init`。设置流程会选择一个应用连接和一个可用的 Agent 运行时，询问哪个用户可以触发它，校验结果并写入一个文件，然后询问是否部署。交互式的 `paseo hub login` 会连接 daemon 并提示你运行这条命令；它不会写入触发器文件。

对于名为 `my-team` 的 Slack 连接，生成的文档如下：

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

`connection` 是应用连接在你组织中的 slug。`target.daemon` 是已连接 daemon 的 slug，`target.cwd` 是你运行设置流程时所在的绝对目录。`agent` 包含你从 daemon 中选择的 Provider、模型和执行模式。模式是必填的。

`continuation.mode: conversation` 让后续请求在同一个 Agent 的同一段 Provider 对话中进行。提示词要求 Agent 先回复，再调用 `hub.finish_execution`；只回复并不会结束执行。

Discord 起步配置使用 `discord.mention`、你的 Discord 用户 ID 和 `discord.reply`。GitHub 起步配置使用 `github.issue_comment`，把仓库限制为当前的 GitHub 远程仓库，并同时要求 `@paseo` 和你的 GitHub 用户名。GitHub 起步配置没有显式的回复输出声明。

设置流程在替换所选的触发器文件之前会先询问。它会保留其他触发器以及任何已有的旧配置包。在扩大 `from_users` 或 Agent 的权限之前，请阅读 [Hub 安全](/docs/hub/security)。

## 启动超时 {#startup-timeout}

Hub 最多等待 **两分钟**让 Agent 启动，包括创建 worktree、启动 Provider 以及接受初始提示词。对于较慢的机器，请在触发器 YAML 中设置 `run.startup_timeout`：

```yaml
name: inspect
on:
  manual.run: {}
run:
  target: { daemon: devbox, cwd: /workspace/project }
  agent: { provider: codex, mode: full-access }
  startup_timeout: 5m
  prompt: Inspect this repository and summarize its current state.
```

使用以 `ms`、`s`、`m` 或 `h` 为单位的正数时长，最长 `24h`。省略该字段时使用 `2m`。已有的 `max_runtime` 和 `idle_timeout` 限制在启动期间仍然适用，并且可能更早到期。这个设置改变的是 Hub 的等待预算；Provider 自己的超时设置仍然有效。

## 通过 CLI 部署 {#deploy-from-the-cli}

在仓库根目录运行：

```sh
paseo hub login https://hub.example.com
paseo hub deploy --dry-run
paseo hub deploy
```

两条部署命令都会按确定的路径顺序发现直接位于 `.paseo/triggers/*.yml` 的文件。CLI 会拒绝嵌套的文件、`.yaml` 扩展名、符号链接的触发器路径以及无法读取的文件。它不会搜索上级目录。

dry-run 会让 Hub 校验每个文档，但不保存版本。部署会先校验所有文档，然后通过组织触发器 API 逐个安装。安装会按 YAML 中的 `name` 创建或更新触发器。如果之后的某次安装失败，错误信息会列出已经安装的文件；这些版本仍然生效。错误信息只给出路径，不会打印文件内容或凭据。

地址的优先级：

1. `--hub`
2. `PASEO_HUB_URL`
3. 当前保存的登录
4. `https://hub.paseo.sh`

凭据的优先级：

1. `--api-key`
2. `PASEO_HUB_API_KEY`
3. 与最终解析出的地址完全一致的已保存登录

参数和环境变量中的密钥不会被保存。端点和凭据的行为在 deploy 和 dry-run 之间完全一致。

## 旧版项目配置包 {#legacy-project-bundles}

现有的项目配置包使用 `.paseo/hub.yml`、直接位于 `.paseo/workflows/*.yml` 的文件，以及 `.paseo/workflows/partials/` 下被引用的文件。`hub.yml` 负责命名环境和 Agent；每个 workflow 负责自己的触发器和有序的 step。

显式选择旧版部署方式：

```sh
paseo hub deploy --project my-project --dry-run
paseo hub deploy --project my-project
```

这些命令会通过项目配置 API 发送完整的配置包。dry-run 只做校验，不会记录或激活版本。`paseo hub init` 不会创建或迁移这些配置包。

以下关于来源和版本的行为适用于旧版项目配置包。

## GitHub 同步 {#github-sync}

向配置仓库的默认分支推送会启动一次同步：

1. Hub 在该提交中发现标准的配置包。
2. 它解析每个源文件并解析提示词片段。
3. 它校验命名资源、表达式、连接以及 daemon 的可用性。
4. 成功后，新的不可变版本成为生效版本。

**Sync now** 会按需执行同样的操作。失败信息会保留源路径和编写的字段。同步失败永远不会替换生效版本。

## 版本与来源变更 {#revisions-and-source-changes}

版本会保留查看或重新部署所需的完整原始文件。回滚会激活一个更早的版本。下一次有效的 GitHub 推送会再次激活一个新版本。

基于 GitHub 的配置在控制台中是只读的。切换到手动会保留源文档；它不会把配置包合并成一个生成的文件。

配置仓库可以不同于 `filters.repo` 中指定的仓库。请保护好它，因为修改配置包可以选择连接、daemon、工作目录、Agent 和输出。参见 [Hub 安全](/docs/hub/security)。

下一步：[配置参考](/docs/hub/configuration/hub-yml)和 [workflow 示例](/docs/hub/workflows)。
