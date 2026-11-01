---
title: .worktreeinclude
description: 将 Git 忽略的本地文件复制到新的 Paseo worktree。
nav: .worktreeinclude
order: 12
category: Workspaces
---

# .worktreeinclude

在源检出的根目录添加 `.worktreeinclude`，将本地配置复制到新的 [Git worktree](/docs/worktrees)。Paseo 会在 setup、终端和首个 Agent 启动之前复制匹配的 Git 忽略文件。

## 复制本地配置 {#copy-your-local-configuration}

如果项目的 `.gitignore` 包含 `.env` 和 `config/*.local.json`，创建以下 `.worktreeinclude`：

```gitignore
.env
config/*.local.json
```

通过 Paseo 创建 worktree 时，已有的 `.env` 和 `config/dev.local.json` 等匹配文件会被复制到新 worktree 中的相同相对路径。文件内容仍不会纳入 Git。

提交 `.worktreeinclude`，与团队共享这些模式。每位团队成员在用于创建 worktree 的检出中提供自己的忽略文件。

## 模式语法 {#pattern-syntax}

使用 gitignore 语法，每行一个模式。注释以 `#` 开头。模式前加 `!` 可排除匹配项：

```gitignore
# Local environment and configuration
.env
config/*.local.json
!config/production.local.json
```

模式只会选择 Git 已忽略的文件。在此添加路径不会使 Git 忽略该文件，需要时还应配置 `.gitignore`。已跟踪的文件和未被 Git 忽略的未跟踪文件都不会被复制。

## 文件复制时机 {#when-files-are-copied}

内置的 `worktree-include` 插件从用于创建 worktree 的检出读取该文件。源检出也可以是另一个 worktree。保持该插件启用才能执行复制。

- 没有 `.worktreeinclude` 时，插件不会复制任何文件。
- 匹配的文件必须存在于源检出中。
- 目标中已存在的文件会被跳过，保留原有内容。
- 复制发生在创建期间，之后不会在检出之间持续同步。
- 复制错误会中止创建并删除新 worktree。避免包含符号链接目录或嵌套仓库，因为它们无法作为文件复制。

## 在 setup 期间运行命令 {#run-commands-during-setup}

使用 `.worktreeinclude` 复制本地已有文件。使用 [setup 钩子](/docs/worktrees#setup-and-teardown) 安装依赖、生成文件或获取密钥：

```json
{
  "worktree": {
    "setup": "npm ci"
  }
}
```

将此配置放入新 worktree 所用基准分支的 `paseo.json` 中。setup 运行时，复制的文件已可使用。
