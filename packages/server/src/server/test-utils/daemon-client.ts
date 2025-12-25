import WebSocket from "ws";
import { nanoid } from "nanoid";
import type {
  SessionInboundMessage,
  SessionOutboundMessage,
  AgentSnapshotPayload,
  AgentStreamEventPayload,
  PersistedAgentDescriptorPayload,
} from "../messages.js";
import type {
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentProvider,
} from "../agent/agent-sdk-types.js";

// ============================================================================
// Configuration
// ============================================================================

export interface DaemonClientConfig {
  url: string;
  authHeader?: string;
}

export interface CreateAgentOptions {
  provider: AgentProvider;
  cwd: string;
  title?: string;
  model?: string;
  modeId?: string;
  initialPrompt?: string;
  mcpServers?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface SendMessageOptions {
  messageId?: string;
  images?: Array<{ data: string; mimeType: string }>;
}

// ============================================================================
// Event Types
// ============================================================================

export type DaemonEvent =
  | { type: "agent_state"; agentId: string; payload: AgentSnapshotPayload }
  | {
      type: "agent_stream";
      agentId: string;
      event: AgentStreamEventPayload;
      timestamp: string;
    }
  | { type: "session_state"; agents: AgentSnapshotPayload[] }
  | { type: "status"; payload: { status: string } }
  | { type: "agent_deleted"; agentId: string }
  | { type: "agent_permission_request"; agentId: string; request: AgentPermissionRequest }
  | {
      type: "agent_permission_resolved";
      agentId: string;
      requestId: string;
      resolution: AgentPermissionResponse;
    }
  | { type: "error"; message: string };

export type DaemonEventHandler = (event: DaemonEvent) => void;

// ============================================================================
// DaemonClient
// ============================================================================

export class DaemonClient {
  private ws: WebSocket | null = null;
  private messageQueue: SessionOutboundMessage[] = [];
  private eventListeners: Set<DaemonEventHandler> = new Set();
  private messageListeners: Set<() => void> = new Set();

  constructor(private config: DaemonClientConfig) {}

  // ============================================================================
  // Connection
  // ============================================================================

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (this.config.authHeader) {
        headers["Authorization"] = this.config.authHeader;
      }

      this.ws = new WebSocket(this.config.url, { headers });

      const onOpen = (): void => {
        cleanup();
        resolve();
      };

      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };

      const onMessage = (data: WebSocket.RawData): void => {
        try {
          const parsed = JSON.parse(data.toString()) as {
            type: string;
            message?: SessionOutboundMessage;
          };
          if (parsed.type === "pong") return;
          if (parsed.type === "session" && parsed.message) {
            this.handleSessionMessage(parsed.message);
          }
        } catch {
          // Ignore parse errors
        }
      };

      const cleanup = (): void => {
        this.ws?.off("open", onOpen);
        this.ws?.off("error", onError);
      };

      this.ws.on("open", onOpen);
      this.ws.on("error", onError);
      this.ws.on("message", onMessage);
    });
  }

  async close(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.messageQueue = [];
    this.eventListeners.clear();
    this.messageListeners.clear();
  }

  // ============================================================================
  // Agent Lifecycle
  // ============================================================================

  async createAgent(options: CreateAgentOptions): Promise<AgentSnapshotPayload> {
    const requestId = nanoid();

    // Record the current queue position so we only check NEW messages
    const startPosition = this.messageQueue.length;

    this.send({
      type: "create_agent_request",
      requestId,
      config: {
        provider: options.provider,
        cwd: options.cwd,
        title: options.title,
        model: options.model,
        modeId: options.modeId,
        mcpServers: options.mcpServers,
        extra: options.extra,
      },
      initialPrompt: options.initialPrompt,
    });

    // First get the agent ID from the initial state (only check new messages)
    let agentId: string | null = null;
    await this.waitFor(
      (msg) => {
        if (msg.type === "agent_state") {
          agentId = msg.payload.id;
          return msg.payload;
        }
        return null;
      },
      10000,
      { skipQueueBefore: startPosition }
    );

    if (!agentId) {
      throw new Error("Failed to get agent ID from create response");
    }

    // Wait for the agent to be idle (only check new messages from startPosition)
    return this.waitFor(
      (msg) => {
        if (
          msg.type === "agent_state" &&
          msg.payload.id === agentId &&
          msg.payload.status === "idle"
        ) {
          return msg.payload;
        }
        return null;
      },
      60000,
      { skipQueueBefore: startPosition }
    ); // 60 second timeout for initialization
  }

  async deleteAgent(agentId: string): Promise<void> {
    this.send({ type: "delete_agent_request", agentId });
    await this.waitFor((msg) => {
      if (msg.type === "agent_deleted" && msg.payload.agentId === agentId) {
        return true;
      }
      return null;
    });
  }

  /**
   * Returns the current list of agents by analyzing the message queue.
   * This computes the latest state by:
   * 1. Starting with agents from session_state (if any)
   * 2. Updating with agent_state messages
   * 3. Removing agents that have agent_deleted events
   */
  listAgents(): AgentSnapshotPayload[] {
    const agentMap = new Map<string, AgentSnapshotPayload>();
    const deletedAgents = new Set<string>();

    for (const msg of this.messageQueue) {
      if (msg.type === "session_state") {
        // Initial agents from session state
        for (const agent of msg.payload.agents) {
          agentMap.set(agent.id, agent);
        }
      } else if (msg.type === "agent_state") {
        // Update or add agent from state event
        agentMap.set(msg.payload.id, msg.payload);
      } else if (msg.type === "agent_deleted") {
        // Mark agent as deleted
        deletedAgents.add(msg.payload.agentId);
      }
    }

    // Filter out deleted agents and return
    return Array.from(agentMap.values()).filter(
      (agent) => !deletedAgents.has(agent.id)
    );
  }

  async listPersistedAgents(): Promise<PersistedAgentDescriptorPayload[]> {
    this.send({ type: "list_persisted_agents_request" });
    return this.waitFor((msg) => {
      if (msg.type === "list_persisted_agents_response") {
        return msg.payload.items;
      }
      return null;
    });
  }

  async resumeAgent(
    handle: AgentPersistenceHandle,
    overrides?: Partial<CreateAgentOptions>
  ): Promise<AgentSnapshotPayload> {
    const requestId = nanoid();

    // Record the current queue position so we only check NEW messages
    const startPosition = this.messageQueue.length;

    this.send({
      type: "resume_agent_request",
      requestId,
      handle,
      overrides: overrides as Record<string, unknown>,
    });

    // First get the agent ID from a NEW state message (not old cached ones)
    let agentId: string | null = null;
    await this.waitFor(
      (msg) => {
        if (msg.type === "agent_state") {
          agentId = msg.payload.id;
          return msg.payload;
        }
        return null;
      },
      10000,
      { skipQueueBefore: startPosition }
    );

    if (!agentId) {
      throw new Error("Failed to get agent ID from resume response");
    }

    // Wait for the new agent to be idle (like createAgent does)
    return this.waitFor(
      (msg) => {
        if (
          msg.type === "agent_state" &&
          msg.payload.id === agentId &&
          msg.payload.status === "idle"
        ) {
          return msg.payload;
        }
        return null;
      },
      60000,
      { skipQueueBefore: startPosition }
    ); // 60 second timeout for initialization
  }

  /**
   * Initialize an agent (fetch its current state without running a prompt).
   * This mimics what happens when clicking on an agent in the UI.
   */
  async initializeAgent(agentId: string): Promise<AgentSnapshotPayload> {
    const requestId = nanoid();
    const startPosition = this.messageQueue.length;

    this.send({
      type: "initialize_agent_request",
      agentId,
      requestId,
    });

    // Wait for agent_state with this agent's ID
    return this.waitFor(
      (msg) => {
        if (msg.type === "agent_state" && msg.payload.id === agentId) {
          return msg.payload;
        }
        return null;
      },
      10000,
      { skipQueueBefore: startPosition }
    );
  }

  /**
   * Clear agent attention (mark as viewed).
   * This is what happens when opening an agent that requires attention.
   */
  async clearAgentAttention(agentId: string): Promise<void> {
    this.send({
      type: "clear_agent_attention",
      agentId,
    });
  }

  // ============================================================================
  // Agent Interaction
  // ============================================================================

  async sendMessage(
    agentId: string,
    text: string,
    options?: SendMessageOptions
  ): Promise<void> {
    this.send({
      type: "send_agent_message",
      agentId,
      text,
      messageId: options?.messageId,
      images: options?.images,
    });
  }

  async cancelAgent(agentId: string): Promise<void> {
    this.send({ type: "cancel_agent_request", agentId });
  }

  async setAgentMode(agentId: string, modeId: string): Promise<void> {
    this.send({ type: "set_agent_mode", agentId, modeId });
  }

  // ============================================================================
  // Git Operations
  // ============================================================================

  async getGitDiff(
    agentId: string
  ): Promise<{ diff: string; error: string | null }> {
    const startPosition = this.messageQueue.length;

    this.send({ type: "git_diff_request", agentId });

    return this.waitFor(
      (msg) => {
        if (
          msg.type === "git_diff_response" &&
          msg.payload.agentId === agentId
        ) {
          return { diff: msg.payload.diff, error: msg.payload.error };
        }
        return null;
      },
      10000,
      { skipQueueBefore: startPosition }
    );
  }

  async getGitRepoInfo(agentId: string): Promise<{
    repoRoot: string;
    currentBranch: string | null;
    branches: Array<{ name: string; isCurrent: boolean }>;
    isDirty: boolean;
    error: string | null;
  }> {
    // Get the agent's cwd from the current list
    const agents = this.listAgents();
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) {
      return {
        repoRoot: "",
        currentBranch: null,
        branches: [],
        isDirty: false,
        error: `Agent not found: ${agentId}`,
      };
    }

    const cwd = agent.cwd;
    const startPosition = this.messageQueue.length;

    this.send({ type: "git_repo_info_request", cwd });

    return this.waitFor(
      (msg) => {
        if (msg.type === "git_repo_info_response" && msg.payload.cwd === cwd) {
          return {
            repoRoot: msg.payload.repoRoot,
            currentBranch: msg.payload.currentBranch ?? null,
            branches: msg.payload.branches ?? [],
            isDirty: msg.payload.isDirty ?? false,
            error: msg.payload.error ?? null,
          };
        }
        return null;
      },
      10000,
      { skipQueueBefore: startPosition }
    );
  }

  // ============================================================================
  // File Explorer
  // ============================================================================

  async exploreFileSystem(
    agentId: string,
    path: string,
    mode: "list" | "file" = "list"
  ): Promise<{
    path: string;
    mode: "list" | "file";
    directory: {
      path: string;
      entries: Array<{
        name: string;
        path: string;
        kind: "file" | "directory";
        size: number;
        modifiedAt: string;
      }>;
    } | null;
    file: {
      path: string;
      kind: "text" | "image" | "binary";
      encoding: "utf-8" | "base64" | "none";
      content?: string;
      mimeType?: string;
      size: number;
      modifiedAt: string;
    } | null;
    error: string | null;
  }> {
    const startPosition = this.messageQueue.length;

    this.send({ type: "file_explorer_request", agentId, path, mode });

    return this.waitFor(
      (msg) => {
        if (
          msg.type === "file_explorer_response" &&
          msg.payload.agentId === agentId
        ) {
          return {
            path: msg.payload.path,
            mode: msg.payload.mode,
            directory: msg.payload.directory,
            file: msg.payload.file,
            error: msg.payload.error,
          };
        }
        return null;
      },
      10000,
      { skipQueueBefore: startPosition }
    );
  }

  // ============================================================================
  // Provider Models
  // ============================================================================

  async listProviderModels(
    provider: AgentProvider,
    options?: { cwd?: string }
  ): Promise<{
    provider: AgentProvider;
    models: AgentModelDefinition[];
    fetchedAt: string;
    error: string | null;
  }> {
    const startPosition = this.messageQueue.length;

    this.send({
      type: "list_provider_models_request",
      provider,
      cwd: options?.cwd,
    });

    return this.waitFor(
      (msg) => {
        if (
          msg.type === "list_provider_models_response" &&
          msg.payload.provider === provider
        ) {
          return {
            provider: msg.payload.provider,
            models: msg.payload.models ?? [],
            fetchedAt: msg.payload.fetchedAt,
            error: msg.payload.error ?? null,
          };
        }
        return null;
      },
      30000,
      { skipQueueBefore: startPosition }
    );
  }

  // ============================================================================
  // Permissions
  // ============================================================================

  async respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse
  ): Promise<void> {
    this.send({
      type: "agent_permission_response",
      agentId,
      requestId,
      response,
    });
  }

  // ============================================================================
  // Waiting / Streaming
  // ============================================================================

  async waitForAgentIdle(
    agentId: string,
    timeout = 60000
  ): Promise<AgentSnapshotPayload> {
    // Record the current queue position so we only check messages from NOW
    const startPosition = this.messageQueue.length;

    // First, wait for the agent to go to "running" state (or already be running)
    // This ensures we don't return on an old "idle" state from before the message
    let sawRunning = false;

    return this.waitFor(
      (msg) => {
        if (msg.type === "agent_state" && msg.payload.id === agentId) {
          const status = msg.payload.status;
          if (status === "running") {
            sawRunning = true;
          }
          // Only return idle/error AFTER we've seen running
          if (sawRunning && (status === "idle" || status === "error")) {
            return msg.payload;
          }
        }
        return null;
      },
      timeout,
      { skipQueueBefore: startPosition }
    );
  }

  async waitForPermission(
    agentId: string,
    timeout = 30000
  ): Promise<AgentPermissionRequest> {
    return this.waitFor((msg) => {
      // Check direct permission request message
      if (
        msg.type === "agent_permission_request" &&
        msg.payload.agentId === agentId
      ) {
        return msg.payload.request;
      }
      // Check stream event
      if (msg.type === "agent_stream" && msg.payload.agentId === agentId) {
        if (msg.payload.event.type === "permission_requested") {
          return msg.payload.event.request;
        }
      }
      return null;
    }, timeout);
  }

  // ============================================================================
  // Event Subscription
  // ============================================================================

  on(handler: DaemonEventHandler): () => void {
    this.eventListeners.add(handler);
    return () => this.eventListeners.delete(handler);
  }

  // ============================================================================
  // Internals
  // ============================================================================

  private send(message: SessionInboundMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    this.ws.send(JSON.stringify({ type: "session", message }));
  }

  private handleSessionMessage(msg: SessionOutboundMessage): void {
    this.messageQueue.push(msg);

    // Notify message listeners (for waitFor) - just signal, they'll check the queue
    for (const listener of this.messageListeners) {
      listener();
    }

    // Notify event listeners
    const event = this.toEvent(msg);
    if (event) {
      for (const handler of this.eventListeners) {
        handler(event);
      }
    }
  }

  private toEvent(msg: SessionOutboundMessage): DaemonEvent | null {
    switch (msg.type) {
      case "agent_state":
        return {
          type: "agent_state",
          agentId: msg.payload.id,
          payload: msg.payload,
        };
      case "agent_stream":
        return {
          type: "agent_stream",
          agentId: msg.payload.agentId,
          event: msg.payload.event,
          timestamp: msg.payload.timestamp,
        };
      case "session_state":
        return { type: "session_state", agents: msg.payload.agents };
      case "status":
        return { type: "status", payload: msg.payload };
      case "agent_deleted":
        return { type: "agent_deleted", agentId: msg.payload.agentId };
      case "agent_permission_request":
        return {
          type: "agent_permission_request",
          agentId: msg.payload.agentId,
          request: msg.payload.request,
        };
      case "agent_permission_resolved":
        return {
          type: "agent_permission_resolved",
          agentId: msg.payload.agentId,
          requestId: msg.payload.requestId,
          resolution: msg.payload.resolution,
        };
      default:
        return null;
    }
  }

  private async waitFor<T>(
    predicate: (msg: SessionOutboundMessage) => T | null,
    timeout = 30000,
    options?: { skipQueue?: boolean; skipQueueBefore?: number }
  ): Promise<T> {
    // Record the starting queue length so we can track new messages
    const startQueueLength = options?.skipQueueBefore ?? this.messageQueue.length;

    // Check queued messages first (unless skipped or with position offset)
    if (!options?.skipQueue && options?.skipQueueBefore === undefined) {
      for (const msg of this.messageQueue) {
        const result = predicate(msg);
        if (result !== null) return result;
      }
    }

    // Wait for new messages only
    return new Promise((resolve, reject) => {
      // Track which messages we've already checked
      let checkedCount = startQueueLength;

      const checkNewMessages = (): boolean => {
        // Check any messages added since we last checked
        while (checkedCount < this.messageQueue.length) {
          const msg = this.messageQueue[checkedCount];
          checkedCount++;
          const result = predicate(msg);
          if (result !== null) {
            cleanup();
            resolve(result);
            return true;
          }
        }
        return false;
      };

      const listener = (): void => {
        checkNewMessages();
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for message (${timeout}ms)`));
      }, timeout);

      const cleanup = (): void => {
        clearTimeout(timer);
        this.messageListeners.delete(listener);
      };

      this.messageListeners.add(listener);

      // Check any messages that arrived between startQueueLength and now
      checkNewMessages();
    });
  }

  // ============================================================================
  // Debug / Utilities
  // ============================================================================

  getMessageQueue(): readonly SessionOutboundMessage[] {
    return this.messageQueue;
  }

  clearMessageQueue(): void {
    this.messageQueue = [];
  }
}
