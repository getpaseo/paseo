# Adding a New Provider to Paseo

This guide walks through adding a new agent provider end-to-end. There are two integration patterns, and this doc covers both.

## Two Integration Patterns

### ACP (Agent Client Protocol) -- recommended

Extend `ACPAgentClient` from `packages/server/src/server/agent/providers/acp-agent.ts`. The base class handles process spawning, stdio transport, session lifecycle, streaming, permissions, and model discovery. You provide configuration (command, modes, capabilities) and optionally override `isAvailable()` for auth checks.

The only built-in ACP provider today is `copilot` (`copilot-acp-agent.ts`). `GenericACPAgentClient` (`generic-acp-agent.ts`) is also ACP-based but is used for user-defined custom providers configured via `extends: "acp"` overrides — see [docs/custom-providers.md](custom-providers.md).

### Direct

Implement the `AgentClient` and `AgentSession` interfaces from `agent-sdk-types.ts` yourself. This gives full control but requires you to handle process management, streaming, permissions, and session persistence from scratch.

Existing direct providers: `claude` (in `providers/claude/agent.ts`), `codex` (`codex-app-server-agent.ts`), `opencode` (`opencode-agent.ts`), `pi` (`providers/pi/agent.ts`), and `omp` (a Pi-compatible built-in backed by the Pi adapter). The dev-only `mock` provider (`mock-load-test-agent.ts`) is also direct.

Pi is a process-backed provider. Paseo requires the user to have the `pi` binary installed and talks to it through `pi --mode rpc`; the server package does not embed Pi's SDK/runtime packages.

Paseo's per-agent and daemon-wide system prompts are passed to Pi with `--append-system-prompt`, so Pi keeps its default coding prompt while receiving Paseo's additional instructions.

Pi MCP support depends on the open-source `pi-mcp-adapter` extension being loaded for the agent cwd. Probe with Pi RPC `get_commands`; the adapter registers an extension command named `mcp` (often with `sourceInfo.source` containing `pi-mcp-adapter`). When Paseo injects MCP servers into Pi, write a per-agent MCP config and pass it with `--mcp-config` instead of modifying user or project MCP files. For local HTTP servers such as Paseo's own `/mcp/agents` endpoint, explicitly disable adapter OAuth (`auth: false`, `oauth: false`) in the generated config.

Pi import discovery reads Pi's persisted JSONL session files because Pi RPC does not expose a recent-session listing command. Resume and full history hydration still go through `pi --mode rpc` using the session file as `nativeHandle`.

OMP is a built-in Pi-compatible provider, disabled by default. It uses the `omp` command and imports terminal-started sessions from `~/.omp/agent/sessions` when enabled. Other Pi-compatible forks can still be custom providers that extend `pi`, override `command`, and set `params.sessionDir` to their JSONL session directory.

Pi RPC extension UI dialog requests (`select`, `input`, `editor`, `confirm`) are bridged into Paseo question permissions and answered with `extension_ui_response`. Pi extensions such as `ask_user` may chain dialogs: for example, a `select` can be followed by an optional-comment `input`. When an `ask_user` tool call declares `allowComment: true`, Paseo presents the selection and optional comment as one question permission, answers Pi's initial `select` immediately, then auto-answers the follow-up optional `input` with the comment the user already supplied (or an empty string). Preserve placeholders and optional/skip semantics for standalone optional inputs so the app can still distinguish "skip this optional input" from "cancel the whole dialog." Fire-and-forget extension UI requests such as notifications are intentionally ignored by the provider adapter unless Paseo grows first-class UI for them.

OpenCode MCP injection is dynamic and session-scoped. Call OpenCode's `mcp.add` endpoint with the MCP server config and do not follow it with `mcp.connect`; `connect` only toggles MCP servers already present in OpenCode's own config. New OpenCode versions return `McpServerNotFoundError`/404 for `connect` after a dynamic add because the server is not config-backed, while older versions silently swallowed the same missing-config path.

OpenCode owns user message IDs. Do not pass Paseo-generated IDs to OpenCode prompt APIs; let OpenCode create `msg*` IDs and record the user timeline item from the `message.updated` event.

Every provider adapter owns its canonical user-message timeline rows. When a foreground prompt is accepted, the adapter must emit exactly one `user_message` timeline item for that submitted prompt, using the same message ID it gives to or receives from the provider runtime. Optimistic client messages are UI-only and provider transcript echoes are optional; neither is allowed to be the only source of truth. If the provider later echoes the same submitted user message, dedupe by provider-visible message ID, not by text.

Draft metadata lookups should avoid creating provider sessions when the upstream provider has top-level APIs for that metadata. Prefer `AgentClient.fetchCatalog`, `listCommands`, or `listFeatures` over creating a scratch `AgentSession`; scratch sessions can show up as empty native sessions in provider import/history UIs. `fetchCatalog` is the single discovery API for models and modes — provider implementations may use one process, separate upstream calls, or static data internally, but callers outside the provider do not get separate runtime model/mode probes.

Provider session import has its own contract. The picker calls `listImportableSessions` and receives rows only: provider handle, cwd, title, prompt previews, and last activity. Import calls `importSession({ providerHandleId, cwd })` for the selected row and must not call listing again. The provider returns the resumed session, storage config, persistence handle, and hydrated timeline for that one native session; `AgentManager.importProviderSession` seeds the daemon timeline and publishes the Paseo agent only after it is ready.

## Provider Helper Processes

Provider-owned helper processes that can outlive an individual agent session must be recorded in the daemon's managed-process registry. Store provider/kind metadata, the PID, launch command/args, and process identity captured from the platform process table. Remove the record on normal exit or shutdown.

Daemon bootstrap reconciles that ledger in the background, without blocking startup: dead PIDs are deleted, PID identity mismatches are deleted without killing anything, only positively matched Paseo-owned leftovers are terminated, and a record whose process cannot be inspected is left in place for the next reconcile rather than deleted. Do not add broad process-name sweepers for provider cleanup; cleanup starts from records Paseo previously wrote.

---

## Provider Snapshot Refresh Contract

The daemon keeps provider snapshots per resolved working directory. Missing or blank cwd resolves to the user's home directory. Workspace selectors and old model/mode list requests should pass the cwd that will launch the provider so providers with project-specific models or modes are probed in the right context. Settings/provider management intentionally uses the home-directory snapshot.

Snapshot reads may probe providers only while the requested cwd scope is cold. Once an entry is warm, its `ready`, `error`, or `unavailable` state stays cached until an explicit refresh. Do not add TTL revalidation, focus-triggered refreshes, selector-open refreshes, or config-reload refreshes. Selector-open refetches may read an already-loading or stale React Query, but they must not force provider probing on their own.

Settings refresh is the user-facing "forget stale provider knowledge everywhere" action. A settings refresh clears provider snapshot caches and in-flight loads across all cwd scopes, then immediately refreshes only the home-directory snapshot with `force: true`. Workspace snapshots are re-probed lazily on the next scoped read; do not fan out a settings refresh across every known workspace.

Registry/config replacement may update visible metadata such as label, description, default mode, enabled state, and provider membership, but it must not spawn provider processes. If a provider needs to be re-probed after a config change, route that through the explicit settings refresh path.

Boundary tests should assert observable behavior: cold reads may call provider availability/model/mode discovery for that cwd; warm reads and registry replacement must not; explicit workspace refreshes affect only one cwd; settings refresh wipes all scopes but immediately refreshes only home.

---

## Provider Usage Fetchers

Provider plan usage is fetch-on-demand, not a daemon push subscription. The app calls `provider.usage.list.request` through React Query when the usage tooltip or Host Usage settings screen is shown, and the daemon returns the normalized `ProviderUsage` list directly.

To add plan usage for a provider, add `packages/server/src/services/quota-fetcher/providers/<provider>.ts` and register it in `packages/server/src/services/quota-fetcher/manifest.ts`. The provider file exports only its fetcher class; provider auth, endpoint constants, API schemas, and normalization helpers stay private in that file. A fetcher owns provider auth/API parsing and returns the generic shape:

- `providerId`, `displayName`, `status`, and optional `planLabel`
- any number of `windows` such as Session, Weekly, or Biweekly
- optional `balances` for credits, USD, requests, or tokens
- optional `details` for provider-specific rows

Keep the protocol shape provider-agnostic. Do not add provider-specific renderers for new limit windows; labels and generic bars should carry the UI. API responses should be parsed and normalized with Zod inside the fetcher, while the protocol boundary stays strict so old/new client compatibility is explicit.

Kimi Code usage follows the CLI-managed credential file at `KIMI_CODE_HOME` or `~/.kimi-code/credentials/kimi-code.json`; do not probe the legacy `~/.kimi` path as the primary source for current Kimi Code installs.

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

Add to the `allProviders` array (current built-ins are `claude`, `codex`, `copilot`, `opencode`, `pi`, `omp`):

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
  fetchCatalog(options: FetchCatalogOptions): Promise<ProviderCatalog>;
  isAvailable(): Promise<boolean>;
  // Optional:
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
  setMode(modeId: string): Promise<void | AgentProviderNotice>;
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
  setThinkingOption?(thinkingOptionId: string | null): Promise<void | AgentProviderNotice>;
  setFeature?(featureId: string, value: unknown): Promise<void>;
  tryHandleOutOfBand?(prompt: AgentPromptInput): {
    run(ctx: { emit: (event: AgentStreamEvent) => void }): Promise<void>;
  } | null;
}
```

`setMode` and `setThinkingOption` may return an `AgentProviderNotice` when the provider knows the change needs user-facing context. For example, providers that stage changes until the next turn should return an `info` notice while a turn is already running. The app renders the notice generically as a toast; provider-specific lifecycle behavior stays in the provider implementation.

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
