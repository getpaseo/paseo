---
title: Hub 中的 daemon
description: 把一台机器注册到 Hub，在配置中引用它，并了解连接后 Hub 负责哪些事情。
nav: Daemon
---

# Hub 中的 daemon {#daemons-in-hub}

daemon 是你的一台运行 Paseo daemon 的机器。把它注册到你的 Hub 组织一次，之后触发器就可以引用它。

## 连接 {#connect}

先在这台机器上登录：

```sh
paseo hub login https://hub.example.com
```

CLI 会打印一个 URL 和一个验证码，并打开你的浏览器。批准后的登录保存在 `PASEO_HOME` 下。

在交互式终端中，登录流程会询问是否连接这个 daemon，并单独询问是否允许 Hub 自动化在其上运行 Agent。连接默认为是；执行权限默认为否。之后它会给出 **Triggers** 的链接，并打印 `paseo hub init`，用于以代码形式创建起步触发器。`--json` 或非 TTY 的登录只会登录。[快速开始](/docs/hub/quickstart)完整地介绍了连接和初始化。

如果你之前拒绝了连接，或者这台机器已经登录过，可以单独注册 daemon：

```sh
paseo hub connect
```

`connect` 使用当前的登录请求一个一次性的注册 token。daemon 用它换取自己的关系凭据；你的 CLI 登录永远不会被保存为 daemon 的权限。

Hub 根据 daemon 的主机名生成它的初始 slug。如果该 slug 在组织中已被使用，Hub 会添加一个简短的 daemon ID 后缀。你之后可以在 Hub 中重命名 daemon。

每个 daemon 有两个标识符：一个不可变的生成 ID 和一个友好的 slug。Hub 会把 slug 规范化为用连字符连接的小写单词，因此 `Build Studio` 会变成 `build-studio`。控制台显示的、配置中引用的都是 slug。

你可以稍后修改 slug，而不改变 daemon ID。如果在某个配置生效后重命名，就需要更新该配置。

对于无人值守的设置，传入组织 API key 而不保存它：

```sh
PASEO_HUB_URL=https://hub.example.com PASEO_HUB_API_KEY=paseo_pk_... paseo hub connect
```

地址的优先级依次为：显式的 `[origin]`、`PASEO_HUB_URL`、当前保存的登录，最后是 `https://hub.paseo.sh`。显式的 `--api-key <secret>` 优先于环境变量和与地址完全一致的已保存登录。

查看与撤销：

```sh
paseo hub status
paseo hub disconnect
paseo hub disconnect --force   # drop local authority when Hub is unreachable
```

一个 daemon 只有一个 Hub 关系。连接一个已有关系的 daemon 会被拒绝。

`paseo hub logout` 会移除当前的 CLI 登录。daemon 的关系是一个独立的身份，会保持连接。

在交互式终端中，退出登录时会询问是否断开注册到同一 Hub 的 daemon。如果接受，会先断开连接再删除登录，因此断开失败时你的凭据会保留。如果拒绝，只移除登录。

非交互式和 `--json` 的退出登录永远不会隐式断开 daemon：

```sh
paseo hub logout --disconnect-daemon           # remove both identities
paseo hub logout --disconnect-daemon --force   # drop local authority when Hub is unreachable
```

## 让 Hub 在其上运行 Agent {#let-hub-run-agents-on-it}

注册 daemon 并不会让 Hub 在其上启动 Agent。这需要单独的 `hub.execute` 权限，登录时会询问，默认为否。你可以随时在这台机器上授予它：

```sh
paseo hub permissions list
paseo hub permissions grant hub.execute
paseo hub permissions revoke hub.execute
```

在授予之前，Hub 只把该 daemon 用于身份和在线状态。Daemons 页面会把它显示为 **Connected only** 并给出授权命令，Home 清单会显示 **Cannot run agents**。授予后该权限允许做什么，见 [Hub 安全](/docs/hub/security#choose-daemon-authority)。

## 在配置中引用它 {#reference-it-from-configuration}

```yaml
environments:
  dev:
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/your-repo
```

`daemon` 是友好的 slug。配置激活时它会解析为不可变的 daemon ID，因此不存在的 daemon 会在激活时失败，而不是等到派发时才失败。

`cwd` 是那台机器上的路径。Hub 不会替你克隆任何东西；该目录必须已经存在。

要让执行不影响你的 worktree，请添加一个 worktree：

```yaml
worktree:
  mode: branch-off
  newBranch: trigger-${{ paseo.execution.id }}
  base: origin/main
```

`${{ paseo.execution.id }}` 会渲染为本次执行的 UUID，因此每次执行都会从 `origin/main` 创建自己的分支。

[环境字段](/docs/hub/configuration/hub-yml#environments)列出了 `newBranch` 接受的值。setup 钩子和脚本见 [Git worktree](/docs/worktrees)。

## Hub 负责什么 {#what-hub-owns}

对于由 Hub 派发的 Agent，Hub 负责创建、重连恢复、输出观察和完成。你自己启动的 Agent 不受影响。

如果 Hub 丢失了创建响应，或者 daemon 在执行过程中重启，Hub 会用相同的执行 id 重新发送同一个创建意图。daemon 会返回已有的 Agent，而不是再次运行提示词。已关闭或出错的 Agent 会被记录为中断；Hub 永远不会悄悄启动第二个。

## 状态 {#status}

| 状态              | 含义                     |
| ----------------- | ------------------------ |
| Approval required | CLI 正在等待你批准验证码 |
| Connected         | 在线并接受派发           |
| Offline           | 已注册但当前未连接       |
| Revoked           | 已从 Hub 移除访问权限    |

daemon 离线期间到达的事件会派发失败，并报告 `daemon_not_connected`。不会排队等待之后处理。事件会出现在项目的 Activity 中，触发器需要再次触发。离线的 daemon 还会阻止保存修改了目标或 Agent 的触发器，因为 Hub 会根据它检查该 Agent；参见[保存时会根据 daemon 检查 Agent](/docs/hub/triggers#saving-checks-the-agent-against-the-daemon)。

从 **Daemons → Revoke daemon** 撤销会从 Hub 一侧结束这段关系。daemon 会继续运行你的本地 Agent。
