import type { Options as ClaudeAgentOptions } from "@anthropic-ai/claude-agent-sdk";

export type AgentProvider = string;

export type AgentMetadata = { [key: string]: unknown };

/**
 * Stdio-based MCP server (spawns a subprocess).
 */
export interface McpStdioServerConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * HTTP-based MCP server.
 */
export interface McpHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

/**
 * SSE-based MCP server (Server-Sent Events over HTTP).
 */
export interface McpSseServerConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
}

/**
 * Canonical MCP server configuration.
 * Discriminated union by `type` field.
 * Each provider normalizes this to their expected format.
 */
export type McpServerConfig =
  | McpStdioServerConfig
  | McpHttpServerConfig
  | McpSseServerConfig;

export type AgentMode = {
  id: string;
  label: string;
  description?: string;
};

export type AgentModelDefinition = {
  provider: AgentProvider;
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  metadata?: AgentMetadata;
};

export type AgentCapabilityFlags = {
  supportsStreaming: boolean;
  supportsSessionPersistence: boolean;
  supportsDynamicModes: boolean;
  supportsMcpServers: boolean;
  supportsReasoningStream: boolean;
  supportsToolInvocations: boolean;
};

export type AgentPersistenceHandle = {
  provider: AgentProvider;
  sessionId: string;
  /** Provider specific handle (Codex thread id, Claude resume token, etc). */
  nativeHandle?: string;
  metadata?: AgentMetadata;
};

export type AgentPromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type AgentPromptInput = string | AgentPromptContentBlock[];

export type AgentRunOptions = {
  outputSchema?: unknown;
  resumeFrom?: AgentPersistenceHandle;
  maxThinkingTokens?: number;
};

export type AgentUsage = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
};

/**
 * Tool call kind categories for UI rendering hints.
 * Derived from the tool name, not sent over the wire.
 */
export type ToolCallKind = "read" | "edit" | "execute" | "search" | "other";

/**
 * Clean tool call structure.
 * - `name`: Tool identifier (e.g., "Read", "Bash", "Edit", "shell", "read_file", "apply_patch")
 * - `input`: Tool input parameters
 * - `output`: Tool result
 * - `error`: Error if tool failed
 */
export interface ToolCallTimelineItem {
  type: "tool_call";
  name: string;
  callId?: string;
  status?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
}

export type AgentTimelineItem =
  | { type: "user_message"; text: string; messageId?: string }
  | { type: "assistant_message"; text: string }
  | { type: "reasoning"; text: string }
  | ToolCallTimelineItem
  | { type: "todo"; items: { text: string; completed: boolean }[] }
  | { type: "error"; message: string };

export type AgentStreamEvent =
  | { type: "thread_started"; sessionId: string; provider: AgentProvider }
  | { type: "turn_started"; provider: AgentProvider }
  | { type: "turn_completed"; provider: AgentProvider; usage?: AgentUsage }
  | { type: "turn_failed"; provider: AgentProvider; error: string }
  | { type: "turn_canceled"; provider: AgentProvider; reason: string }
  | { type: "timeline"; item: AgentTimelineItem; provider: AgentProvider }
  | { type: "provider_event"; provider: AgentProvider; raw: unknown }
  | { type: "permission_requested"; provider: AgentProvider; request: AgentPermissionRequest }
  | {
      type: "permission_resolved";
      provider: AgentProvider;
      requestId: string;
      resolution: AgentPermissionResponse;
    }
  | {
      type: "attention_required";
      provider: AgentProvider;
      reason: "finished" | "error" | "permission";
      timestamp: string;
    };

export type AgentPermissionRequestKind = "tool" | "plan" | "mode" | "other";

export type AgentPermissionUpdate = AgentMetadata;

export type AgentPermissionRequest = {
  id: string;
  provider: AgentProvider;
  name: string;
  kind: AgentPermissionRequestKind;
  title?: string;
  description?: string;
  input?: AgentMetadata;
  suggestions?: AgentPermissionUpdate[];
  metadata?: AgentMetadata;
};

export type AgentPermissionResponse =
  | {
      behavior: "allow";
      updatedInput?: AgentMetadata;
      updatedPermissions?: AgentPermissionUpdate[];
    }
  | {
      behavior: "deny";
      message?: string;
      interrupt?: boolean;
    };

export type AgentRunResult = {
  sessionId: string;
  finalText: string;
  usage?: AgentUsage;
  timeline: AgentTimelineItem[];
  canceled?: boolean;
};

export type AgentRuntimeInfo = {
  provider: AgentProvider;
  sessionId: string | null;
  model?: string | null;
  modeId?: string | null;
  extra?: AgentMetadata;
};

/**
 * Represents a slash command available in an agent session.
 * Commands are executed by sending them as prompts with / prefix.
 */
export type AgentSlashCommand = {
  name: string;
  description: string;
  argumentHint: string;
};

/**
 * Result from executing a slash command.
 */
export type AgentCommandResult = {
  text: string;
  timeline: AgentTimelineItem[];
  usage?: AgentUsage;
};

export type ListPersistedAgentsOptions = {
  limit?: number;
};

export type PersistedAgentDescriptor = {
  provider: AgentProvider;
  sessionId: string;
  cwd: string;
  title: string | null;
  lastActivityAt: Date;
  persistence: AgentPersistenceHandle;
  timeline: AgentTimelineItem[];
};

export type AgentSessionConfig = {
  provider: AgentProvider;
  cwd: string;
  modeId?: string;
  model?: string;
  title?: string | null;
  approvalPolicy?: string;
  sandboxMode?: string;
  networkAccess?: boolean;
  webSearch?: boolean;
  reasoningEffort?: string;
  /**
   * Paseo-owned instructions injected into the first user prompt via
   * <paseo-instructions>...</paseo-instructions>.
   *
   * These MUST NOT be sent via provider system/developer instructions (those are
   * reserved for provider/session behaviors like resuming).
   */
  paseoPromptInstructions?: string;
  extra?: {
    codex?: AgentMetadata;
    claude?: Partial<ClaudeAgentOptions>;
  };
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Internal agents are hidden from listings and don't trigger notifications.
   * They are used for ephemeral system tasks like commit/PR generation.
   */
  internal?: boolean;
};

export interface AgentSession {
  readonly provider: AgentProvider;
  readonly id: string | null;
  readonly capabilities: AgentCapabilityFlags;
  run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult>;
  stream(prompt: AgentPromptInput, options?: AgentRunOptions): AsyncGenerator<AgentStreamEvent>;
  streamHistory(): AsyncGenerator<AgentStreamEvent>;
  getRuntimeInfo(): Promise<AgentRuntimeInfo>;
  getAvailableModes(): Promise<AgentMode[]>;
  getCurrentMode(): Promise<string | null>;
  setMode(modeId: string): Promise<void>;
  getPendingPermissions(): AgentPermissionRequest[];
  respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void>;
  describePersistence(): AgentPersistenceHandle | null;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  /**
   * List available slash commands for this session.
   * Commands are provider-specific - Claude supports skills and built-in commands.
   */
  listCommands?(): Promise<AgentSlashCommand[]>;
  /**
   * Execute a slash command by name.
   * The command name should NOT include the leading "/" - it will be added automatically.
   * @param commandName The command name (e.g., "help", "context")
   * @param args Optional arguments to pass to the command
   */
  executeCommand?(commandName: string, args?: string): Promise<AgentCommandResult>;
}

export interface ListModelsOptions {
  cwd?: string;
}

export interface AgentClient {
  readonly provider: AgentProvider;
  readonly capabilities: AgentCapabilityFlags;
  createSession(config: AgentSessionConfig): Promise<AgentSession>;
  resumeSession(handle: AgentPersistenceHandle, overrides?: Partial<AgentSessionConfig>): Promise<AgentSession>;
  listModels(options?: ListModelsOptions): Promise<AgentModelDefinition[]>;
  listPersistedAgents?(options?: ListPersistedAgentsOptions): Promise<PersistedAgentDescriptor[]>;
}
