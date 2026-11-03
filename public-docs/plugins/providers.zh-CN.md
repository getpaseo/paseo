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

- [`provider-direct`](https://github.com/getpaseo/paseo/tree/main/plugin-examples/provider-direct)：会话、设置、提示词、持久化、子会话，以及一个由 Provider 拥有的时间线渲染器；
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

## 打开会话 {#open-a-session}

`session.open` 包含完整的启动配置：工作目录、环境变量、系统提示词、MCP 服务器、工具策略、模型、模式、设置、不透明的 Provider 选项以及持久化偏好。

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
    settings: [],
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

## 添加会话专属的 Composer 控件 {#add-session-specific-composer-controls}

只有当原生 Agent 有用户在打开会话后需要修改的设置时，才添加 `session.configure`。在 `session.config` 中以开关或选择控件的形式发布它们：

```ts
emit({
  type: "session.config",
  sessionId,
  config: {
    model: "agent-large",
    models: [{ id: "agent-large", label: "Agent Large" }],
    modes: [],
    thinkingOptions: [],
    settings: [
      {
        type: "toggle",
        id: "fast",
        label: "Fast mode",
        value: nativeSession.fast,
      },
      {
        type: "select",
        id: "approval",
        label: "Approvals",
        value: nativeSession.approval,
        options: [
          { label: "Ask", value: "ask" },
          { label: "Auto accept", value: "auto" },
        ],
      },
    ],
  },
});
```

Paseo 会在 Composer 中渲染这些控件。用户的修改会以 `session.configure` 的形式到达；应用它，并在 `request.completed` 之前发布已确定的 `session.config`。Provider 可以在运行时改变可用的控件，包括在模型变化之后。

`settings` 是面向用户的控件。`providerOptions` 是在创建会话时提供的不透明 JSON，用于 Paseo 不会渲染的 Provider 专属配置。Provider 专属的 token 预算应放在这两处之一；它不是一个专门的提示词字段。

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

只在 ACP 无法描述厂商差异时使用 `transformers`。用 Zod 校验厂商负载，并让格式错误或无关的值保持不变：

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

## 测试与发布 {#test-and-publish}

用真实的 Agent 测试 Provider，而不只是模拟的数据帧：

1. 以目录来源安装插件；
2. 确认它的 SVG、模型、模式和设置都会显示；
3. 创建会话并完成一段真实的提示词；
4. 在支持的情况下，试用权限、引导、取消、持久化和重放；
5. 在桌面和移动端宽度的布局中渲染每一种自定义时间线条目；
6. 在会话处于活动状态时重新加载和移除插件，并确认会话随之终止。

按照[发布插件](/docs/plugins/publishing)通过 npm 或 Git 分发 Provider。把 Agent 兼容性和版本发布保留在插件项目中。

确切的运行时和 SVG 规则见[插件参考](/docs/plugins/reference#providers)。
