---
title: Hub 中的 daemon
description: 将 Paseo daemon 注册到 Hub，授予执行权限，并在触发器中指定目标 daemon。
nav: Daemon
---

# Hub 中的 daemon {#daemons-in-hub}

daemon 是你运行 Paseo daemon 的一台机器。在你的 Hub 组织中注册一次，授予执行权限，然后在触发器中引用它的 slug。

## 连接 daemon {#connect-a-daemon}

先在该机器上登录：

```sh
paseo hub login https://hub.example.com
```

CLI 会输出一个 URL 和验证码，并打开浏览器。批准后，Paseo 会在 `PASEO_HOME` 下保存组织级 CLI 登录凭据。

在交互式终端中，`login` 会询问是否连接此 daemon，并单独询问是否允许 Hub 自动化运行 Agent。连接默认为是，执行权限默认为否。`--json` 和非 TTY 登录不会交互提示。

如果你在登录时跳过了连接，可以单独注册 daemon：

```sh
paseo hub connect
```

`connect` 使用当前登录凭据申请一个一次性注册令牌。daemon 用该令牌换取自己的关系凭据，因此你的 CLI 登录凭据永远不会作为 daemon 权限保存。

Hub 根据主机名生成 daemon 的初始 slug。如果组织内已有同名 slug，Hub 会附加一个短 daemon ID 后缀。slug 使用连字符连接的小写单词，例如 `Build Studio` 会变成 `build-studio`。之后可以在 Hub 中重命名 slug，不会改变不可变的 daemon ID，但需要更新引用旧 slug 的触发器。

无人值守环境中，可通过环境变量传入组织 API 密钥：

```sh
PASEO_HUB_URL=https://hub.example.com PASEO_HUB_API_KEY=paseo_pk_... paseo hub connect
```

地址优先级为显式 `[origin]` 或 `--hub`、然后是 `PASEO_HUB_URL`、再是当前已保存的登录、最后是 `https://hub.paseo.sh`。显式 `--api-key <secret>` 优先于环境变量和已保存的登录。

查看状态或断开连接：

```sh
paseo hub status
paseo hub disconnect
paseo hub disconnect --force   # 当 Hub 不可达时清除本地凭据
```

一台 daemon 同一时间只能连接一个 Hub 组织。试图连接已绑定其他 Hub 的 daemon 会被拒绝。

`paseo hub logout` 会移除已保存的 CLI 登录。在交互式终端中，它会先询问是否断开连接到同一 Hub 的 daemon。在 `--json` 或非交互模式下，除非传入 `--disconnect-daemon`，否则 `logout` 不会断开 daemon：

```sh
paseo hub logout --disconnect-daemon
paseo hub logout --disconnect-daemon --force
```

## 授予执行权限 {#grant-execution-permission}

注册 daemon 不会自动允许 Hub 在其上启动 Agent。需要从该机器显式授予 `hub.execute` 权限：

```sh
paseo hub permissions list
paseo hub permissions grant hub.execute
paseo hub permissions revoke hub.execute
```

在授予 `hub.execute` 之前，Hub 仅追踪该 daemon 的身份和在线状态。**Daemons** 会显示为 **Connected only**，**Home** 会提示它无法运行 Agent。`hub.execute` 的权限范围见[选择 daemon 权限](/docs/hub/security#choose-daemon-authority)。

## 在触发器中指定目标 daemon {#target-a-daemon-from-a-trigger}

在 `run.target` 下引用 daemon slug 和已存在的工作目录：

```yaml
name: repo-triage
on:
  manual.run: {}
run:
  target:
    daemon: my-macbook
    cwd: /Users/you/code/your-repo
  agent:
    provider: codex
    mode: full-access
  prompt: Inspect the repository status and call hub.finish_execution.
```

保存或部署触发器时，`daemon` 会解析为不可变的 daemon ID。`cwd` 必须是该机器上已存在的绝对路径，Hub 不会替你克隆仓库。

如果要让每次运行在独立分支上工作，避免改动主工作树，可以添加 `worktree` 块：

```yaml
name: isolate-fix
on:
  manual.run: {}
run:
  target:
    daemon: build-server
    cwd: /workspace/project
    worktree:
      mode: branch-off
      newBranch: trigger-${{ paseo.execution.id }}
      base: origin/main
  agent:
    provider: codex
    mode: full-access
  prompt: Run tests and call hub.finish_execution.
```

`${{ paseo.execution.id }}` 会渲染为本次执行的 UUID，为每次运行基于 `origin/main` 创建唯一分支，并在重试和恢复时保持一致。参见[触发器 YAML 参考](/docs/hub/configuration/reference#target-and-worktree)和 [Git worktree](/docs/worktrees)。

## Provider 发现 {#provider-discovery}

在 Hub 触发器编辑器中选择 daemon 和工作目录后，Hub 会向该 daemon 查询已配置的 Provider、模型、执行模式和思考选项。

Hub 支持你在 Paseo daemon 上配置的任意 Provider，包括 Claude Code、Codex、OpenCode、Pi，以及自定义或插件 Provider。保存或部署触发器时，已连接的 daemon 会校验所选的 Provider 设置，确保无效值被立即拒绝。

## 恢复与归属 {#recovery-and-ownership}

对于由 Hub 派发的 Agent，Hub 负责创建、重连恢复、输出追踪和完成状态。你在本地手动启动的 Agent 不会受到影响。

如果 Hub 丢失了创建响应，或者 daemon 在运行中途重启，Hub 会用同一个执行 ID 重新发送相同的创建意图。daemon 会返回已有的 Agent，而不会把提示词再运行一次。如果 Agent 意外关闭或出错，Hub 会将此次运行标记为已中断，不会静默启动第二个 Agent。

## Daemon 状态 {#daemon-status}

| 状态              | 含义                                 |
| ----------------- | ------------------------------------ |
| Approval required | CLI 正在等待你在浏览器中批准验证码。 |
| Connected         | 在线且已连接到 Hub。                 |
| Offline           | 已注册，但当前未连接。               |
| Revoked           | 已在 Hub 中撤销访问权限。            |

daemon 离线时，保存新触发器或修改触发器的目标与 Agent 会失败，因为 Hub 必须向该 daemon 校验 Agent 配置。仅编辑已有触发器的提示词、过滤条件或运行限制仍可保存。

在 **Daemons → Revoke daemon** 中撤销连接会从 Hub 侧终止关系，同时保持本地 Agent 继续运行。
