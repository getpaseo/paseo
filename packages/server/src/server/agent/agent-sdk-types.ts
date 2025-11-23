import type { ThreadEvent as CodexThreadEvent } from "@openai/codex-sdk";
import type {
  Options as ClaudeAgentOptions,
  SDKMessage as ClaudeStreamMessage,
} from "@anthropic-ai/claude-agent-sdk";

export type AgentProvider = "codex" | "claude";

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
  metadata?: Record<string, unknown>;
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
  metadata?: Record<string, unknown>;
};

export type AgentPromptInput = string | { type: "text"; text: string }[];

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

export type AgentTimelineItem =
  | { type: "user_message"; text: string; messageId?: string; raw?: unknown }
  | { type: "assistant_message"; text: string; raw?: unknown }
  | { type: "reasoning"; text: string; raw?: unknown }
  | {
      type: "tool_call";
      server: string;
      tool: string;
      status?: string;
      callId?: string;
      displayName?: string;
      kind?: string;
      input?: unknown;
      output?: unknown;
      error?: unknown;
      raw?: unknown;
    }
  | { type: "todo"; items: { text: string; completed: boolean }[]; raw?: unknown }
  | { type: "error"; message: string; raw?: unknown };

export type AgentStreamEvent =
  | { type: "thread_started"; sessionId: string; provider: AgentProvider }
  | { type: "turn_started"; provider: AgentProvider }
  | { type: "turn_completed"; provider: AgentProvider; usage?: AgentUsage }
  | { type: "turn_failed"; provider: AgentProvider; error: string }
  | { type: "timeline"; item: AgentTimelineItem; provider: AgentProvider }
  | { type: "provider_event"; provider: AgentProvider; raw: CodexThreadEvent | ClaudeStreamMessage }
  | { type: "permission_requested"; provider: AgentProvider; request: AgentPermissionRequest }
  | {
      type: "permission_resolved";
      provider: AgentProvider;
      requestId: string;
      resolution: AgentPermissionResponse;
    };

export type AgentPermissionRequestKind = "tool" | "plan" | "mode" | "other";

export type AgentPermissionUpdate = Record<string, unknown>;

export type AgentPermissionRequest = {
  id: string;
  provider: AgentProvider;
  name: string;
  kind: AgentPermissionRequestKind;
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  suggestions?: AgentPermissionUpdate[];
  metadata?: Record<string, unknown>;
  raw?: unknown;
};

export type AgentPermissionResponse =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
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
  approvalPolicy?: string;
  sandboxMode?: string;
  networkAccess?: boolean;
  webSearch?: boolean;
  reasoningEffort?: string;
  extra?: {
    codex?: Record<string, unknown>;
    claude?: Partial<ClaudeAgentOptions>;
  };
  mcpServers?: Record<string, unknown>;
};

export interface AgentSession {
  readonly provider: AgentProvider;
  readonly id: string | null;
  readonly capabilities: AgentCapabilityFlags;
  run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult>;
  stream(prompt: AgentPromptInput, options?: AgentRunOptions): AsyncGenerator<AgentStreamEvent>;
  streamHistory(): AsyncGenerator<AgentStreamEvent>;
  getAvailableModes(): Promise<AgentMode[]>;
  getCurrentMode(): Promise<string | null>;
  setMode(modeId: string): Promise<void>;
  getPendingPermissions(): AgentPermissionRequest[];
  respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void>;
  describePersistence(): AgentPersistenceHandle | null;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface AgentClient {
  readonly provider: AgentProvider;
  readonly capabilities: AgentCapabilityFlags;
  createSession(config: AgentSessionConfig): Promise<AgentSession>;
  resumeSession(handle: AgentPersistenceHandle, overrides?: Partial<AgentSessionConfig>): Promise<AgentSession>;
  listPersistedAgents?(options?: ListPersistedAgentsOptions): Promise<PersistedAgentDescriptor[]>;
}
