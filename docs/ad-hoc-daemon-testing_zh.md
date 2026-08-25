# 临时 Daemon 测试

启动一个隔离的进程内 daemon 测试工具，而不影响端口 6767 上的主 daemon。

这仅用于测试代码。可执行的 daemon 进程必须通过 `scripts/supervisor-entrypoint.ts` 或 `dist/scripts/supervisor-entrypoint.js` 启动；不要将 `createPaseoDaemon` 用作产品启动路径。

## 快速开始

```typescript
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import pino from "pino";
import { createPaseoDaemon } from "./bootstrap.js";
import { DaemonClient } from "./test-utils/daemon-client.js";

const logger = pino({ level: "warn" });
const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-test-"));
const paseoHome = path.join(paseoHomeRoot, ".paseo");
await mkdir(paseoHome, { recursive: true });
const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));

const daemon = await createPaseoDaemon(
  {
    listen: "127.0.0.1:0", // 操作系统选择一个空闲端口
    paseoHome,
    corsAllowedOrigins: [],
    hostnames: true,
    mcpEnabled: false,
    staticDir,
    mcpDebug: false,
    agentClients: {},
    agentStoragePath: path.join(paseoHome, "agents"),
    relayEnabled: false,
    relayEndpoint: "relay.paseo.sh:443",
    appBaseUrl: "https://app.paseo.sh",
    // 在此处添加自定义配置，例如：
    // providerOverrides: { ... },
  },
  logger,
);

await daemon.start();
const target = daemon.getListenTarget();
const port = target!.type === "tcp" ? target!.port : null;

const client = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  appVersion: "0.1.70", // 参见陷阱 #1
});
await client.connect();
await client.fetchAgents({ subscribe: { subscriptionId: "test" } });

// ... 进行你的测试 ...

await client.close();
await daemon.stop();
await rm(paseoHomeRoot, { recursive: true, force: true });
await rm(staticDir, { recursive: true, force: true });
```

使用以下命令运行：

```bash
npx tsx packages/server/src/server/your-script.ts
```

## 使用测试辅助函数

对于更简单的情况，`createTestPaseoDaemon` + `DaemonClient` 处理临时目录和端口选择：

```typescript
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { DaemonClient } from "./test-utils/daemon-client.js";

const daemon = await createTestPaseoDaemon();
const client = new DaemonClient({
  url: `ws://127.0.0.1:${daemon.port}/ws`,
  appVersion: "0.1.70",
});
await client.connect();
await client.fetchAgents({ subscribe: { subscriptionId: "test" } });

// ... 测试 ...

await client.close();
await daemon.close(); // 停止 daemon + 清理临时目录
```

测试辅助函数**不**暴露 `providerOverrides`。在测试工具中，当你需要它时直接使用 `createPaseoDaemon`（参见上面的快速开始）。

## 常用客户端方法

```typescript
// Provider 发现
const snapshot = await client.getProvidersSnapshot({ cwd: "/tmp" });
const models = await client.listProviderModels("claude");
const modes = await client.listProviderModes("claude");

// Agent 生命周期
const agent = await client.createAgent({ provider: "claude", cwd: "/tmp" });
await client.sendMessage(agent.id, "Hello");
const updated = await client.waitForAgentUpsert(agent.id, (s) => s.status === "idle");
```

## 陷阱

### 1. appVersion 控制 provider 可见性

Daemon 会向不发送 `appVersion >= 0.1.45` 的客户端隐藏非旧版 provider（除 claude、codex、opencode 之外的任何 provider）。`DaemonClient` 默认不发送版本，因此基于 ACP 的自定义 provider 在快照响应中将不可见。

始终传递 `appVersion`：

```typescript
const client = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  appVersion: "0.1.70",
});
```

### 2. Provider 快照是异步的

Daemon 启动后，provider 在后台被探测。第一次 `getProvidersSnapshot()` 调用很可能会返回 `status: "loading"` 给大多数 provider。轮询直到你关心的 provider 不再处于加载状态：

```typescript
let snapshot = await client.getProvidersSnapshot({ cwd: "/tmp" });
for (let i = 0; i < 20; i++) {
  const entry = snapshot.entries.find((e) => e.provider === "gemini");
  if (entry && entry.status !== "loading") break;
  await new Promise((r) => setTimeout(r, 2_000));
  snapshot = await client.getProvidersSnapshot({ cwd: "/tmp" });
}
```

### 3. 大多数操作之前必须先调用 fetchAgents

连接后调用 `client.fetchAgents()`。Daemon 会话在处理其他请求之前需要这个握手——没有它，像 `get_providers_snapshot_request` 这样的消息会默默挂起。

### 4. 使用 listen: "127.0.0.1:0" 进行端口分配

始终使用端口 `0`，让操作系统选择一个空闲端口。永远不要硬编码端口——它会与主 daemon 或其他测试运行冲突。

### 5. 脚本必须位于 packages/server 内部

测试工具使用相对导入通过 TypeScript 项目。将你的脚本放在 `packages/server/src/` 下的某个位置，并从那里导入。仓库外部的脚本会因为模块解析错误而失败。

### 6. 失败时清理

用 try/finally 包裹你的测试逻辑，以确保 daemon 停止并且临时目录被清理，即使断言失败：

```typescript
try {
  // ... 测试逻辑 ...
} finally {
  await client.close();
  await daemon.stop().catch(() => undefined);
  await rm(paseoHomeRoot, { recursive: true, force: true });
}
```

### 7. ACP provider 会生成真实的进程

当测试 ACP provider 时（例如，带有 `extends: "acp"` 的 Gemini），daemon 会生成真实的进程来探测模型和模式。二进制文件必须已安装且在 PATH 中。探测可能需要 5-15 秒，具体取决于 provider。
