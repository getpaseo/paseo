---
title: Git worktree
description: 在隔离的 Git worktree 中运行 Agent，并配置 setup 钩子、脚本和长时间运行的服务。
nav: Git worktree
---

# Git worktree {#git-worktrees}

Git worktree 是工作区的一种。

[工作区](/docs/workspaces)是任务发生的地方。当工作区由 Git worktree 支撑时，Paseo 会在单独的分支上创建一个单独的目录，让并行的 Agent 互不干扰。

本页介绍 Git 相关的细节：worktree 存放在哪里、分支如何选择，以及如何通过 `paseo.json` 配置 setup 钩子、脚本、终端和长时间运行的服务。

## 目录结构与工作流程 {#layout-and-workflow}

worktree 默认存放在 `$PASEO_HOME/worktrees/` 下，按源检出路径的哈希分组。你可以用 `config.json` 中的 `worktrees.root` 修改基础目录。每个 worktree 在其工作区创建时获得一个 slug 和一个分支。

```
~/.paseo/worktrees/
└── 1vnnm9k3/               # hash of source checkout path
    ├── tidy-fox/           # worktree slug
    └── bold-owl/
```

使用自定义根目录时，Paseo 会在该目录下保持相同的哈希结构：

```json
{
  "worktrees": {
    "root": "/mnt/fast/paseo-worktrees"
  }
}
```

插件可以通过 [`worktree.create.before`](/docs/plugins/hooks#worktreecreatebefore) 将 worktree 放到磁盘上的自选位置。[worktree-placement 示例](https://github.com/getpaseo/paseo/tree/main/plugin-examples/worktree-placement) 将其放在源检出目录旁边。Paseo 验证路径并拒绝已存在的目标，同时支持在该位置列出、归档和删除 worktree。恢复时使用记录的原路径，不运行创建钩子。

1. 创建一个使用 worktree 隔离的工作区，Paseo 会创建 worktree 并运行你的 setup 钩子
2. 在该工作区中启动一个或多个 Agent
3. 对照基础分支审查 diff
4. 合并或归档该工作区；使用该 worktree 的最后一个工作区被归档后，Paseo 会运行 teardown 并删除 worktree

定时任务的运行默认会在结束时归档其工作区。在定时任务的应用表单中关闭 **Archive on finish**，即可[保留运行工作区](/docs/schedules#keep-run-workspaces)及其 worktree，直到你手动归档。

## 创建由 worktree 支撑的工作区 {#create-a-worktree-backed-workspace}

下面的示例以当前目录作为源检出。传入 `--path ~/dev/my-app` 可以从另一个检出创建工作区。

从基础分支分出新分支：

```bash
paseo workspace create \
  --isolation worktree \
  --mode branch-off \
  --new-branch feature/auth \
  --worktree-slug feature-auth \
  --base origin/main
```

请使用 `origin/main` 而不是 `main`。Paseo 会在后台获取远程引用，因此远程跟踪分支是最新的，而你本地的 `main` 停留在你上次 pull 时的状态。不带前缀的 `main` 会优先解析到这个本地分支，worktree 就会从过时的历史开始。加上远程前缀可以明确指定已获取的引用。

检出一个已有分支：

```bash
paseo workspace create \
  --isolation worktree \
  --mode checkout-branch \
  --branch feature/existing \
  --worktree-slug existing-copy
```

或者在独立的工作区中打开一个 Pull Request：

```bash
paseo workspace create \
  --isolation worktree \
  --mode checkout-pr \
  --pr-number 2186
```

当 Paseo 无法从源检出推断代码托管平台时，添加 `--forge <name>`。

## 使用 .worktreeinclude 复制本地文件 {#copy-local-files-with-worktreeinclude}

在源检出的根目录创建 `.worktreeinclude`，将选定的 Git 忽略文件复制到新的 worktree：

```gitignore
.env
config/*.local.json
```

模式使用 gitignore 语法。只有同时匹配 `.worktreeinclude` 且被 Git 忽略的文件才会复制。已跟踪的文件不会被复制，目标中已存在的文件不会被覆盖。没有 `.worktreeinclude` 时，不会复制任何本地文件。包含路径中的符号链接目录和嵌套仓库会导致复制失败，并中止 worktree 创建。

内置的 `worktree-include` 插件从你创建 worktree 时所选的检出复制文件，即使源检出本身也是 worktree。复制会在 setup、终端和第一个 Agent 运行之前完成。复制失败会中止创建并删除新的 worktree。支持时会在 APFS 和 btrfs 上使用写时复制克隆，否则执行普通复制。

## paseo.json {#paseojson}

在仓库根目录放一个 `paseo.json`。Paseo 从你所选基础分支的已提交版本中读取它，因此其他分支中未提交的改动不会生效。

```json
{
  "worktree": {
    "setup": "npm ci",
    "teardown": "rm -rf .cache"
  },
  "scripts": {
    "test": { "command": "npm test" },
    "web": { "command": "npm run dev", "type": "service", "port": 3000 }
  }
}
```

## Setup 与 teardown {#setup-and-teardown}

插件可以通过 [`worktree.create.after`](/docs/plugins/hooks#worktreecreateafter) 在 setup、终端和第一个 Agent 运行之前写入文件。

`setup` 在 worktree 创建后运行一次。使用 setup 安装依赖并初始化项目。使用 [`.worktreeinclude`](#copy-local-files-with-worktreeinclude) 复制 `.env` 等被忽略的文件。`teardown` 在归档期间、目录被删除之前运行。

```json
{
  "worktree": {
    "setup": "npm ci\nnpm run db:migrate",
    "teardown": "npm run db:drop || true"
  }
}
```

两个字段都接受多行 shell 脚本或命令数组；无论哪种形式，命令都按顺序运行。

命令以 worktree 作为 `cwd` 运行。使用 `$PASEO_SOURCE_CHECKOUT_PATH` 访问原始检出中的文件（未跟踪的配置、本地缓存等）。

## 脚本与服务 {#scripts-and-services}

`scripts` 是可以在 worktree 中按需运行的具名命令。把其中一个标记为 _service_，Paseo 就会把它作为长时间运行的进程进行监管，为它分配端口，并通过 daemon 的反向代理把 HTTP 流量路由给它。

可以在应用中运行它们，也可以在自动化中用 [`paseo script`](/docs/cli#workspace-scripts) 和[工作区脚本 MCP 工具](/docs/mcp#workspace-scripts)管理它们。

### 普通脚本 {#plain-scripts}

```json
{
  "scripts": {
    "test": { "command": "npm test" },
    "lint": { "command": "npm run lint" },
    "generate": { "command": "npm run codegen" }
  }
}
```

### 服务 {#services}

```json
{
  "scripts": {
    "web": {
      "type": "service",
      "command": "npm run dev -- --port $PASEO_PORT",
      "port": 3000
    },
    "api": {
      "type": "service",
      "command": "npm run api -- --port $PASEO_PORT"
    }
  }
}
```

省略 `port` 可以让 Paseo 自动分配端口。让你的进程绑定 `$PASEO_PORT`，而不是写死端口；每个 worktree 获得不同的端口，因此同一服务的多个副本可以共存。

### 动态端口分配 {#dynamic-port-allocation}

默认情况下，Paseo 向操作系统请求一个可用的临时端口。可以在 `~/.paseo/config.json` 中全局配置端口范围，也可以在 `paseo.json` 中按项目配置：

```json
// ~/.paseo/config.json
{
  "worktrees": {
    "servicePorts": { "range": "3000-4000" }
  }
}
```

```json
// paseo.json
{
  "worktree": {
    "servicePorts": { "range": "3000-4000" }
  }
}
```

范围包含两端。项目的 `servicePorts` 块会替换全局块。服务上显式设置的 `port` 总是优先于这两种设置。

如果使用外部分配器，请改为配置 `portScript`：

```json
{
  "worktree": {
    "servicePorts": { "portScript": "/usr/bin/portmake" }
  }
}
```

Paseo 在工作区目录中运行该可执行文件，并传入四个参数：服务名、工作区 ID、分支名和 worktree 路径。由于脚本是直接执行的、不经过 shell，`portScript` 必须指向一个真正的可执行文件（例如编译后的二进制文件，或带有正确 shebang 行如 `#!/bin/bash` 的脚本），而不是内联的 shell 命令或管道。如果需要 shell 求值或管道，请把它们包装在一个小的可执行脚本中。没有分支时会传入空字符串。相同的值也可以通过 `PASEO_SCRIPTNAME`、`PASEO_WORKSPACE_ID`、`PASEO_BRANCH_NAME` 和 `PASEO_WORKTREE_PATH` 获取。它必须向 stdout 输出一个有效的 TCP 端口。同一块中 `portScript` 优先于 `range`。Paseo 信任外部分配器，因此返回的端口可能已经被占用，例如被 Paseo 将要连接的某个服务占用。

### 反向代理 {#reverse-proxy}

每个服务都可以通过 daemon 以一个确定的主机名访问：

```
http://<script>--<branch>--<project>.localhost:<daemon-port>

# on the default branch, the branch label is dropped:
http://<script>--<project>.localhost:<daemon-port>
```

在现代系统上，`*.localhost` 解析为 `127.0.0.1`，因此这些 URL 开箱即用。代理支持 WebSocket 升级。

### 服务之间的访问 {#service-to-service}

从同一工作区启动的服务可以看到彼此的端口和代理 URL。以上面的 `web` 和 `api` 为例，每个进程都会得到：

```
PASEO_PORT=3000                         # this service's port
PASEO_URL=http://web--my-app.localhost:6767  # this service's proxy URL
PASEO_SERVICE_API_PORT=51732
PASEO_SERVICE_API_URL=http://api--my-app.localhost:6767
PASEO_SERVICE_WEB_PORT=3000
PASEO_SERVICE_WEB_URL=http://web--my-app.localhost:6767
```

脚本名会转为大写，非字母数字字符变为 `_`。让你的前端指向 `$PASEO_SERVICE_API_URL`，而不是写死端口。

## 终端 {#terminals}

在 worktree 创建时自动打开终端。适合查看日志，或预先准备好一个 REPL。

```json
{
  "worktree": {
    "terminals": [
      { "name": "logs", "command": "tail -f dev.log" },
      { "name": "shell", "command": "bash" }
    ]
  }
}
```

## 环境变量 {#environment-variables}

Setup、teardown、脚本和服务都能看到：

- `$PASEO_SOURCE_CHECKOUT_PATH`，原始仓库根目录
- `$PASEO_WORKTREE_PATH`，worktree 目录
- `$PASEO_BRANCH_NAME`，worktree 的分支
- `$PASEO_WORKTREE_PORT`，旧版的每个 worktree 一个的端口（在服务中优先使用 `$PASEO_PORT`）

服务还会额外得到：

- `$PASEO_PORT`，该服务分配到的端口
- `$PASEO_URL`，该服务的代理 URL
- `$PASEO_SERVICE_<NAME>_PORT` / `_URL`，其他服务的端口和 URL
- `$HOST`，仅本地访问的 daemon 为 `127.0.0.1`，daemon 绑定所有网络接口时为 `0.0.0.0`

## 管理工作区 {#manage-the-workspace}

```bash
paseo workspace ls
paseo run --workspace <workspace-id> "implement auth"
paseo workspace rename <workspace-id> "Auth rework"
paseo workspace archive <workspace-id>
```

对于常见情况，`paseo run --new-workspace worktree --worktree-mode branch-off --new-branch feature/auth --base origin/main "implement auth"` 会同时创建工作区和它的第一个 Agent。
