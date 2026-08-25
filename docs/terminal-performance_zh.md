# 终端性能

终端输出如何保持低延迟，不变量是什么，以及如何在对流水线做任何改动前后进行测量。在触碰 `packages/server/src/terminal/` 或 `packages/app/src/terminal/runtime/` 下的任何内容之前阅读本文。

## 流水线

```
pty（node-pty，fork 的 worker 进程）
  → 无头 xterm 解析（worker，快照保真度）
  → TerminalOutputCoalescer（worker，每个终端每 5ms ≤1 条 IPC 消息）
  → process.send IPC → 守护进程主进程
  → TerminalOutputCoalescer（每个客户端流，terminal-session-controller.ts）
  → 二进制 ws 帧（2 字节头 + 原始字节）
  → 客户端解码（daemon-client.ts）→ 流路由器 → 模拟器运行时
  → xterm.write（连续写入；xterm 内部批处理）
```

终端帧与所有代理流量共享守护进程主事件循环。`daemon.log` 中 `ws_runtime_metrics` 日志行（每 30 秒）中的 `eventLoopDelay` 块是"守护进程繁忙"的真实依据——此处的 p99/最大值直接决定了最坏情况下的终端帧延迟。

## 不变量（容易破坏的那些）

- **合并器是前导+尾随节流。** 空闲窗口后的第一个块立即刷新（同步）；只有持续突发才等待尾随定时器。回退为仅尾随会为每次按键回显增加一个完整窗口（~5ms）的延迟。
- **输出合并在 worker 中、在 IPC 之前发生。** 每个 pty 块一次 `process.send` 在构建输出下是主循环洪水。非输出消息（snapshot/snapshotReady/titleChange/exit）必须先刷新合并器，以保持顺序。
- **合并的输出携带最后一个块的 revision。** 快照重放去重（`replayTerminalOutputAfterSnapshot`）跳过 `revision <= replayRevision` 的缓冲输出；一个 revision 较低的合并批次会被错误跳过（丢失输出）。
- **输入模式追踪器在每个进程边界运行一次，而非每跳一次。** Worker 拥有权威追踪器；守护进程从 `getTerminalState` 响应和 `snapshotReady` 消息缓存重放前导。不要重新引入守护进程主循环上的每块 `feed()`。
- **快照追赶是背压门控的。** 流仅在 `outputBytesSinceSnapshot > MAX_TERMINAL_OUTPUT_FRAME_BYTES`（256KB）**且**客户端传输报告 `bufferedAmount > MAX_CLIENT_BUFFERED_BYTES`（4MB）时退回到完整快照。一个持续排空流的客户端，无论产生多少输出，都能连续流式传输。在此门控存在之前，每 256KB 的构建输出就会丢弃一帧并强制进行完整的 JSON 单元格网格快照（跨 IPC 约 20 万个对象）——这是历史上海量延迟和 GC 卡顿的来源。
- **客户端输出写入不按帧序列化。** 模拟器运行时将连续的纯文本写入直接排入 xterm（其内部缓冲）。只有屏障操作（`clear`、`snapshot`、`suppressInput` 写入）等待——在一个零长度哨兵写入之后——这样重置就不会与正在传输的输出交错。

## 测量

- **仅 Node 基准测试（快速迭代，服务器流水线）：** `npx tsx scripts/benchmark-terminal-latency.ts`。启动隔离的守护进程（全新 `PASEO_HOME`、随机端口——绝不是 6767），测量回显延迟百分位数、突发抖动和增量模拟代理负载下的快照计数。将 JSON 写入 `/tmp/paseo-terminal-bench/`。健康数值（2026-06）：回显 p50 ~2.3ms、p95 ~3.3ms、2MB 突发完全流式传输且 `snap=0`。
- **浏览器性能规格（用户感知路径）：** 由 `PASEO_TERMINAL_PERF_E2E=1` 门控 —— `packages/app/e2e/terminal-performance.spec.ts` 和 `packages/app/e2e/terminal-keystroke-stress.spec.ts`（模拟代理负载下每阶段 keydown→xterm-commit 分解）。健康值：600 键突发下 keydown→commit p50 ~18ms。
- **生产环境：** grep `daemon.log` 中的 `ws_runtime_metrics`，读取 `eventLoopDelay` + `bufferedAmount`。

## 已知的剩余争用（后续优化候选）

- 单条大型 `agent_stream` 消息（例如 250KB diff 载荷）可测量地延迟终端回显（~100ms 级别的下降）——成本分为守护进程序列化和应用端在共享浏览器主线程上的解析/渲染。
- 中继连接的客户端在守护进程主循环上每帧付出纯 JS tweetnacl 加密 + base64 的代价（`packages/relay/src/encrypted-channel.ts`）。
- `sendToClient` 为每个套接字重新序列化会话消息；仅对多套接字连接有影响。
