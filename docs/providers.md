# Adding a New Provider to Paseo

This guide walks through adding a new agent provider end-to-end. There are two integration patterns, and this doc covers both.

## Two Integration Patterns

### ACP (Agent Client Protocol) -- recommended

Extend `ACPAgentClient` from `packages/server/src/server/agent/providers/acp-agent.ts`. The base class handles process spawning, stdio transport, session lifecycle, streaming, permissions, and model discovery. You provide configuration (command, modes, capabilities) and optionally override `isAvailable()` for auth checks.

The only built-in ACP provider today is `copilot` (`copilot-acp-agent.ts`). `GenericACPAgentClient` (`generic-acp-agent.ts`) is also ACP-based but is used for user-defined custom providers configured via `extends: "acp"` overrides — see [docs/custom-providers.md](custom-providers.md).

### Direct

Implement the `AgentClient` and `AgentSession` interfaces from `agent-sdk-types.ts` yourself. This gives full control but requires you to handle process management, streaming, permissions, and session persistence from scratch.

Existing direct providers: `claude` (in `providers/claude/agent.ts`), `codex` (`codex-app-server-agent.ts`), `opencode` (`opencode-agent.ts`), `pi` (`pi-direct-agent.ts`). The dev-only `mock` provider (`mock-load-test-agent.ts`) is also direct.

---

## ACP Provider Checklist

### 1. Create the provider class

Create `packages/server/src/server/agent/providers/{name}-agent.ts`.

Define capabilities, modes, and a thin subclass of `ACPAgentClient`:

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
  // Add more modes as needed
];

type MyProviderClientOptions = {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
};

export class MyProviderACPAgentClient extends ACPAgentClient {
  constructor(options: MyProviderClientOptions) {
    super({
      provider: "my-provider", // Must match the ID used everywhere else
      logger: options.logger,
      runtimeSettings: options.runtimeSettings,
      defaultCommand: ["my-agent-binary", "--acp"], // CLI command to spawn
      defaultModes: MY_PROVIDER_MODES,
      capabilities: MY_PROVIDER_CAPABILITIES,
    });
  }

  // Override isAvailable() if the provider needs specific auth/env vars
  override async isAvailable(): Promise<boolean> {
    if (!(await super.isAvailable())) {
      return false; // Binary not found
    }
    return Boolean(process.env["MY_PROVIDER_API_KEY"]);
  }
}
```

The `super.isAvailable()` call checks that the binary from `defaultCommand` is on `$PATH`. Override only to add credential checks on top.

For reference, here is how Copilot does it -- no auth override needed because the CLI handles auth itself:

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

### 2. Add to the provider manifest

In `packages/server/src/server/agent/provider-manifest.ts`, add mode definitions with UI metadata (icons, color tiers) and a provider definition entry.

First, define the modes with visual metadata:

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

Available `colorTier` values: `"safe"`, `"moderate"`, `"dangerous"`, `"planning"`.
Available `icon` values: `"ShieldCheck"`, `"ShieldAlert"`, `"ShieldOff"`.

Then add to the `AGENT_PROVIDER_DEFINITIONS` array:

```ts
export const AGENT_PROVIDER_DEFINITIONS: AgentProviderDefinition[] = [
  // ... existing providers ...
  {
    id: "my-provider",
    label: "My Provider",
    description: "Short description of the provider",
    defaultModeId: "default",
    modes: MY_PROVIDER_MODES,
    // Optional: enable voice
    voice: {
      enabled: true,
      defaultModeId: "default",
      defaultModel: "some-model",
    },
  },
];
```

### 3. Add the factory to the provider registry

In `packages/server/src/server/agent/provider-registry.ts`, import your class and add a factory entry to `PROVIDER_CLIENT_FACTORIES`:

```ts
import { MyProviderACPAgentClient } from "./providers/my-provider-agent.js";

const PROVIDER_CLIENT_FACTORIES: Record<string, ProviderClientFactory> = {
  // ... existing factories ...
  "my-provider": (logger, runtimeSettings) =>
    new MyProviderACPAgentClient({
      logger,
      runtimeSettings,
    }),
};
```

The factory is invoked with `(logger, runtimeSettings, options)`; `options.workspaceGitService` is also available if you need it (see the `codex` factory for an example). The registry already passes the per-provider runtime settings slice through, so you don't index into the map yourself.

### 4. Add a provider icon (app)

Create `packages/app/src/components/icons/my-provider-icon.tsx` following the pattern from existing icons (e.g., `claude-icon.tsx`):

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

Then register it in `packages/app/src/components/provider-icons.ts` by adding an entry to the existing `PROVIDER_ICONS` map (which already covers the built-in providers):

```ts
import { MyProviderIcon } from "@/components/icons/my-provider-icon";

const PROVIDER_ICONS: Record<string, typeof Bot> = {
  // ... existing entries ...
  "my-provider": MyProviderIcon as unknown as typeof Bot,
};
```

If no icon is registered, `getProviderIcon()` falls back to a generic `Bot` icon from lucide.

### 5. Add E2E test config

In `packages/server/src/server/daemon-e2e/agent-configs.ts`, add your provider:

```ts
export const agentConfigs = {
  // ... existing configs ...
  "my-provider": {
    provider: "my-provider",
    model: "default-model-id",
    modes: {
      full: "autonomous", // Mode with no permission prompts
      ask: "default", // Mode that requires permission approval
    },
  },
} as const satisfies Record<string, AgentTestConfig>;
```

Add an availability check in `isProviderAvailable()`. Note `isCommandAvailable` is async, so all branches `await` it:

```ts
case "my-provider":
  return (
    (await isCommandAvailable("my-agent-binary")) &&
    Boolean(process.env.MY_PROVIDER_API_KEY)
  );
```

Add to the `allProviders` array (current built-ins are `claude`, `codex`, `copilot`, `opencode`, `pi`):

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

### 6. Run typecheck

```bash
npm run typecheck
```

This is required after every change per project rules.

---

## Direct Provider Checklist

If your agent does not speak ACP, implement the interfaces from `agent-sdk-types.ts` directly.

### Interfaces to implement

The interfaces below are abridged signatures — read `agent-sdk-types.ts` for the full source of truth (option bag types, generics, etc.).

**`AgentClient`** -- factory for sessions and model/mode listing:

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
  listModels(options: ListModelsOptions): Promise<AgentModelDefinition[]>;
  isAvailable(): Promise<boolean>;
  // Optional:
  listModes?(options: ListModesOptions): Promise<AgentMode[]>;
  listPersistedAgents?(options?: ListPersistedAgentsOptions): Promise<PersistedAgentDescriptor[]>;
  getDiagnostic?(): Promise<{ diagnostic: string }>;
}
```

**`AgentSession`** -- a running agent conversation:

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
  setMode(modeId: string): Promise<void>;
  getPendingPermissions(): AgentPermissionRequest[];
  respondToPermission(
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void>;
  describePersistence(): AgentPersistenceHandle | null;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  // Optional:
  listCommands?(): Promise<AgentSlashCommand[]>;
  setModel?(modelId: string | null): Promise<void>;
  setThinkingOption?(thinkingOptionId: string | null): Promise<void>;
  setFeature?(featureId: string, value: unknown): Promise<void>;
  tryHandleOutOfBand?(prompt: AgentPromptInput): {
    run(ctx: { emit: (event: AgentStreamEvent) => void }): Promise<void>;
  } | null;
}
```

### Steps

1. Create `packages/server/src/server/agent/providers/{name}-agent.ts` implementing both interfaces
2. Add to the provider manifest (same as ACP step 2 above)
3. Add factory to the registry (same as ACP step 3 above)
4. Add icon (same as ACP step 4 above)
5. Add E2E config (same as ACP step 5 above)
6. Run typecheck

---

## Testing

### Manual testing with the CLI

Start the daemon if not already running, then:

```bash
# Launch an agent with your provider
paseo run --provider my-provider

# Launch with a specific model and mode
paseo run --provider my-provider --model some-model --mode default

# List running agents
paseo ls -a -g

# Check if the provider reports models
paseo models --provider my-provider
```

### E2E test patterns

The E2E configs in `agent-configs.ts` expose two helpers:

- `getFullAccessConfig(provider)` -- returns config for a session with no permission prompts
- `getAskModeConfig(provider)` -- returns config for a session that triggers permission requests

Tests use `isProviderAvailable(provider)` to skip when the binary or credentials are missing, so CI will not fail for providers that are not installed.

---

## Gotchas

**Mode IDs can be URIs.** ACP providers like Copilot use full URIs as mode IDs (e.g., `"https://agentclientprotocol.com/protocol/session-modes#agent"`). Never assume mode IDs are simple strings. The manifest `defaultModeId` must match exactly.

**Models and modes are discovered dynamically.** ACP providers report available models and modes at runtime via the protocol. The static definitions in `provider-manifest.ts` are used for UI scaffolding (icons, color tiers) but the runtime values from the agent process are the source of truth.

**`AgentProvider` is always `string`.** The type alias is `type AgentProvider = string`. Provider IDs are validated against the manifest at runtime, not at the type level.

**Auth patterns vary.** Some providers need API keys in env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), some use OAuth tokens (`CLAUDE_CODE_OAUTH_TOKEN`), some use auth files (`~/.codex/auth.json`), and some handle auth entirely in their CLI binary (Copilot). Your `isAvailable()` method should check whatever is needed.

**The manifest mode list and the agent class mode list are separate.** The manifest in `provider-manifest.ts` includes UI metadata (`icon`, `colorTier`). The agent class defines modes without UI metadata (just `id`, `label`, `description`). Keep them in sync.

**`defaultCommand` is a tuple.** The first element is the binary name, the rest are default arguments. The base class uses this to find the executable and spawn the process.

**Runtime settings can override the command.** Users can configure custom binary paths or environment variables per provider via `ProviderRuntimeSettings`. Your factory in the registry should pass `runtimeSettings?.["your-provider"]` through to the constructor.
