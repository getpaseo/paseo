# 向 Paseo 添加新的 Provider

本指南将逐步介绍如何端到端地添加一个新的 agent provider。共有两种集成模式，本文档涵盖两者。

## 两种集成模式

### ACP（Agent Client Protocol）-- 推荐

继承 `packages/server/src/server/agent/providers/acp-agent.ts` 中的 `ACPAgentClient`。基类负责进程生成、stdio 传输、会话生命周期、流式传输、权限以及模型发现。你需要提供配置（命令、模式、能力），并可选择重写 `isAvailable()` 用于认证检查。

目前唯一内置的 ACP provider 是 `copilot`（`copilot-acp-agent.ts`）。`GenericACPAgentClient`（`generic-acp-agent.ts`）同样基于 ACP，但用于通过 `extends: "acp"` 覆盖配置的用户自定义 provider——详见 [docs/custom-providers.md](custom-providers.md)。

Copilot 自定义 agent 通过 ACP 会话配置暴露，而非斜杠命令列表。当自定义 agent 可用时，Copilot 会返回一个带有 `id: "agent"` 和 `category: "_agent"` 的选择配置选项；Paseo 将其映射到 `agent` provider 特性。Copilot 使用 agent 的显示名称作为选项值，空白值表示默认的 Copilot agent。

### Direct

自己实现 `agent-sdk-types.ts` 中的 `AgentClient` 和 `AgentSession` 接口。这种方式提供完全的控制权，但需要你从头处理进程管理、流式传输、权限和会话持久化。

现有的 direct provider：`claude`（在 `providers/claude/agent.ts` 中）、`codex`（`codex-app-server-agent.ts`）、`opencode`（`opencode-agent.ts`）、`pi`（`providers/pi/agent.ts`）以及 `omp`（一个由 Pi 适配器支持的 Pi 兼容内置 provider）。仅用于开发的 `mock` provider（`mock-load-test-agent.ts`）也是 direct 模式。

Claude 第一方模型元数据位于 `packages/server/src/server/agent/providers/claude/model-manifest.ts`。添加或更新 Claude 模型时，仅更新该清单文件；模型选择器的思考选项和 Claude 特定的特性开关均从该清单派生。不要在特性代码中添加模型特定的 Claude 能力列表。

Paseo 工具并非作为 MCP 工具在内部实现。它们位于 `packages/server/src/server/agent/tools/` 下的共享工具目录中；MCP 只是回退适配器。可以直接注册运行时工具的 provider 应设置 `supportsNativePaseoTools: true`，并在 `createSession`/`resumeSession` 中使用 `launchContext.paseoTools`。当原生工具存在时，`AgentManager` 会从 provider 启动配置中移除内部 Paseo MCP 服务器，以避免 provider 重复接收相同的工具。只支持 MCP 的 provider 应保持 `supportsMcpServers: true`，让守护进程注入 `/mcp/agents`。

Pi 是一个基于进程的 provider。Paseo 要求用户安装 `pi` 二进制文件，并通过 `pi --mode rpc` 与之通信；server 包不嵌入 Pi 的 SDK/运行时包。

Paseo 的每个 agent 的和守护进程级别的系统提示通过 `--append-system-prompt` 传递给 Pi，这样 Pi 在保留其默认编码提示的同时接收 Paseo 的额外指令。

Pi 的 MCP 支持取决于在 agent 工作目录下加载的开源 `pi-mcp-adapter` 扩展。通过 Pi RPC 的 `get_commands` 探测；适配器会注册一个名为 `mcp` 的扩展命令（通常其 `sourceInfo.source` 包含 `pi-mcp-adapter`）。当 Paseo 向 Pi 注入 MCP 服务器时，写入一个按 agent 独立的 MCP 配置并使用 `--mcp-config` 传递，而不是修改用户或项目的 MCP 文件。对于本地 HTTP 服务器（如 Paseo 自身的 `/mcp/agents` 端点），在生成的配置中明确禁用适配器 OAuth（`auth: false`，`oauth: false`）。

Pi 的导入发现功能读取 Pi 持久化的 JSONL 会话文件，因为 Pi RPC 不暴露最近的会话列表命令。恢复和完整历史记录填充仍然通过 `pi --mode rpc` 进行，使用会话文件作为 `nativeHandle`。

OMP 是一个内置的 Pi 兼容 provider，默认禁用。它使用 `omp` 命令，并在启用时从 `~/.omp/agent/sessions` 导入通过终端启动的会话。其他 Pi 兼容的分支仍然可以作为自定义 provider，扩展 `pi`，重写 `command`，并将 `params.sessionDir` 设置为它们的 JSONL 会话目录。

Pi 和 OMP 目前使用不同的 RPC 名称进行斜杠命令发现。Pi 包接受 `get_commands`；OMP 接受 `get_available_commands`。将其作为内置 provider 的显式适配器设置，而不是用回退方式探测，因为两个包在没有请求 `id` 的情况下都会返回未知命令错误，这会将快速的不匹配变成正常的 RPC 超时。

Pi RPC 扩展 UI 对话框请求（`select`、`input`、`editor`、`confirm`）会被桥接到 Paseo 的问题权限中，并通过 `extension_ui_response` 应答。Pi 扩展（如 `ask_user`）可能会链式调用对话框：例如，一个 `select` 之后可以跟一个可选评论的 `input`。当 `ask_user` 工具调用声明 `allowComment: true` 时，Paseo 将选择和可选评论作为一个问题权限一起呈现，立即应答 Pi 的初始 `select`，然后自动用用户已提供的评论（或空字符串）应答后续的可选 `input`。保留独立可选输入的占位符和可选/跳过语义，以便应用仍然能够区分"跳过此可选输入"和"取消整个对话框"。通知类的一次性扩展 UI 请求会被 provider 适配器有意忽略，除非 Paseo 为它们提供了第一方 UI。

OpenCode 的 MCP 注入是动态的且限定在会话范围内。调用 OpenCode 的 `mcp.add` 端点并传入 MCP 服务器配置，不要在其后调用 `mcp.connect`；`connect` 仅切换已存在于 OpenCode 自身配置中的 MCP 服务器。新版本的 OpenCode 在动态添加后对 `connect` 返回 `McpServerNotFoundError`/404，因为该服务器不是基于配置的，而旧版本对于相同的缺少配置路径会静默吞掉错误。

OpenCode 拥有用户消息 ID。不要将 Paseo 生成的 ID 传递给 OpenCode 的 prompt API；让 OpenCode 创建 `msg*` ID，并从 `message.updated` 事件中记录用户时间线条目。

每个 provider 适配器拥有其规范的用户消息时间线行。当前台提示被接受时，适配器必须为该已提交的提示恰好发出一个 `user_message` 时间线条目，使用它提供给 provider 运行时或从 provider 运行时接收的相同消息 ID。客户端乐观消息仅用于 UI，provider 的消息回显是可选的；两者都不允许作为唯一的真实数据来源。如果 provider 稍后回显相同的已提交用户消息，仅在当前轮次内去重。优先使用 provider 可见的消息 ID，但 ACP 运行时可能会省略该 ID 或用 provider 拥有的 ID 替换它；在这种情况下，仅抑制其累积文本是当前已提交提示前缀的回显块。不要执行全局的消息文本去重。

草稿元数据查询应避免在上级 provider 有顶级 API 提供该元数据时创建 provider 会话。优先使用 `AgentClient.fetchCatalog`、`listCommands` 或 `listFeatures`，而不是创建临时的 `AgentSession`；临时会话可能会在 provider 导入/历史 UI 中显示为空的原生会话。`fetchCatalog` 是模型和模式的唯一发现 API——provider 实现内部可能使用一个进程、多个独立的上游调用或静态数据，但 provider 外部的调用者不会获得独立的运行时模型/模式探测。草稿的特性和命令列表必须仅使用显式的草稿模型；如果尚未选择模型，则返回无元数据，而不是通过目录发现解析默认模型。

Provider 会话导入有自己的契约。选择器调用 `listImportableSessions` 并仅接收行数据：provider 句柄、工作目录、标题、提示预览和最后活动时间。导入时对选中的行调用 `importSession({ providerHandleId, cwd })`，且不得再次调用列表。Provider 返回该原生会话的恢复会话、存储配置、持久化句柄和已填充的时间线；`AgentManager.importProviderSession` 在一切就绪后才播种守护进程时间线并发布 Paseo agent。

## Provider 辅助进程

Provider 拥有的、可能比单个 agent 会话存活更久的辅助进程必须记录在守护进程的托管进程注册表中。存储 provider/kind 元数据、PID、启动命令/参数以及从平台进程表中捕获的进程标识。在正常退出或关闭时移除记录。

如果辅助进程具有就绪阶段，provider 的生命周期模型必须在 `spawn` 之后、就绪成功之前立即拥有该进程。启动超时、启动退出和守护进程关闭都必须通过该拥有的进程代进行清理。不要仅将已生成的辅助进程保留在就绪期的 promise 中；这会在管理器/回收器契约之外创建一个活进程。

守护进程启动时在后台对账该注册表，不阻塞启动：已死亡的 PID 被删除，PID 标识不匹配的被删除而不终止任何进程，仅终止经过确认匹配的 Paseo 拥有的残留进程，无法检查其进程的记录保留到下次对账而不是立即删除。不要为 provider 清理添加宽泛的进程名清扫器；清理从 Paseo 之前写入的记录开始。

---

## Provider 快照刷新契约

守护进程按已解析的工作目录维护 provider 快照，附带一个独立的语义化全局作用域，用于不携带工作目录的设置/provider 管理和请求。Provider 目录探测接收一个可区分的 `FetchCatalogOptions`：`{ scope: "global", force }` 用于全局目录刷新，或 `{ scope: "workspace", cwd, force }` 用于项目作用域刷新。Provider 决定全局对其运行时意味着什么；不要通过将工作目录与用户主目录比较来推断全局。

快照读取仅在请求的工作目录作用域处于冷状态时才探测 provider。一旦条目变为热状态，其 `ready`、`error` 或 `unavailable` 状态会保持缓存，直到显式刷新。不要添加 TTL 重新验证、焦点触发的刷新、选择器打开时的刷新或配置重载时的刷新。选择器打开时的重新获取可以读取正在加载中或过时的 React Query，但不得自行强制触发 provider 探测。

设置刷新是用户面对的"在所有地方遗忘过时的 provider 知识"操作。设置刷新清除所有工作目录作用域的 provider 快照缓存和正在进行的加载，然后立即仅用 `force: true` 刷新全局快照。工作区快照在下次按作用域读取时延迟重新探测；不要将设置刷新扇出到每个已知的工作区。

注册表/配置替换可以更新可见的元数据，如标签、描述、默认模式、启用状态和 provider 成员关系，但不得生成 provider 进程。如果 provider 在配置更改后需要重新探测，通过显式的设置刷新路径处理。

边界测试应当断言可观察的行为：冷读取可以对相应作用域调用 provider 可用性/模型/模式发现；热读取和注册表替换不得调用；显式工作区刷新仅影响一个工作目录；设置刷新清除所有作用域但立即刷新仅全局。

---

## Provider 用量获取器

Provider 方案用量是按需获取的，不是守护进程推送订阅。当用量工具提示或主机用量设置界面显示时，应用通过 React Query 调用 `provider.usage.list.request`，守护进程直接返回规范化的 `ProviderUsage` 列表。

要为 provider 添加方案用量，在 `packages/server/src/services/quota-fetcher/providers/<provider>.ts` 中添加文件，并在 `packages/server/src/services/quota-fetcher/manifest.ts` 中注册。Provider 文件仅导出其获取器类；provider 的认证、端点常量、API 模式和规范化辅助函数保持在该文件内部。获取器拥有 provider 的认证/API 解析，并返回通用结构：

- `providerId`、`displayName`、`status` 和可选的 `planLabel`
- 任意数量的 `windows`，如 Session、Weekly 或 Biweekly
- 可选的 `balances`，用于积分、美元、请求或 token
- 可选的 `details`，用于 provider 特定的行

保持协议结构与 provider 无关。不要为新限制窗口添加 provider 特定的渲染器；标签和通用进度条应承载 UI。API 响应应在获取器内部用 Zod 解析和规范化，而协议边界保持严格，以便新旧客户端的兼容性是显式的。

Kimi Code 用量遵循 CLI 管理的凭证文件，位于 `KIMI_CODE_HOME` 或 `~/.kimi-code/credentials/kimi-code.json`；不要将旧版 `~/.kimi` 路径作为当前 Kimi Code 安装的主要来源进行探测。

---

## ACP Provider 检查清单

### 1. 创建 provider 类

创建 `packages/server/src/server/agent/providers/{name}-agent.ts`。

定义能力、模式以及 `ACPAgentClient` 的一个精简子类：

```ts
import type { Logger } from "pino";
import type { AgentCapabilityFlags, AgentMode } from "../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../provider-launch-config.js";
import { ACPAgentClient } from "./acp-agent.js";

const MY_PROVIDER_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

const MY_PROVIDER_MODES: AgentMode[] = [
  {
    id: "default",
    label: "Default",
    description: "Standard agent mode",
  },
  // 根据需要添加更多模式
];

type MyProviderClientOptions = {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
};

export class MyProviderACPAgentClient extends ACPAgentClient {
  constructor(options: MyProviderClientOptions) {
    super({
      provider: "my-provider", // 必须与各处使用的 ID 匹配
      logger: options.logger,
      runtimeSettings: options.runtimeSettings,
      defaultCommand: ["my-agent-binary", "--acp"], // 要生成的 CLI 命令
      defaultModes: MY_PROVIDER_MODES,
      capabilities: MY_PROVIDER_CAPABILITIES,
    });
  }

  // 如果 provider 需要特定的认证/环境变量，重写 isAvailable()
  override async isAvailable(): Promise<boolean> {
    if (!(await super.isAvailable())) {
      return false; // 未找到二进制文件
    }
    return Boolean(process.env["MY_PROVIDER_API_KEY"]);
  }
}
```

`super.isAvailable()` 调用检查 `defaultCommand` 中的二进制文件是否在 `$PATH` 上。仅重写以在其基础上添加凭证检查。

作为参考，以下是 Copilot 的做法——不需要认证重写，因为 CLI 自行处理认证：

```ts
export class CopilotACPAgentClient extends ACPAgentClient {
  constructor(options: CopilotACPAgentClientOptions) {
    super({
      provider: "copilot",
      logger: options.logger,
      runtimeSettings: options.runtimeSettings,
      defaultCommand: ["copilot", "--acp"],
      defaultModes: COPILOT_MODES,
      capabilities: COPILOT_CAPABILITIES,
    });
  }

  override async isAvailable(): Promise<boolean> {
    return super.isAvailable();
  }
}
```

### 2. 添加到 provider 清单

在 `packages/server/src/server/agent/provider-manifest.ts` 中，添加带有 UI 元数据（图标、颜色层级）的模式定义和一个 provider 定义条目。

首先，定义带有视觉元数据的模式：

```ts
const MY_PROVIDER_MODES: AgentProviderModeDefinition[] = [
  {
    id: "default",
    label: "Default",
    description: "Standard agent mode",
    icon: "ShieldCheck",
    colorTier: "safe",
  },
  {
    id: "autonomous",
    label: "Autonomous",
    description: "Runs without prompting",
    icon: "ShieldOff",
    colorTier: "dangerous",
  },
];
```

可用的 `colorTier` 值：`"safe"`、`"moderate"`、`"dangerous"`、`"planning"`。
可用的 `icon` 值：`"ShieldCheck"`、`"ShieldAlert"`、`"ShieldOff"`。

然后添加到 `AGENT_PROVIDER_DEFINITIONS` 数组：

```ts
export const AGENT_PROVIDER_DEFINITIONS: AgentProviderDefinition[] = [
  // ... 现有的 provider ...
  {
    id: "my-provider",
    label: "My Provider",
    description: "Short description of the provider",
    defaultModeId: "default",
    modes: MY_PROVIDER_MODES,
    // 可选：启用语音
    voice: {
      enabled: true,
      defaultModeId: "default",
      defaultModel: "some-model",
    },
  },
];
```

### 3. 将工厂添加到 provider 注册表

在 `packages/server/src/server/agent/provider-registry.ts` 中，导入你的类并在 `PROVIDER_CLIENT_FACTORIES` 中添加一个工厂条目：

```ts
import { MyProviderACPAgentClient } from "./providers/my-provider-agent.js";

const PROVIDER_CLIENT_FACTORIES: Record<string, ProviderClientFactory> = {
  // ... 现有的工厂 ...
  "my-provider": (logger, runtimeSettings) =>
    new MyProviderACPAgentClient({
      logger,
      runtimeSettings,
    }),
};
```

工厂以 `(logger, runtimeSettings, options)` 形式调用；如果需要，也可以使用 `options.workspaceGitService`（参见 `codex` 工厂示例）。注册表已经将按 provider 的运行时设置切片传递过来，因此你不需要自己从映射中索引。

### 4. 添加 provider 图标（app）

参照现有图标（如 `claude-icon.tsx`）的模式，创建 `packages/app/src/components/icons/my-provider-icon.tsx`：

```tsx
import Svg, { Path } from "react-native-svg";

interface MyProviderIconProps {
  size?: number;
  color?: string;
}

export function MyProviderIcon({ size = 16, color = "currentColor" }: MyProviderIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path d="..." />
    </Svg>
  );
}
```

然后在 `packages/app/src/components/provider-icons.ts` 中，向现有的 `PROVIDER_ICONS` 映射（已涵盖内置 provider）添加条目来注册它：

```ts
import { MyProviderIcon } from "@/components/icons/my-provider-icon";

const PROVIDER_ICONS: Record<string, typeof Bot> = {
  // ... 现有的条目 ...
  "my-provider": MyProviderIcon as unknown as typeof Bot,
};
```

如果未注册图标，`getProviderIcon()` 会回退到 lucide 的通用 `Bot` 图标。

### 5. 添加 E2E 测试配置

在 `packages/server/src/server/daemon-e2e/agent-configs.ts` 中，添加你的 provider：

```ts
export const agentConfigs = {
  // ... 现有的配置 ...
  "my-provider": {
    provider: "my-provider",
    model: "default-model-id",
    modes: {
      full: "autonomous", // 无权限提示的模式
      ask: "default", // 需要权限审批的模式
    },
  },
} as const satisfies Record<string, AgentTestConfig>;
```

在 `isProviderAvailable()` 中添加可用性检查。注意 `isCommandAvailable` 是异步的，因此所有分支都要 `await` 它：

```ts
case "my-provider":
  return (
    (await isCommandAvailable("my-agent-binary")) &&
    Boolean(process.env.MY_PROVIDER_API_KEY)
  );
```

添加到 `allProviders` 数组（当前内置的为 `claude`、`codex`、`copilot`、`opencode`、`pi`、`omp`）：

```ts
export const allProviders: AgentProvider[] = [
  "claude",
  "codex",
  "copilot",
  "opencode",
  "pi",
  "my-provider",
];
```

### 6. 运行类型检查

```bash
npm run typecheck
```

根据项目规则，每次更改后都必须执行此操作。

---

## Direct Provider 检查清单

如果你的 agent 不支持 ACP，直接实现 `agent-sdk-types.ts` 中的接口。

### 需要实现的接口

以下接口是精简的签名——阅读 `agent-sdk-types.ts` 获取完整的真实来源（选项包类型、泛型等）。

**`AgentClient`** -- 会话的工厂以及模型/模式列表：

```ts
interface AgentClient {
  readonly provider: AgentProvider;
  readonly capabilities: AgentCapabilityFlags;
  createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession>;
  resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession>;
  fetchCatalog(options: FetchCatalogOptions): Promise<ProviderCatalog>;
  isAvailable(): Promise<boolean>;
  // 可选：
  listImportableSessions(
    options?: ListImportableSessionsOptions,
  ): Promise<ImportableProviderSession[]>;
  importSession(
    input: ImportProviderSessionInput,
    context: ImportProviderSessionContext,
  ): Promise<ImportedProviderSession>;
  getDiagnostic?(): Promise<{ diagnostic: string }>;
}
```

**`AgentSession`** -- 一个正在运行的 agent 对话：

```ts
interface AgentSession {
  readonly provider: AgentProvider;
  readonly id: string | null;
  readonly capabilities: AgentCapabilityFlags;
  readonly features?: AgentFeature[];
  run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult>;
  startTurn(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<{ turnId: string }>;
  subscribe(callback: (event: AgentStreamEvent) => void): () => void;
  streamHistory(): AsyncGenerator<AgentStreamEvent>;
  getRuntimeInfo(): Promise<AgentRuntimeInfo>;
  getAvailableModes(): Promise<AgentMode[]>;
  getCurrentMode(): Promise<string | null>;
  setMode(modeId: string): Promise<void | AgentProviderNotice>;
  getPendingPermissions(): AgentPermissionRequest[];
  respondToPermission(
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void>;
  describePersistence(): AgentPersistenceHandle | null;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  // 可选：
  listCommands?(): Promise<AgentSlashCommand[]>;
  setModel?(modelId: string | null): Promise<void>;
  setThinkingOption?(thinkingOptionId: string | null): Promise<void | AgentProviderNotice>;
  setFeature?(featureId: string, value: unknown): Promise<void>;
  tryHandleOutOfBand?(prompt: AgentPromptInput): {
    run(ctx: { emit: (event: AgentStreamEvent) => void }): Promise<void>;
  } | null;
}
```

`setMode` 和 `setThinkingOption` 可以在 provider 知道该变更需要面向用户的上下文时返回 `AgentProviderNotice`。例如，将变更推迟到下一轮次的 provider 应在轮次已运行时返回 `info` 通知。应用将通知通用地渲染为 toast；provider 特定的生命周期行为保留在 provider 实现中。

### 步骤

1. 创建 `packages/server/src/server/agent/providers/{name}-agent.ts`，实现两个接口
2. 添加到 provider 清单（与上述 ACP 步骤 2 相同）
3. 将工厂添加到注册表（与上述 ACP 步骤 3 相同）
4. 添加图标（与上述 ACP 步骤 4 相同）
5. 添加 E2E 配置（与上述 ACP 步骤 5 相同）
6. 运行类型检查

---

## 测试

### 使用 CLI 进行手动测试

如果守护进程尚未运行，先启动它，然后：

```bash
# 使用你的 provider 启动一个 agent
paseo run --provider my-provider

# 使用特定模型和模式启动
paseo run --provider my-provider --model some-model --mode default

# 列出正在运行的 agent
paseo ls -a -g

# 检查 provider 是否报告模型
paseo models --provider my-provider
```

### E2E 测试模式

`agent-configs.ts` 中的 E2E 配置暴露了两个辅助函数：

- `getFullAccessConfig(provider)` -- 返回无权限提示的会话配置
- `getAskModeConfig(provider)` -- 返回会触发权限请求的会话配置

测试使用 `isProviderAvailable(provider)` 在二进制文件或凭证缺失时跳过，因此 CI 不会因未安装的 provider 而失败。

---

## 注意事项

**模式 ID 可以是 URI。** 像 Copilot 这样的 ACP provider 使用完整 URI 作为模式 ID（例如 `"https://agentclientprotocol.com/protocol/session-modes#agent"`）。永远不要假设模式 ID 是简单的字符串。清单中的 `defaultModeId` 必须完全匹配。

**模型和模式是动态发现的。** ACP provider 通过协议在运行时报告可用的模型和模式。`provider-manifest.ts` 中的静态定义用于 UI 脚手架（图标、颜色层级），但 agent 进程的运行时值是真实数据来源。

**`AgentProvider` 始终是 `string`。** 类型别名为 `type AgentProvider = string`。Provider ID 在运行时根据清单进行验证，而不是在类型层面。

**认证模式各不相同。** 一些 provider 需要环境变量中的 API 密钥（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`），一些使用 OAuth 令牌（`CLAUDE_CODE_OAUTH_TOKEN`），一些使用认证文件（`~/.codex/auth.json`），还有一些完全在其 CLI 二进制文件中处理认证（Copilot）。你的 `isAvailable()` 方法应检查所需的任何内容。

**清单中的模式列表和 agent 类中的模式列表是分开的。** `provider-manifest.ts` 中的清单包含 UI 元数据（`icon`、`colorTier`）。agent 类定义的模式不包含 UI 元数据（仅有 `id`、`label`、`description`）。保持它们同步。

**`defaultCommand` 是一个元组。** 第一个元素是二进制名称，其余是默认参数。基类使用它来查找可执行文件并生成进程。

**运行时设置可以覆盖命令。** 用户可以通过 `ProviderRuntimeSettings` 为每个 provider 配置自定义二进制路径或环境变量。你在注册表中的工厂应将 `runtimeSettings?.["your-provider"]` 传递给构造函数。
