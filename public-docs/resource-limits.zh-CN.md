---
title: 资源限制
description: 为每个 Agent 单独设置 Linux CPU 优先级、CPU 份额、CPU 上限和内存限制，并在 Agent 运行时修改。
nav: 资源限制
---

# 资源限制 {#resource-limits}

在 Linux 上，每个 Agent 都可以运行在自己的资源策略下：调度优先级、CPU 时间份额、CPU 上限、内存限制和一组 CPU。策略作用于 Agent 的 Provider 进程及其启动的所有进程，例如构建、测试运行器和 MCP 服务器。它不会作用于 Paseo daemon，也不会作用于其他 Agent。

没有策略的 Agent 的运行方式与没有这项功能时完全相同。

限制要么被执行，要么被拒绝。如果策略中有主机或 Agent 的 Provider 无法执行的控制项，Paseo 不会启动该 Agent，也不会保存该策略或定时任务；错误信息会列出每个控制项及原因。

## 控制项 {#controls}

| 控制项     | 参数            | 范围                | 作用                                                                             |
| ---------- | --------------- | ------------------- | -------------------------------------------------------------------------------- |
| Niceness   | `--nice`        | -20 到 19           | Agent 进程的调度优先级。数值越大，优先级越低。                                   |
| CPU 权重   | `--cpu-weight`  | 1 到 10000          | CPU 紧张时 Agent 获得的 CPU 时间份额。其他进程的默认值为 100。                   |
| CPU 配额   | `--cpu-quota`   | 单个 CPU 的百分比   | CPU 时间的硬上限。`100` 是一个完整的 CPU，`250` 是两个半。                       |
| 内存高水位 | `--memory-high` | MiB                 | 限流阈值。超过后内核会减慢 Agent 并回收其内存，不会终止任何进程。                |
| 内存上限   | `--memory-max`  | MiB                 | RAM 的硬限制。超过后内核先把 Agent 换出到 swap，再终止它的一个进程。             |
| CPU        | `--cpus`        | 例如 `0-3,6` 的列表 | Agent 可以运行的逻辑 CPU。主机无法把 Agent 限制在这些 CPU 上时，Agent 不会启动。 |

### Niceness、权重和配额 {#niceness-weight-and-quota}

这三项解决不同的问题：

- **Niceness** 和 **CPU 权重**只在其他进程也需要 CPU 时才起作用。空闲的机器会把 Agent 请求的 CPU 全部给 niceness 为 19 的 Agent。Niceness 是进程级设置，内核在 Agent 自己的组内比较它；CPU 权重在组之间分配时间，因此它才是防止一个 Agent 挤占另一个 Agent 或 daemon 的控制项。
- **CPU 配额**是上限，即使机器空闲也生效。用它防止 Agent 让笔记本发热，或占满共享服务器。

### 内存高水位和内存上限 {#memory-high-and-memory-max}

`--memory-high` 施加的是压力：Agent 接近阈值时会变慢。`--memory-max` 是强制的：Agent 的进程占用的 RAM 不会超过它。在有 swap 的主机上，内核会先把超出的部分换出，所以失控的进程会先变慢，而不是立刻被终止。RAM 和 swap 都用尽后，内核会终止 Agent 中最大的进程。Provider 继续运行，只会看到那一条命令失败，除非最大的进程就是 Provider 自己。在低于 253 的 systemd 上，这次终止会停止整个 Provider。把 `--memory-high` 设得低于 `--memory-max`，就会先限流再终止。

## 要求 {#requirements}

所有控制项都需要 Linux 主机。Niceness 需要 `nice` 命令（coreutils 或 BusyBox）。CPU 权重、CPU 配额、内存和 CPU 集合还需要：

- **systemd 244 或更新版本**，并且有一个 daemon 能访问的正在运行的 manager。以你的用户身份运行的 daemon 使用你的 systemd 用户 manager（`systemctl --user`）。以 root 运行的 daemon 使用系统 manager。
- **cgroup v2** 挂载在 `/sys/fs/cgroup`。这是 Fedora 31+、Ubuntu 21.10+、Debian 11+、Arch 和 RHEL 9 的默认设置。
- 已向该 manager **委派 `cpu`、`memory` 和 `cpuset` 控制器**。在当前的发行版上，用户 manager 默认获得 `cpu`、`memory` 和 `pids`；`cpuset` 通常需要另外添加。

查看你的用户 manager 能控制什么：

```bash
cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers
```

要同时委派 `cpuset`，创建 `/etc/systemd/system/user@.service.d/delegate.conf`：

```ini
[Service]
Delegate=cpu cpuset io memory pids
```

然后运行 `sudo systemctl daemon-reload`，并注销后重新登录。

Paseo 从不请求 root 权限，也从不运行 `sudo`。

### 没有 systemd 或 cgroup v2 时 {#without-systemd-or-cgroup-v2}

- 没有可用 systemd manager 的 Linux（大多数 Docker 容器）只支持 **niceness**。包含其他控制项的策略会被拒绝。
- macOS 和 Windows 不支持任何控制项。所有策略都会被拒绝，CLI 会说明这台主机不支持资源控制。

如果主机已无法执行某个已保存的策略，例如 `PASEO_HOME` 被移到了另一台机器，`paseo agent inspect` 会把它报告为 `unsupported` 并附带原因。在你修改策略之前，该 Agent 不会启动。

### 提高优先级 {#raising-priority}

没有特权的 daemon 可以降低 Agent 的优先级（提高 niceness），但不能把它提高到高于自己的优先级。低于 daemon 的 niceness，例如 `--nice -5`，需要 daemon 的用户拥有 `CAP_SYS_NICE` 或 `RLIMIT_NICE` 额度；没有时，该策略会被拒绝。把运行中的 Agent 改回接近 daemon 的优先级，例如从 `--nice 15` 改为 `--nice 5`，需要同样的权限。没有时，策略会被保存，正在运行的进程保持原有优先级，该控制项报告为 `denied`，直到你重新加载 Agent。

### 共享进程的 Provider {#providers-that-share-a-process}

OpenCode 用一个服务器进程服务多个 Agent，插件 Provider 运行在共享的插件 worker 中。无法对共享进程强制执行单个 Agent 的限制，因此为它们的 Agent 设置的策略会被拒绝。

## 设置策略 {#set-a-policy}

新 Agent：

```bash
paseo run --provider codex --nice 10 --cpu-quota 200 --memory-max 8192 "Run the full test suite and fix failures"
```

定时任务，分别应用于每次运行创建的新 Agent：

```bash
paseo schedule create \
  --name maintenance \
  --every 1h \
  --provider claude \
  --nice 15 \
  --cpu-quota 100 \
  --memory-max 2048 \
  "Update dependencies and open a PR if tests pass"
```

Heartbeat 定时任务唤醒的是已有的 Agent，因此保留该 Agent 的策略。

由 Agent 创建的 Agent，无论在这台主机还是已连接的主机上，都会获得创建者策略的副本。每个副本都是独立的限制，而不是分享创建者的限制。如果子 Agent 的 Provider 无法执行它，创建会被拒绝。Paseo 的 MCP 工具不允许 Agent 设置或修改策略。

策略限制的是 Paseo 为 Agent 启动的进程，它不是沙箱：Agent 以你的用户身份运行，可以在限制之外启动进程，例如自己运行 `systemd-run`，或者通过 Paseo CLI 修改策略。

## 修改运行中的 Agent {#change-a-running-agent}

`paseo agent update` 只修改你传入的控制项。`none` 会移除一项：

```bash
paseo agent update <agent-id> --nice 19 --cpu-quota 50
paseo agent update <agent-id> --memory-high none
```

定时任务使用同样的参数：

```bash
paseo schedule update <schedule-id> --memory-max 4096
```

CPU、内存和 CPU 集合的修改会立即生效，无需重新启动 Agent。Niceness 的修改会应用到 Agent 所有正在运行的线程。

启动时没有策略的 Agent 还没有资源边界，因此新的 CPU 和内存限制会显示为 `pending`，直到下次启动。重新加载 Agent 即可应用。Niceness 在两种情况下都会立即生效。

## 查看 {#inspect}

```bash
paseo agent inspect <agent-id>
```

`Resources` 行显示每个已配置的控制项及其状态：

| 状态          | 含义                                   |
| ------------- | -------------------------------------- |
| `applied`     | 运行中的 Agent 已使用这个值。          |
| `pending`     | 已保存。Agent 的运行时下次启动时生效。 |
| `unsupported` | 这台主机或这个 Provider 已无法执行它。 |
| `denied`      | 主机因权限不足而拒绝。                 |
| `failed`      | 因其他原因应用失败。                   |

`paseo schedule inspect <schedule-id>` 显示定时任务保存的策略。

## 用 Linux 工具验证 {#verify-with-linux-tools}

每个设置了策略的 Agent 都会获得一个名为 `paseo_<hash>-agent_<hash>.slice` 的 systemd slice，它们位于每个 daemon 的一个 slice 之下。列出它们：

```bash
systemctl --user list-units 'paseo_*' --all
systemd-cgls --user-unit 'paseo_*'
```

读取 systemd 设置并由内核执行的限制：

```bash
systemctl --user show <slice> -p CPUWeight,CPUQuotaPerSecUSec,MemoryHigh,MemoryMax,AllowedCPUs
cat /sys/fs/cgroup$(systemctl --user show <slice> -p ControlGroup --value)/cpu.max
cat /sys/fs/cgroup$(systemctl --user show <slice> -p ControlGroup --value)/memory.max
```

查找进程所在的 slice 及其 niceness：

```bash
cat /proc/<pid>/cgroup
ps -o pid,ni,cmd --ppid <pid>
```

用 `systemd-cgtop --user` 实时查看使用量。

## 故障排查 {#troubleshooting}

**所有 cgroup 控制项都被拒绝。** 运行 `systemctl --user status`。如果失败，说明 daemon 没有用户 manager：从登录会话中启动 daemon，或者对开机启动的 daemon 运行 `loginctl enable-linger $USER` 启用 lingering。

**`--cpus` 被拒绝，但其他项正常。** 没有委派 `cpuset` 控制器。参见[要求](#requirements)。

**设置策略后 Agent 无法启动。** 如果主机无法执行 Agent 的策略、systemd 拒绝创建它的资源 slice，或内核无法把它限制在所请求的 CPU 上，Paseo 不会启动该 Agent。错误信息会说明是哪个控制项以及原因。用 `paseo agent update <agent-id> --cpu-quota none ...` 清除策略，或修复主机。

**某条命令或 Provider 在一轮对话中途被终止。** Agent 达到了 `--memory-max`。在 `journalctl --user -u <slice>` 中查看 OOM 事件，然后提高限制，或在它之下添加 `--memory-high`。

**崩溃后留下了 slice。** daemon 下次启动时会移除自己留下的 slice。要手动移除，停止该 daemon 自己的 slice。这会终止该 daemon 的所有 Agent 进程，所以先停止 daemon：

```bash
systemctl --user stop "paseo_$(printf %s ~/.paseo | sha256sum | cut -c1-10).slice"
```

如果 daemon 使用其他 `PASEO_HOME`，把 `~/.paseo` 换成它。机器上的其他 Paseo 主目录有各自的 slice。
