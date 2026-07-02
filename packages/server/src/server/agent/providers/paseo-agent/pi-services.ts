import {
  AuthStorage,
  type AgentSession as PiAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type { BeforeToolCallResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, OAuthProviderInterface, TextContent } from "@earendil-works/pi-ai";
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { evaluateToolPermission, type ToolPermissionPolicy } from "./agent-permissions.js";
import type { PaseoComposedPrompt } from "./prompt-profiles.js";

// Re-export the Pi tool contract so the MCP bridge can build custom tools without
// importing the Pi SDK type names itself.
export type { ToolDefinition };

/** Shape a Pi custom tool's `execute` must return (subset of Pi's AgentToolResult). */
export interface AgentToolResultLike {
  content: (TextContent | ImageContent)[];
  details: unknown;
  terminate?: boolean;
}

// The single seam between Paseo and Pi's in-process harness. Every `@earendil-works/*`
// import and all no-discovery service construction lives here so the rest of the
// Paseo Agent provider never touches Pi's disk-backed config, auth, or sessions.

// ProviderConfigInput is not re-exported from the package index, so derive it from
// the public `registerProvider` signature.
export type PiProviderConfig = Parameters<ModelRegistry["registerProvider"]>[1];
type PiAuthData = Parameters<typeof AuthStorage.inMemory>[0];
type PiSettings = Parameters<typeof SettingsManager.inMemory>[0];

export interface PaseoAgentOAuth {
  flow: string;
  refreshToken?: string;
}

export interface PaseoAgentModelProvider {
  /** Instance name, e.g. "openrouter-main". Used as the Pi provider key. */
  name: string;
  /** Typed Pi provider config: baseUrl, apiKey, models, api, etc. */
  config: PiProviderConfig;
  /** When present, register an OAuth provider and seed an in-memory credential. */
  oauth?: PaseoAgentOAuth;
}

export interface PaseoAgentModelReference {
  provider: string;
  id: string;
}

export interface CreatePaseoAgentSessionOptions {
  /** Working directory for the agent. */
  cwd: string;
  /**
   * Isolated, Paseo-owned global config directory. Never `~/.pi`. Used only to
   * satisfy Pi's path math; all services below are in-memory so nothing is read
   * from or written to it during creation.
   */
  agentDir: string;
  /** Model providers (model backends) registered entirely in memory. */
  modelProviders: PaseoAgentModelProvider[];
  /** Explicit model selection. When omitted, Pi falls back to its own resolution. */
  model?: PaseoAgentModelReference;
  thinkingLevel?: ThinkingLevel;
  /** In-memory credential seed, if any provider auth is keyed by AuthStorage. */
  auth?: PiAuthData;
  /**
   * Pi AuthStorage to use. Defaults to a fresh in-memory store. The Paseo Agent
   * provider passes a file-backed, Paseo-owned store for OAuth providers so Pi can
   * refresh tokens and persist rotation. Any oauth markers carrying a refresh token
   * are still seeded into whichever store is used.
   */
  authStorage?: AuthStorage;
  /** In-memory settings overrides. Empty by default. */
  settings?: PiSettings;
  /** Paseo-bridged tools (e.g. MCP) to register alongside built-in tools. */
  customTools?: ToolDefinition[];
  /** Optional allowlist of active Pi tool names for this agent definition. */
  tools?: string[];
  /** Runtime allow/deny policy for every Pi tool call. */
  permissionPolicy?: ToolPermissionPolicy;
  /** Paseo-composed agent/session/daemon instructions. */
  composedPrompt?: PaseoComposedPrompt;
}

export interface PaseoAgentSessionHandle {
  session: PiAgentSession;
  modelRegistry: ModelRegistry;
  resourceLoader: ResourceLoader;
  sessionManager: SessionManager;
}

/**
 * Build a fully Paseo-controlled Pi `ResourceLoader` that performs no discovery.
 *
 * Discovery only happens inside `reload()`; the constructor initialises valid empty
 * state. We never call `reload()`, and the `no*` flags ensure that even an accidental
 * reload would not scan `~/.pi`, the project, or the cwd.
 */
function createNoDiscoveryResourceLoader(options: {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  composedPrompt?: PaseoComposedPrompt;
}): ResourceLoader {
  const base = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: options.settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  return options.composedPrompt ? wrapPromptResourceLoader(base, options.composedPrompt) : base;
}

function wrapPromptResourceLoader(
  delegate: ResourceLoader,
  composedPrompt: PaseoComposedPrompt,
): ResourceLoader {
  return {
    getExtensions: () => delegate.getExtensions(),
    getSkills: () => delegate.getSkills(),
    getPrompts: () => delegate.getPrompts(),
    getThemes: () => delegate.getThemes(),
    getAgentsFiles: () => delegate.getAgentsFiles(),
    getSystemPrompt: () => composedPrompt.customPrompt ?? delegate.getSystemPrompt(),
    getAppendSystemPrompt: () => [
      ...delegate.getAppendSystemPrompt(),
      ...composedPrompt.appendSystemPrompt,
    ],
    extendResources: (paths) => delegate.extendResources(paths),
    reload: () => delegate.reload(),
  };
}

function installPermissionPolicy(
  session: PiAgentSession,
  permissionPolicy: ToolPermissionPolicy | undefined,
): void {
  if (!permissionPolicy || permissionPolicy.rules.length === 0) {
    return;
  }

  const previousBeforeToolCall = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (
    context,
    signal,
  ): Promise<BeforeToolCallResult | undefined> => {
    const toolName = context.toolCall.name;
    if (evaluateToolPermission(permissionPolicy, toolName) === "deny") {
      return {
        block: true,
        reason: `Paseo Agent denied tool "${toolName}" by agent permissions.`,
      };
    }
    return previousBeforeToolCall?.(context, signal);
  };
}

function resolveOAuthProvider(flow: string): OAuthProviderInterface {
  const provider = getOAuthProvider(flow);
  if (!provider) {
    throw new Error(`Paseo Agent: OAuth flow "${flow}" is not registered by Pi.`);
  }
  return provider;
}

/**
 * Create a Pi agent session through the high-level `createAgentSession` API with
 * every service supplied in-memory and no Pi config discovery.
 */
export async function createPaseoAgentSession(
  options: CreatePaseoAgentSessionOptions,
): Promise<PaseoAgentSessionHandle> {
  // Use the caller's Paseo-owned store when provided (so Pi refreshes + persists token
  // rotation there), else a fresh in-memory store.
  const authStorage = options.authStorage ?? AuthStorage.inMemory({ ...options.auth });

  // Seed any oauth marker that carries a refresh token (the advanced/manual override).
  // The product path leaves this empty — the credential is already in the Paseo store.
  // Empty `access` + `expires: 0` forces a refresh on the first request.
  for (const provider of options.modelProviders) {
    if (provider.oauth?.refreshToken) {
      authStorage.set(provider.name, {
        type: "oauth",
        access: "",
        refresh: provider.oauth.refreshToken,
        expires: 0,
      });
    }
  }

  const modelRegistry = ModelRegistry.inMemory(authStorage);

  for (const provider of options.modelProviders) {
    const config = provider.oauth
      ? { ...provider.config, oauth: resolveOAuthProvider(provider.oauth.flow) }
      : provider.config;
    modelRegistry.registerProvider(provider.name, config);
  }

  const settingsManager = SettingsManager.inMemory(options.settings ?? {});
  const sessionManager = SessionManager.inMemory(options.cwd);
  const resourceLoader = createNoDiscoveryResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    composedPrompt: options.composedPrompt,
  });

  const model = options.model
    ? modelRegistry.find(options.model.provider, options.model.id)
    : undefined;
  if (options.model && !model) {
    throw new Error(
      `Paseo Agent: model ${options.model.provider}/${options.model.id} is not registered by any model provider`,
    );
  }

  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    authStorage,
    modelRegistry,
    settingsManager,
    sessionManager,
    resourceLoader,
    ...(model ? { model } : {}),
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    ...(options.customTools ? { customTools: options.customTools } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
  });

  // Custom (MCP) tools are registered but not active by default — only the built-in
  // tool set is. Activate them unless an agent definition supplied an explicit tool allowlist.
  if (!options.tools && options.customTools && options.customTools.length > 0) {
    const customToolNames = options.customTools.map((tool) => tool.name);
    session.setActiveToolsByName([...session.getActiveToolNames(), ...customToolNames]);
  }

  installPermissionPolicy(session, options.permissionPolicy);

  return { session, modelRegistry, resourceLoader, sessionManager };
}
