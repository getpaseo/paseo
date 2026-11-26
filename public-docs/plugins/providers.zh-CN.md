---
title: 构建 Provider 插件
description: 直接把编程 Agent 接入 Paseo，或适配一个 ACP Agent。
nav: Provider 插件
---

# 构建 Provider 插件 {#build-a-provider-plugin}

如果你之前没有构建过 Paseo 插件，请从[插件快速上手](/docs/plugins)开始。

Provider 插件把一个编程 Agent 接入 Paseo，而无需把它加入 Paseo 核心。在 npm 或 Git 仓库中[发布插件](/docs/plugins/publishing)，用户就可以用 `paseo plugin install` 安装它。

选择一种实现方式：

| Agent                                              | 方式                                                       |
| -------------------------------------------------- | ---------------------------------------------------------- |
| 已经实现了 ACP                                     | 用 `runAcpProvider()` 注册它，只添加少量针对厂商的转换器。 |
| 提供 TypeScript SDK、JSON-RPC API 或自定义进程协议 | 直接实现 `ProviderRegistration`。                          |

示例有：

- [`provider-direct`](https://github.com/getpaseo/paseo/tree/main/plugin-examples/provider-direct)：会话、选项控件、提示词、持久化、子会话，以及一个由 Provider 拥有的时间线渲染器；
- [`provider-acp-transformer`](https://github.com/getpaseo/paseo/tree/main/plugin-examples/provider-acp-transformer)：一个 ACP 命令模板，带有一个用 Zod 校验的厂商编辑转换器。加载之前，请把 `example-acp --stdio` 替换为一个已安装的 ACP Agent；
- [`inline-thinking`](https://github.com/getpaseo/paseo/tree/main/plugin-examples/inline-thinking)：一个只包含渲染器、不实现 Provider 的插件。

## 注册直接实现的 Provider {#register-a-direct-provider}

添加一个服务端入口：

```ts
// index.server.ts
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createProvider } from "./server/provider";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createProvider());
  return () => {};
}
```

`createProvider()` 返回一个 `ProviderRegistration`：

```ts
import {
  negotiateProviderCapabilities,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";

const supported = ["prompt.message"] as const;

export function createProvider(): ProviderRegistration {
  return {
    id: "my-agent",
    label: "My agent",
    icon: "icon.svg",
    async connect(request) {
      const capabilities = negotiateProviderCapabilities(request.capabilities, supported);
      return createConnection(capabilities);
    },
  };
}
```

连接有三个操作：

- `send(input)` 接收工作后立即返回。结果以事件的形式发布，而不是返回值。
- `onEvent(listener)` 发布会话状态和完整的时间线快照。
- `close()` 停止所有会话，并释放进程、订阅和待处理的工作。

把原生 SDK、进程和流保留在连接的实现内部。在发布之前，把它的输出转换为 `ProviderEvent` 对象。

## 启动 Provider CLI {#launch-the-provider-cli}

对于进程传输和 CLI 探测，请使用 `@getpaseo/plugin/server` 中的 `spawnProcess` 和 `execCommand`。两者都能处理 Windows 的 `.cmd`/`.bat` 启动器，并为 shell 参数加引号。原生的 Node `spawn` 和 `execFile` 在 Windows 上会拒绝这些启动器。

daemon 在 `request.launch` 中提供解析后的命令、参数前缀和完整的环境变量。请显式传入这些环境变量；这些辅助函数不会应用 daemon 的环境策略。把进程生命周期和协议截止时间保留在你的 Provider 内部。正常关闭时结束 stdin；强制停止时使用 `terminateProcess(child)`。它在 Windows 上会结束整个进程树，包括命令脚本启动器背后的 CLI。为最后等待流关闭的过程设定上限。

```ts
import { spawnProcess, execCommand } from "@getpaseo/plugin/server";

const child = spawnProcess(launch.command, [...launch.args, "serve"], {
  env: launch.env,
  cwd,
  stdio: "pipe",
});
const { stdout } = await execCommand(launch.command, [...launch.args, "--version"], {
  env: launch.env,
  timeout: 5000,
});
```

### 在启动包装之后运行会话 {#run-sessions-behind-a-launch-wrap}

来自 `agent.open.before` 的[启动包装](./hooks.zh-CN.md#launch-wraps)会作为 `session.open` 的 `config.wrap` 传给你的 Provider。要支持它：

1. 在注册信息上设置 `launchWrap: true`。Paseo 会在 Provider 快照中发布 `launchWrap: true`，这样插件可以在你的 Provider 连接之前选择它。
2. 把 `session.launch_wrap` 加入连接支持的能力。Paseo 只把 `config.wrap` 发给协商了该能力的连接，在其他连接上带包装的打开会失败。
3. 用 `wrap` 选项启动会话的进程。`spawnProcess` 随后启动 `[...wrap, command, ...args]`，并为包装的可执行文件处理 Windows 启动器：

```ts
const child = spawnProcess(launch.command, [...launch.args, "serve"], {
  wrap: input.config.wrap,
  env: launch.env,
  cwd: input.config.cwd,
  stdio: "pipe",
});
```

在包装之后启动所有为会话工作的进程。如果一个进程服务多个会话，就为带包装的会话单独启动一个。`runAcpProvider({ command })` 会为 ACP Agent 完成以上所有工作。

## 返回模型、模式和思考选项 {#return-models-modes-and-thinking-options}

Paseo 在创建会话之前会请求目录。返回 Agent 表单需要的选项：

```ts
if (input.type === "catalog") {
  emit({
    type: "catalog",
    requestId: input.requestId,
    catalog: {
      models: [
        { id: "agent-large", label: "Agent Large" },
        { id: "agent-small", label: "Agent Small" },
      ],
      modes: [
        { id: "build", label: "Build" },
        { id: "plan", label: "Plan" },
      ],
      thinkingOptions: [
        { id: "standard", label: "Standard" },
        { id: "extended", label: "Extended" },
      ],
      defaultModel: "agent-large",
      defaultMode: "build",
      defaultThinkingOption: "standard",
    },
  });
}
```

对于 Agent 不提供的类别，返回空数组。选中的 `model`、`mode` 和 `thinkingOption` 会出现在会话配置中。

目录描述的是会话存在之前可用的选项。会话专属的控件之后通过 `session.config` 提供。

### 停止 Paseo 取消的请求 {#stop-a-request-paseo-cancels}

Paseo 为每次目录刷新设置期限。Paseo 不再等待某个请求时，会发送带有该请求 `requestId` 的 `request.cancel`。停止这项工作，并释放它启动的资源，例如为读取目录而启动的进程。之后你为该请求发出的事件都会被 Paseo 忽略。同一连接上的会话继续运行。

把 `request.cancel` 加入你支持的能力。Paseo 只向提供该能力的连接发送这个输入：

```ts
const pending = new Map<string, AbortController>();

if (input.type === "catalog") {
  const controller = new AbortController();
  pending.set(input.requestId, controller);
  void readCatalog({ signal: controller.signal })
    .then(
      (catalog) => {
        if (!controller.signal.aborted)
          emit({ type: "catalog", requestId: input.requestId, catalog });
      },
      (error) => {
        if (!controller.signal.aborted)
          emit({
            type: "request.failed",
            requestId: input.requestId,
            error: { message: String(error) },
          });
      },
    )
    .finally(() => pending.delete(input.requestId));
}
if (input.type === "request.cancel") {
  pending.get(input.requestId)?.abort();
}
```

取消可能在请求完成之后才到达。忽略你已不再跟踪的 `requestId`。`runAcpProvider` 提供这项能力，并会停止目录探测进程。

## 打开会话 {#open-a-session}

`session.open` 包含完整的启动配置：工作目录、环境变量、系统提示词、MCP 服务器、工具策略、模型、模式、`providerOptions` 以及持久化偏好。

对于持久化的、作用于主机的插件设置，请使用 `server.registerSettings()` 返回的句柄。在目录和会话回调中读取它；当 Provider 在内存中保留配置时，订阅它。`read()` 和 `subscribe()` 的契约见[设置](./reference.md#persisted-values)。

用选中的目录值创建原生会话，然后发布它实际生效的状态：

```ts
const nativeSession = await sdk.createSession({
  cwd: input.config.cwd,
  model: input.config.model,
  mode: input.config.mode,
  thinking: input.config.thinkingOption,
  systemPrompt: input.config.systemPrompt,
  env: input.config.env,
  mcpServers: input.config.mcpServers,
});

emit({
  type: "session.opened",
  requestId: input.requestId,
  sessionId: input.sessionId,
  capabilities: ["prompt.message"],
  restoration: "core",
  cwd: input.config.cwd,
});
emit({
  type: "session.config",
  sessionId: input.sessionId,
  config: {
    model: nativeSession.model,
    mode: nativeSession.mode,
    thinkingOption: nativeSession.thinking,
    models,
    modes,
    thinkingOptions,
    controls: [],
    providerOptions: {},
  },
});
emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
```

`session.config` 包含已确定的值。请发布原生 Agent 经过规范化后实际选中的值，而不是请求的副本。

## 完成第一段提示词 {#complete-the-first-prompt}

从消息类提示词开始。声明 `prompt.message`，把内容传给原生 Agent，并发布由此产生的生命周期：

```ts
const turnId = crypto.randomUUID();

emit({
  type: "timeline.item",
  sessionId,
  item: {
    type: "user_message",
    id: `user:${turnId}`,
    text,
    clientMessageId: prompt.clientMessageId,
  },
});
emit({
  type: "session.prompt_result",
  sessionId,
  clientMessageId: prompt.clientMessageId,
  result: { type: "turn", turnId },
});
emit({ type: "session.turn", sessionId, turnId, state: "started" });

// Publish complete snapshots as native output changes.
emit({
  type: "timeline.item",
  sessionId,
  item: { type: "assistant_message", id: `assistant:${turnId}`, text: completeText },
});

emit({ type: "session.turn", sessionId, turnId, state: "completed" });
```

对每个 `clientMessageId` 恰好发布一个 `session.prompt_result`。把 `clientMessageId` 复制到用户的时间线条目上，以便 Paseo 替换它乐观显示的消息。每个已开始的轮次都需要一个终止的 `completed`、`failed` 或 `canceled` 事件。

到这一步，Provider 已经可用：用户可以选择模型、打开会话、发送消息并看到回复。

## 为 Provider 选项添加 Composer 控件 {#add-composer-controls-for-provider-options}

`providerOptions` 是 Provider 自己的配置：一个由 JSON 值组成的记录，Paseo 按 Agent 保存它，并在 `session.open` 中交给你。它包含用户在 `config.json` 中为你的 Provider 设置的默认值。请校验你读取的每个键。

只有当用户需要在 Composer 中查看并修改其中一部分选项时，才添加 `controls`。一个控件把 `providerOptions` 的一个顶层键绘制为开关或选择器。控件本身不保存值：Paseo 从 `providerOptions` 读取值。在 `session.config` 中发布控件，以及你正在使用的值：

```ts
emit({
  type: "session.config",
  sessionId,
  config: {
    model: "agent-large",
    models: [{ id: "agent-large", label: "Agent Large" }],
    modes: [],
    thinkingOptions: [],
    controls: [
      { type: "toggle", key: "fast", label: "Fast mode", icon: "Zap", defaultValue: false },
      {
        type: "select",
        key: "approval",
        label: "Approvals",
        icon: "Shield",
        defaultValue: "ask",
        choices: [
          { value: "ask", label: "Ask" },
          { value: "auto", label: "Auto accept" },
        ],
      },
    ],
    providerOptions: { fast: nativeSession.fast, approval: nativeSession.approval },
  },
});
```

`icon` 是 Lucide 图标名称。`defaultValue` 是控件在键没有值时显示的值。会话打开或应用修改时，你报告的每个值（包括处于默认值的值和无人设置过的值）Paseo 都会保存。相同的控件会出现在“新建工作区”界面、草稿标签页和运行中的 Agent 上。只为你能在运行中的会话里修改的键提供控件。Provider 可以在运行时改变控件，包括在模型变化之后。

修改会以 `session.configure` 的形式到达，`changes.providerOptions` 只包含发生变化的键，无论这些键是否有控件。应用每一个键，并在 `request.completed` 之前发布已确定的 `session.config`。如果无法应用其中某个键（例如只在会话打开时读取的键），用 `request.failed` 使请求失败，并让每个键保持原样。值为 `null` 表示把该键恢复为 Provider 的默认值。请发布会话最终实际使用的值，而不是请求的副本：Paseo 会保存你发布的值，使保存的选项与实际运行的一致。

如果 Provider 自行改变了某个选项（例如切换模型后关闭了 Fast），请发布带有新值的 `session.config`。Paseo 会保存它们，不会把旧值设置回去。

并非每个选项都需要控件。例如 Provider 专属的 token 预算应放在 `providerOptions` 中，它不是一个专门的提示词字段。它会在 `session.open` 中交付，调用方可以在运行中的 Agent 上修改它，由你的 `session.configure` 处理程序决定能否实时应用。请在 `providerOptions` 中报告它，使 Paseo 保存实际运行的值。

## 添加持久化与重放 {#add-persistence-and-replay}

当原生会话可以被重新打开时，声明 `session.persistence`。当 `session.open.persistence` 不存在时，打开一个新的原生会话；存在时，恢复它所指定的原生会话。在 `session.opened` 或 `session.persistence` 中返回一个不透明的持久化值；Paseo 会保存它而不检查其内容。

当 `history` 为 `"replay"` 时，请在 `session.ready` 之前发布原生会话已有的 `timeline.item` 快照。使用 `history: "skip"` 可以在不重放旧记录的情况下打开会话。

Paseo 刷新 Agent 的方式是关闭它当前的 Provider 会话，然后用当前的配置和持久化值重新打开。请在 `session.open` 期间重新读取凭据、环境变量、全局配置和 MCP 服务器。没有单独的重新加载操作。

当 Paseo 可以从持久化值重新打开会话时，使用 `restoration: "core"`。由 Provider 拥有的子会话使用 `restoration: "parent"`；把它作为另一个带有 `parentSessionId` 的 `session.opened` 事件发出，并在恢复父会话时重新创建它。

## 添加命令和引导 {#add-commands-and-steering}

所有用户输入都通过 `session.prompt` 到达：

- `input.type: "message"` 携带文本、图片和附件；
- `input.type: "command"` 携带所选的命令及其参数；
- `delivery: "steer"` 要求你把输入加入当前正在进行的轮次；
- `delivery: "auto"` 允许你开始一个轮次，或者在没有轮次的情况下完成一条命令。

发布 `session.commands`，向 Composer 添加结构化命令。命令可以开始一个普通轮次，也可以作为副作用完成，并返回一个 `completed` 的提示词结果。

只声明你实现了的能力。如果不支持引导，请省略 `prompt.steer`；Paseo 可以改为替换当前轮次。

## 允许清理空闲运行时 {#permit-idle-runtime-cleanup}

当 daemon 的基础条件允许清理时，Paseo 可以在可恢复的会话空闲一小时后释放其运行时。在连接和会话的 `session.opened` capabilities 中声明 `session.can_stop_runtime`，即可添加 Provider 自己的否决检查。没有此能力时，会话仍使用相同的基础条件和一小时空闲期，插件不会收到安全查询。

在现有的 `send(input)` 处理函数中处理安全查询。请求使用 Provider 自己的会话 ID，包括同一连接服务多个会话的情况：

```ts
case "session.can_stop_runtime": {
  try {
    const session = sessions.get(input.sessionId);
    if (!session) throw new Error("Session not found");
    emit({
      type: "session.can_stop_runtime",
      requestId: input.requestId,
      sessionId: input.sessionId,
      canStop: await session.canStopRuntime(),
    });
  } catch (error) {
    emit({
      type: "request.failed",
      requestId: input.requestId,
      error: { message: error instanceof Error ? error.message : String(error) },
    });
  }
  return;
}
```

`canStopRuntime(): Promise<boolean>` 由你的 Provider 会话实现。只有释放运行时不会丢失后台 shell、监控任务、原生子 Agent、排队的完成报告或待处理的自主回复时，才返回 `true`。此查询不得停止或修改会话。仍有工作时返回 `false`。查询拒绝、响应无效或超时也会保留运行时。不要用 `request.completed` 响应此查询。

Paseo 始终检查前台工作、权限、排队投递、生命周期操作、工作中的托管或原生后代 Agent，以及调用方尚未完成的本地或远程完成通知订阅。订阅保护覆盖注册、恢复，直到通知投递获确认。Provider 返回 `true` 也不能绕过这些阻止条件。Paseo 会在调用现有的 `session.close` 操作之前重新检查活动。受保护的工作完成后，会重新开始一小时的空闲期。保存的 Provider 持久化数据必须能恢复同一个会话。主机设置 `agents.idleRuntimeCleanup: false` 会禁用所有 Provider 的清理。

## 发布时间线条目 {#publish-timeline-items}

通过 `timeline.item` 发布完整的快照。更新流式文本、运行中的工具或待办列表时，复用条目的 `id`。Paseo 会推导出实时增量，并保持正常的时间线。

内置的条目类型涵盖用户和助手消息、推理、工具、待办事项、错误、通知和上下文压缩。当你的 Provider 有这些类型无法表达的展示方式时，使用插件条目：

```ts
emit({
  type: "timeline.item",
  sessionId,
  item: {
    type: "plugin",
    id: "review-42",
    pluginId: "my-provider-plugin",
    kind: "review-verdict",
    version: 1,
    data: { verdict: "ship", summary: "All checks passed" },
  },
});
```

在 `index.client.tsx` 中单独注册渲染器：

```tsx
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { z } from "zod";
import { ReviewVerdict } from "./client/review-verdict";

const reviewVerdictSchema = z.object({
  verdict: z.enum(["ship", "hold"]),
  summary: z.string(),
});

export default function contribute(client: PluginClientContext) {
  client.addTimelineRenderer({
    kind: "review-verdict",
    version: 1,
    schema: reviewVerdictSchema,
    Component: ReviewVerdict,
  });
  return () => {};
}
```

同一个渲染器可以显示由 Provider、客户端时间线转换器或 daemon 时间线追加发出的条目。渲染器并不需要 Provider 实现。

## 报告指标 {#report-metrics}

把 Provider 测量到的数据以 `label` 和 `value` 的形式报告。Paseo 会原样显示每个值，所以请把它格式化成便于阅读的形式：写 `12.4s`，不要写 `12431`。哪些指标适合你的 Agent，由你决定。

在 `completed` 轮次事件中添加 `metrics`。Paseo 会在该轮次的页脚显示它们：

```ts
emit({
  type: "session.turn",
  sessionId,
  turnId,
  state: "completed",
  metrics: [
    { label: "Model", value: "example-1" },
    { label: "Elapsed", value: "12.4s" },
    { label: "Tokens", value: "18.9K ↑ · 2.3K ↓" },
    { label: "Cache", value: "82%", tone: "ok" },
  ],
});
```

对于覆盖整个会话的总计，发布 `session.metrics`。Paseo 会在上下文窗口详情中显示它们。每个事件都会替换之前的列表，空列表会清除它。把 `session.metrics` 加入你支持的能力，并且只在协商成功时发布该事件：

```ts
if (capabilities.includes("session.metrics")) {
  emit({
    type: "session.metrics",
    sessionId,
    metrics: [
      { label: "Turns", value: "7" },
      { label: "Cost", value: "$0.42" },
    ],
  });
}
```

不支持会话指标的旧版 Paseo 不会提供这项能力，并且会关闭发送该事件的连接。它会忽略轮次上的 `metrics`，所以轮次指标不需要检查。

把 `tone` 设为 `"ok"`、`"warning"` 或 `"danger"`，可以给值着色。如果已完成的轮次没有 `Model` 指标，Paseo 会添加会话的模型。

当 `history` 为 `"replay"` 时，请在每个旧轮次的条目之后发布该轮次的 `completed` 事件。Paseo 会把指标放回该轮次的页脚。

## 报告安装与更新 {#report-installation-and-updates}

在注册中添加 `installation`，Provider 的设置中就会出现 **安装** 部分。用户可以看到你的 CLI 是否已安装、是哪个版本、是否有可用更新，以及一个 **更新** 按钮，它会运行你的更新程序并显示其输出。每个成员都是可选的，只声明你的 CLI 支持的部分：

| 成员              | 用户看到的内容                                   | 何时声明                                |
| ----------------- | ------------------------------------------------ | --------------------------------------- |
| `installUrl`      | **安装说明**，未安装时还有 **安装**              | 用户需要安装 CLI                        |
| `updateUrl`       | 已安装且未声明 `update` 时显示 **更新说明**      | 你的文档说明了如何更新                  |
| `inspect`         | **版本**，或 **未安装**                          | CLI 会报告自己的版本                    |
| `checkForUpdates` | **已是最新**、**有可用更新** 或 **无法检查更新** | 你能询问 CLI 自带更新程序所用的发布来源 |
| `update`          | 已安装时显示 **更新**，随后显示更新程序的输出    | CLI 能用一条命令更新自己                |

这个 `example-agent` 会打印自己的版本，用 `self-update --check --json` 查询其更新程序会安装的发布，并用 `self-update` 更新：

```ts
import { execCommand, spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type {
  ProviderInstallation,
  ProviderInstallationLaunch,
} from "@getpaseo/plugin/server/provider";

async function run(launch: ProviderInstallationLaunch, args: string[], signal: AbortSignal) {
  const { stdout } = await execCommand(launch.command, [...launch.args, ...args], {
    env: launch.env,
    timeout: 20_000,
    signal,
  });
  return stdout.trim();
}

export const installation: ProviderInstallation = {
  installUrl: "https://example.com/docs/install",
  updateUrl: "https://example.com/docs/update",

  async inspect({ launch, signal }) {
    if (!launch?.resolved) return { status: "not_installed" };
    // `example-agent --version` prints `1.4.2`.
    return { status: "installed", version: await run(launch, ["--version"], signal) };
  },

  async checkForUpdates({ launch, installedVersion, signal }) {
    if (!launch) return { status: "unknown" };
    // Prints `{"latest":"1.5.0"}`; `self-update` installs any release that differs.
    const { latest } = JSON.parse(
      await run(launch, ["self-update", "--check", "--json"], signal),
    ) as { latest: string };
    return latest === installedVersion
      ? { status: "current" }
      : { status: "available", versions: [latest] };
  },

  async update({ launch, signal, report }) {
    if (!launch?.resolved) return { status: "failed", message: "example-agent is not installed" };
    const child = spawnProcess(launch.command, [...launch.args, "self-update"], {
      env: launch.env,
      stdio: "pipe",
    });
    child.stdin.end();
    child.stdout.on("data", (chunk: Buffer) => report({ type: "stdout", text: chunk.toString() }));
    child.stderr.on("data", (chunk: Buffer) => report({ type: "stderr", text: chunk.toString() }));
    const stop = () => void terminateProcess(child);
    signal.addEventListener("abort", stop, { once: true });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }).finally(() => signal.removeEventListener("abort", stop));
    if (code !== 0) return { status: "failed", message: `self-update exited with code ${code}` };
    return { status: "succeeded", message: "New sessions use the new version." };
  },
};
```

把它添加到注册中 `command` 的旁边：

```ts
export function createProvider(): ProviderRegistration {
  return {
    id: "example-agent",
    label: "Example Agent",
    command: ["example-agent"],
    installation,
    async connect(request) {
      // ...
    },
  };
}
```

每个回调都会收到会话将使用的启动配置。当 `launch.resolved` 为 `false` 时，Paseo 没有找到可执行文件，`command` 是配置中写的名称，因此直接报告 `not_installed`，不要运行它。注册没有声明 `command` 时，`launch` 不存在。`checkForUpdates` 只在 `inspect` 报告 CLI 已安装后运行，并通过 `installedVersion` 收到 `inspect` 报告的 `version`，所以请比较它，不要再次读取版本。对于 ACP Provider，把 `runAcpProvider()` 展开到注册中，并在旁边添加 `installation`。版本和更新探测使用会话子命令之前的启动参数，例如对运行 `hoplite acp` 的 Provider 使用 `hoplite --version`。

Paseo 把版本当作文本。它按原样显示 `version` 和 `versions`，从不解析它们，因此由你的检查决定什么算更新。询问 CLI 自带更新程序所询问的来源；做不到时就不要声明 `checkForUpdates`。返回 `unknown`、抛出异常或超过期限的检查会显示 **无法检查更新** 和你的消息，绝不会显示 **已是最新**。

`update` 只在用户选择 **更新** 时运行，并且每个 Provider 同一时间只运行一个更新。把更新程序的输出原样传给 `report`；Paseo 保留最后 65,536 个字符。Paseo 不会额外做任何校验，所以更新的效果与在终端中运行你的命令相同。返回 `succeeded` 并用消息说明新版本何时生效，或返回 `failed` 并说明原因。失败的更新会一直显示，直到用户刷新该 Provider。没有 `update` 时，**更新说明** 会打开 `updateUrl`。

只要 `inspect` 报告 CLI 已安装，就会显示 **更新** 或 **更新说明**。检查只在旁边说明它知道的情况，所以即使无法检查，也要声明 `update`。

Paseo 在设置打开时调用 `inspect`，并把结果保留 30 秒。只要 `inspect` 报告的版本不变，它就把 `checkForUpdates` 的 `current` 或 `available` 结果保留一小时，所以在 Paseo 之外更新的 CLI 会在 `inspect` 的结果过期后重新检查。`inspect` 必须在 20 秒内回答，`checkForUpdates` 必须在 25 秒内回答。`update` 没有期限。当 Paseo 停止等待或 daemon 停止时，`signal` 会中止。每个字段见 [`installation` 参考](/docs/plugins/reference#provider-installation)。

## 帮助用户解决问题 {#help-users-fix-problems}

用户得到错误结果时，会先打开 Provider 的设置，然后才去寻求帮助。请在这个页面提供他们需要的内容：声明 `docsUrl`，并从 `status` 返回能解释错误结果的事实。

```ts
export function createProvider(): ProviderRegistration {
  return {
    id: "example-agent",
    label: "Example Agent",
    command: ["example-agent"],
    docsUrl: "https://example.com/docs/paseo#troubleshooting",
    async status({ launch }) {
      if (!launch) return { available: false, diagnostic: "example-agent has no command" };
      return { available: true, diagnostic: `Profile: ${launch.env.EXAMPLE_PROFILE ?? "default"}` };
    },
    async connect(request) {
      // ...
    },
  };
}
```

**文档** 会打开 `docsUrl`。**诊断报告** 会显示命令、可执行文件的路径和 Paseo 找到的版本，然后是你的 `Profile` 行。请报告 CLI 从环境中读取的内容，例如账号、profile 或正在使用的配置文件。这些内容在 daemon 和用户的终端之间可能不同，用户在应用中也看不到。Paseo 写入的各行以及 `status` 的规则见[故障排查参考](/docs/plugins/reference#provider-troubleshooting)。

## 适配 ACP Agent {#adapt-an-acp-agent}

当 Agent 已经支持 ACP 时，使用 ACP 适配层：

```ts
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(
    runAcpProvider({
      id: "vendor-agent",
      label: "Vendor agent",
      icon: "icon.svg",
      command: ["vendor-agent", "acp"],
    }),
  );
  return () => {};
}
```

适配层负责 ACP 进程、能力映射、会话生命周期、提示词、权限和时间线转换。不要把这些机制复制到插件中。

使用 `transformers` 处理 ACP 无法描述的厂商差异。
[goose 模型转换器](https://github.com/getpaseo/paseo/blob/main/plugins/goose-provider/server/models.ts)
使用 `context.request` 读取 Agent 的模型列表，并使用 `config` 为会话的模型 ID 添加当前 Provider 前缀。
参见 [ACP 适配器参考](/docs/plugins/reference#providers)。

用 Zod 校验厂商负载，并让格式错误或无关的值保持不变：

```ts
import type { AcpTransformer } from "@getpaseo/plugin/server/acp";
import { z } from "zod";

const editSchema = z.object({
  path: z.string(),
  before: z.string(),
  after: z.string(),
});

export const vendorEdits: AcpTransformer = {
  toolCall(toolCall) {
    if (toolCall.name !== "vendor_file_edit") return toolCall;
    const input = editSchema.safeParse(toolCall.input);
    if (!input.success) return toolCall;
    return {
      ...toolCall,
      kind: "edit",
      input: {
        filePath: input.data.path,
        oldString: input.data.before,
        newString: input.data.after,
      },
    };
  },
};
```

Paseo 根据每个调用的 ACP `kind` 生成标准工具卡片：`execute` 显示为 Shell，`read` 显示为 Read，`edit` 和 `delete` 显示为 Edit，`search` 显示为 Search，`fetch` 显示为 Fetch。卡片读取调用的 `input`（ACP `rawInput`）、`output`（`rawOutput`）、`content` 和 `locations`。其他类型的调用显示原始输入和输出；如果 Agent 两者都没有发送，则显示文本内容。

在返回的工具调用上设置 `detail` 可以替换标准卡片。例如，Agent 可能把新建文件报告为 ACP 编辑，而插件返回带有文件路径和内容的 `write` detail。返回 `{ type: "unknown", input, output }` 可以显示原始值。

`toolCall` 会在调用的每次更新时运行，参数是到目前为止合并后的调用。按照 ACP 的定义，发送了 `content` 的更新会替换之前的内容。如果 Agent 只在较早的更新中发送某个值，请从 `context.previous` 读取，它是 Paseo 上一次展示的调用。[Hermes 终端转换器](https://github.com/getpaseo/paseo/blob/main/plugins/hermes-provider/server/terminal-command.ts)就是这样保留 Hermes 第一次更新中的命令。

如果 Agent 只为当前选中的模型列出 `thought_level` 选项，请设置 `acpOptions.perModelThinkingOptions`。目录发现会依次选中每个模型，并为它记录 Agent 列出的思考选项。没有 `thought_level` 选项的模型不会显示思考选择器。

## 测试与发布 {#test-and-publish}

用真实的 Agent 测试 Provider，而不只是模拟的数据帧：

1. 以目录来源安装插件；
2. 确认它的 SVG、模型、模式和选项控件都会显示；
3. 创建会话并完成一段真实的提示词；
4. 在支持的情况下，试用权限、引导、取消、持久化和重放；
5. 在桌面和移动端宽度的布局中渲染每一种自定义时间线条目；
6. 在会话处于活动状态时重新加载和移除插件，并确认会话随之终止。

按照[发布插件](/docs/plugins/publishing)通过 npm 或 Git 分发 Provider。把 Agent 兼容性和版本发布保留在插件项目中。

确切的运行时和 SVG 规则见[插件参考](/docs/plugins/reference#providers)。
