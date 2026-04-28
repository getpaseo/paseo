// Hubcode agent — thin wrapper over the Claude Agent SDK.
//
// Why this is a wrapper, not a from-scratch agent:
// Anthropic officially documents pointing the Claude Code CLI at custom
// gateways via ANTHROPIC_BASE_URL (see code.claude.com/docs/en/llm-gateway —
// LiteLLM/Ollama/vLLM use this exact pattern). OmniRoute already exposes
// /v1/messages with full Anthropic Messages translation, so the daemon-side
// integration is: spawn Claude Code with envs pointing at OmniRoute, retag
// events from "claude" to "hubcode" so the rest of the daemon (timeline,
// permissions, persistence, model picker) keeps treating Hubcode as its
// own provider — users see "Hubcode > combo", never "Claude".
//
// What this file does:
//   1. Fetches /api/me/hubcode-models for the user's combos + OmniRoute key.
//   2. Verifies the bundled Claude Code binary (installed by the desktop app
//      at ${userData}/claude/, see desktop/integrations/claude-code-binary.ts).
//   3. Delegates createSession/resumeSession to ClaudeAgentClient with three
//      injections:
//        - launchContext.env.ANTHROPIC_BASE_URL = bundle.baseUrl
//        - launchContext.env.ANTHROPIC_AUTH_TOKEN = bundle.apiKey
//        - launchContext.env.ANTHROPIC_MODEL = combo name
//        - config.extra.claude.pathToClaudeCodeExecutable = bundled binary
//   4. Wraps the returned ClaudeAgentSession to retag every emitted event
//      from provider:"claude" → provider:"hubcode".

import { promises as fs } from "node:fs";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentLaunchContext,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPermissionResult,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProvider,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentSlashCommand,
  AgentStreamEvent,
  ListModelsOptions,
  ListModesOptions,
  ListPersistedAgentsOptions,
  PersistedAgentDescriptor,
} from "../agent-sdk-types.js";
import { ClaudeAgentClient } from "./claude-agent.js";
import { AGENT_PROVIDER_DEFINITIONS } from "../provider-manifest.js";

const DEFAULT_AUTH_URL = process.env.HUBCODE_AUTH_SERVER_URL || "http://localhost:3002";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HubcodeModelsBundle {
  requiresUpgrade: boolean;
  planId: string;
  apiKey: string | null;
  baseUrl: string;
  combos: { comboId: string; comboName: string }[];
}

interface Logger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

interface ClientDeps {
  fetch?: FetchLike;
  logger?: Logger;
  authServerUrl?: string;
  /**
   * Inner client constructor. Tests pass a stub; production composes a real
   * ClaudeAgentClient with the same logger.
   */
  claudeClientFactory?: (logger: Logger) => ClaudeAgentClient;
}

export class HubcodeUpgradeRequiredError extends Error {
  constructor(message = "Hubcode combos are available on Pro and Enterprise plans.") {
    super(message);
    this.name = "HubcodeUpgradeRequiredError";
  }
}

export class HubcodeClaudeCodeNotInstalledError extends Error {
  constructor(message = "Hubcode requires the bundled Claude Code runtime. Install it from Settings → Providers.") {
    super(message);
    this.name = "HubcodeClaudeCodeNotInstalledError";
  }
}

// Hubcode inherits Claude's capabilities — it's the same runtime under the
// hood. We don't read CLAUDE_CAPABILITIES directly to avoid a circular import;
// the values are mirrored here and asserted to match in unit tests.
const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readTokenFromEnv(): string | null {
  return process.env.HUBCODE_SESSION_TOKEN ?? null;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Path to the bundled Claude Code binary. Set by the desktop app when it
 * spawns the daemon (see packages/desktop/src/integrations/claude-code-binary.ts).
 * When undefined we cannot run the Hubcode agent — the desktop hasn't
 * finished its first-run install, or the daemon was launched standalone
 * without the desktop wrapper.
 */
function getBundledClaudeBinary(): string | null {
  const value = process.env.HUBCODE_CLAUDE_BIN;
  return value && value.length > 0 ? value : null;
}

function getHubcodeModesFromManifest(): AgentMode[] {
  const def = AGENT_PROVIDER_DEFINITIONS.find((d) => d.id === "hubcode");
  return (def?.modes ?? []).map((m) => ({
    id: m.id,
    label: m.label,
    description: m.description,
    icon: m.icon,
    colorTier: m.colorTier,
  }));
}

// ---------------------------------------------------------------------------
// Event retag — claude → hubcode
// ---------------------------------------------------------------------------

const HUBCODE_PROVIDER: AgentProvider = "hubcode";

function retagEvent(event: AgentStreamEvent): AgentStreamEvent {
  // Every AgentStreamEvent variant carries a top-level `provider` field, so
  // a shallow override covers all shapes. Nested provider fields (e.g.
  // request.provider on permission_requested) are also normalized below to
  // keep the daemon's downstream invariants honest.
  if (event.type === "permission_requested" && event.request) {
    return {
      ...event,
      provider: HUBCODE_PROVIDER,
      request: { ...event.request, provider: HUBCODE_PROVIDER },
    };
  }
  return { ...event, provider: HUBCODE_PROVIDER };
}

function retagPermissionRequest(request: AgentPermissionRequest): AgentPermissionRequest {
  return { ...request, provider: HUBCODE_PROVIDER };
}

// ---------------------------------------------------------------------------
// AgentClient implementation
// ---------------------------------------------------------------------------

export class HubcodeAgentClient implements AgentClient {
  readonly provider: AgentProvider = HUBCODE_PROVIDER;
  readonly capabilities = CAPABILITIES;

  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;
  private readonly authServerUrl: string;
  private readonly claudeClient: ClaudeAgentClient;

  constructor(deps: ClientDeps = {}) {
    this.fetchImpl = deps.fetch ?? ((u, i) => fetch(u, i));
    this.logger = deps.logger ?? console;
    this.authServerUrl = deps.authServerUrl ?? DEFAULT_AUTH_URL;
    this.claudeClient =
      deps.claudeClientFactory?.(this.logger) ??
      // ClaudeAgentClient accepts the same logger shape; the runtime cast
      // matches what provider-registry.ts uses for the real Claude provider.
      new ClaudeAgentClient({ logger: this.logger as never });
  }

  async isAvailable(): Promise<boolean> {
    // The picker should always show Hubcode (so users discover it). We only
    // gate `available=true` on the bundled Claude Code being present so the
    // Settings → Providers card flips to "Not installed" when the desktop
    // hasn't finished provisioning. Per-user combo gating happens later via
    // listModels()/createSession().
    const bin = getBundledClaudeBinary();
    if (!bin) return false;
    return pathExists(bin);
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    const bin = getBundledClaudeBinary();
    if (!bin) {
      return {
        diagnostic:
          "HUBCODE_CLAUDE_BIN is not set. The desktop app provisions this on first launch — " +
          "open Hubcode and try again, or run the daemon under the desktop wrapper.",
      };
    }
    const exists = await pathExists(bin);
    if (!exists) {
      return {
        diagnostic: `Bundled Claude Code binary not found at ${bin}. Reinstall via Settings → Providers → Hubcode → Install.`,
      };
    }
    return {
      diagnostic: `Bundled Claude Code: ${bin}`,
    };
  }

  async listPersistedAgents(
    options?: ListPersistedAgentsOptions,
  ): Promise<PersistedAgentDescriptor[]> {
    // Hubcode sessions live alongside stand-alone Claude sessions under
    // ~/.claude/projects/ (the CLAUDE_CONFIG_DIR isolation didn't actually take
    // effect; see prepareLaunch). Delegate so listPersistedAgents always reads
    // from the same source the SDK is writing to.
    return (await this.claudeClient.listPersistedAgents?.(options)) ?? [];
  }

  async listModels(options?: ListModelsOptions): Promise<AgentModelDefinition[]> {
    const token = readTokenFromEnv();
    if (!token) return [];
    try {
      const bundle = await this.fetchBundle(token);
      if (bundle.requiresUpgrade) {
        return [
          {
            id: "__upgrade__",
            label: "Upgrade to Pro to use Hubcode",
            isDefault: false,
          } as AgentModelDefinition,
        ];
      }
      // _options.cwd is unused — combos are user-scoped, not workspace-scoped.
      void options;
      return bundle.combos.map(
        (c) =>
          ({
            id: c.comboName,
            label: c.comboName,
            isDefault: false,
          }) as AgentModelDefinition,
      );
    } catch (err) {
      this.logger.warn?.("[hubcode] listModels failed:", (err as Error).message);
      return [];
    }
  }

  async listModes(_options?: ListModesOptions): Promise<AgentMode[]> {
    return getHubcodeModesFromManifest();
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const { decoratedConfig, decoratedLaunchContext, comboName } = await this.prepareLaunch(
      config,
      launchContext,
    );
    const inner = await this.claudeClient.createSession(decoratedConfig, decoratedLaunchContext);
    this.logger.info?.(
      `[hubcode] session started combo=${comboName} via bundled Claude Code at ${decoratedLaunchContext.env?.HUBCODE_CLAUDE_BIN}`,
    );
    return new HubcodeAgentSession(inner);
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    // Persisted state lives inside Claude's session store. We still need a
    // valid bundle (auth + base URL) for the resumed turns to reach OmniRoute,
    // and we need to know which combo to bill against.
    const config: AgentSessionConfig = {
      ...(overrides as AgentSessionConfig),
      provider: HUBCODE_PROVIDER,
    };
    const { decoratedConfig, decoratedLaunchContext } = await this.prepareLaunch(
      config,
      launchContext,
      { isResume: true },
    );
    const inner = await this.claudeClient.resumeSession(handle, decoratedConfig, decoratedLaunchContext);
    return new HubcodeAgentSession(inner);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async prepareLaunch(
    config: AgentSessionConfig,
    launchContext: AgentLaunchContext | undefined,
    opts: { isResume?: boolean } = {},
  ): Promise<{
    decoratedConfig: AgentSessionConfig;
    decoratedLaunchContext: AgentLaunchContext;
    comboName: string;
  }> {
    const token =
      launchContext?.env?.HUBCODE_SESSION_TOKEN ?? readTokenFromEnv();
    if (!token) {
      throw new Error("Missing Hubcode session token — sign in before selecting a Hubcode combo.");
    }

    const bundledBinary = getBundledClaudeBinary();
    if (!bundledBinary || !(await pathExists(bundledBinary))) {
      throw new HubcodeClaudeCodeNotInstalledError();
    }

    const overrideAuthUrl = launchContext?.env?.HUBCODE_AUTH_SERVER_URL;
    const bundle = await this.fetchBundle(token, overrideAuthUrl);

    if (bundle.requiresUpgrade && !opts.isResume) {
      throw new HubcodeUpgradeRequiredError();
    }
    if (bundle.requiresUpgrade) {
      // Resume: keep going so already-working sessions don't crash on a
      // transient billing-table race; OmniRoute will return a real auth
      // error if the key is actually revoked.
      this.logger.warn?.(
        "[hubcode] resumeSession got requiresUpgrade=true; continuing with persisted state.",
      );
    }
    if (!bundle.apiKey) {
      throw new Error("Hubcode account is missing an API key — try signing in again.");
    }

    const comboName =
      config.model ??
      bundle.combos[0]?.comboName ??
      (() => {
        throw new Error("No Hubcode combo available for this plan.");
      })();

    // Strip trailing /v1 if present — Claude Code appends "/v1/messages" itself.
    const base = bundle.baseUrl.replace(/\/v1\/?$/, "");

    const env: Record<string, string> = {
      ...(launchContext?.env ?? {}),
      ANTHROPIC_BASE_URL: base,
      ANTHROPIC_AUTH_TOKEN: bundle.apiKey,
      ANTHROPIC_MODEL: comboName,
      // Don't ship usage data back to Anthropic — this is OmniRoute traffic.
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      // Surface the binary path inside the spawn for diagnostics/logging.
      HUBCODE_CLAUDE_BIN: bundledBinary,
    };

    // Note: we intentionally do NOT override CLAUDE_CONFIG_DIR. Empirically the
    // bundled CLI didn't honor the override and sessions landed in ~/.claude/
    // anyway, so isolation was a fiction that broke history sync (the daemon
    // looked for JSONLs under HUBCODE_CLAUDE_HOME/projects/ where nothing
    // existed). Aligning with the stand-alone Claude provider — both read/write
    // ~/.claude/projects/ — gives Hubcode agents the same listPersistedAgents
    // and resumeSession behavior for free. ANTHROPIC_AUTH_TOKEN above already
    // pre-empts any credential picked up from ~/.claude/.credentials.json.

    const decoratedConfig: AgentSessionConfig = {
      ...config,
      provider: "claude",
      // Tell the SDK exactly which binary to run. Without this, the Claude
      // provider falls back to findExecutable("claude") which would resolve
      // the user's personal install — wrong tenant of credentials.
      extra: {
        ...config.extra,
        claude: {
          ...(config.extra?.claude ?? {}),
          pathToClaudeCodeExecutable: bundledBinary,
        },
      },
    };

    const decoratedLaunchContext: AgentLaunchContext = {
      ...launchContext,
      env,
    };

    return { decoratedConfig, decoratedLaunchContext, comboName };
  }

  private async fetchBundle(
    token: string,
    authServerUrlOverride?: string | null,
  ): Promise<HubcodeModelsBundle> {
    const url = `${authServerUrlOverride || this.authServerUrl}/api/me/hubcode-models`;
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`hubcode auth ${res.status}: ${await safeText(res)}`);
    }
    return (await res.json()) as HubcodeModelsBundle;
  }
}

// ---------------------------------------------------------------------------
// AgentSession wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps a ClaudeAgentSession and rewrites every emitted event so the rest of
 * the daemon (timeline projector, persistence layer, model picker, etc.)
 * sees `provider: "hubcode"`. All other behavior — turn handling, mode
 * switching, permissions, persistence handles — is delegated unchanged.
 */
export class HubcodeAgentSession implements AgentSession {
  readonly provider: AgentProvider = HUBCODE_PROVIDER;
  readonly capabilities = CAPABILITIES;

  constructor(private readonly inner: AgentSession) {}

  get id(): string | null {
    return this.inner.id;
  }

  get features() {
    return this.inner.features;
  }

  run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return this.inner.run(prompt, options);
  }

  startTurn(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<{ turnId: string }> {
    return this.inner.startTurn(prompt, options);
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    return this.inner.subscribe((event) => callback(retagEvent(event)));
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    for await (const event of this.inner.streamHistory()) {
      yield retagEvent(event);
    }
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    const info = await this.inner.getRuntimeInfo();
    return { ...info, provider: HUBCODE_PROVIDER };
  }

  getAvailableModes(): Promise<AgentMode[]> {
    // Claude and Hubcode share the same mode set today (default/acceptEdits/
    // plan/bypassPermissions). If they ever diverge we'd remap here.
    return this.inner.getAvailableModes();
  }

  getCurrentMode(): Promise<string | null> {
    return this.inner.getCurrentMode();
  }

  setMode(modeId: string): Promise<void> {
    return this.inner.setMode(modeId);
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return this.inner.getPendingPermissions().map(retagPermissionRequest);
  }

  respondToPermission(
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void> {
    return this.inner.respondToPermission(requestId, response);
  }

  describePersistence(): AgentPersistenceHandle | null {
    const handle = this.inner.describePersistence();
    if (!handle) return null;
    return { ...handle, provider: HUBCODE_PROVIDER };
  }

  interrupt(): Promise<void> {
    return this.inner.interrupt();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  listCommands(): Promise<AgentSlashCommand[]> {
    return this.inner.listCommands?.() ?? Promise.resolve([]);
  }

  setModel(modelId: string | null): Promise<void> {
    // Switching combos mid-session: we surface the new combo name to the SDK
    // via setModel so the next turn sends `model: <combo>` upstream. The
    // ANTHROPIC_MODEL env was only the initial default.
    return this.inner.setModel?.(modelId) ?? Promise.resolve();
  }

  setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    return this.inner.setThinkingOption?.(thinkingOptionId) ?? Promise.resolve();
  }

  setFeature(featureId: string, value: unknown): Promise<void> {
    return this.inner.setFeature?.(featureId, value) ?? Promise.resolve();
  }
}
