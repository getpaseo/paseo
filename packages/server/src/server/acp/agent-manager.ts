import { spawn, ChildProcess } from "child_process";
import { Writable, Readable } from "stream";
import { access, constants } from "fs/promises";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { v4 as uuidv4 } from "uuid";
import type {
  AgentStatus,
  AgentInfo,
  AgentUpdate,
  CreateAgentOptions,
  AgentUpdateCallback,
  SessionMode,
  EnrichedSessionNotification,
} from "./types.js";

interface PendingPermission {
  requestId: string;
  sessionId: string;
  params: RequestPermissionRequest;
  resolve: (response: RequestPermissionResponse) => void;
  reject: (error: Error) => void;
}

interface ManagedAgent {
  id: string;
  status: AgentStatus;
  createdAt: Date;
  process: ChildProcess;
  connection: ClientSideConnection;
  sessionId?: string;
  error?: string;
  currentModeId?: string;
  availableModes?: SessionMode[];
  subscribers: Set<AgentUpdateCallback>;
  updates: AgentUpdate[];
  title?: string;
  cwd: string;
  titleGenerationTriggered: boolean;
  pendingPermissions: Map<string, PendingPermission>;
  // Message ID tracking for stable deduplication
  currentAssistantMessageId: string | null;
  currentThoughtId: string | null;
}

/**
 * Client implementation for ACP callbacks
 */
class ACPClient implements Client {
  constructor(
    private agentId: string,
    private onUpdate: (agentId: string, update: SessionNotification) => void,
    private onPermissionRequest: (agentId: string, params: RequestPermissionRequest) => Promise<RequestPermissionResponse>
  ) {}

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    console.log(`[Agent ${this.agentId}] Permission requested:`, params);

    // Forward to agent manager which will handle the permission flow
    return this.onPermissionRequest(this.agentId, params);
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.onUpdate(this.agentId, params);
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    console.log(`[Agent ${this.agentId}] Read text file:`, params.path);
    const fs = await import("fs/promises");
    try {
      const content = await fs.readFile(params.path, "utf-8");
      return { content };
    } catch (error) {
      console.error(`[Agent ${this.agentId}] Failed to read file:`, error);
      return { content: "" };
    }
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    console.log(`[Agent ${this.agentId}] Write text file:`, params.path);
    const fs = await import("fs/promises");
    try {
      await fs.writeFile(params.path, params.content, "utf-8");
      return {};
    } catch (error) {
      console.error(`[Agent ${this.agentId}] Failed to write file:`, error);
      throw error;
    }
  }
}

/**
 * Manages Claude Code agents via ACP
 */
export class AgentManager {
  private agents = new Map<string, ManagedAgent>();

  /**
   * Create a new agent
   * Spawns the claude-code-acp process and initializes ACP connection
   */
  async createAgent(options: CreateAgentOptions): Promise<string> {
    const agentId = uuidv4();
    const cwd = options.cwd;

    // Validate that the working directory exists
    try {
      await access(cwd, constants.R_OK | constants.X_OK);
    } catch (error) {
      throw new Error(
        `Working directory does not exist or is not accessible: ${cwd}`
      );
    }

    // Spawn the ACP process
    const agentProcess = spawn("npx", ["@zed-industries/claude-code-acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
    });

    // Create streams for ACP communication
    const input = Writable.toWeb(agentProcess.stdin);
    const output = Readable.toWeb(agentProcess.stdout);
    const stream = ndJsonStream(input, output);

    // Create the ACP client and connection
    const client = new ACPClient(
      agentId,
      (id, update) => {
        this.handleSessionNotification(id, update);
      },
      (id, params) => {
        return this.handlePermissionRequest(id, params);
      }
    );
    const connection = new ClientSideConnection(() => client, stream);

    // Create the managed agent record
    const agent: ManagedAgent = {
      id: agentId,
      status: "initializing",
      createdAt: new Date(),
      process: agentProcess,
      connection,
      subscribers: new Set(),
      updates: [],
      cwd,
      titleGenerationTriggered: false,
      pendingPermissions: new Map(),
      currentAssistantMessageId: null,
      currentThoughtId: null,
    };

    this.agents.set(agentId, agent);

    // Handle process errors
    agentProcess.on("error", (error) => {
      this.handleAgentError(agentId, `Process error: ${error.message}`);
    });

    agentProcess.on("exit", (code, signal) => {
      const agent = this.agents.get(agentId);
      if (!agent) return;

      if (agent.status !== "completed" && agent.status !== "killed") {
        this.handleAgentError(
          agentId,
          `Process exited unexpectedly: code=${code}, signal=${signal}`
        );
      }
    });

    // Capture stderr for debugging
    agentProcess.stderr.on("data", (data) => {
      console.error(`[Agent ${agentId}] stderr:`, data.toString());
    });

    try {
      // Initialize the connection
      await agent.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
        },
      });

      // Create a new session
      const sessionParams = {
        cwd,
        mcpServers: [],
      };
      console.log(`[Agent ${agentId}] newSession params:`, sessionParams);
      const sessionResponse = await agent.connection.newSession(sessionParams);

      agent.sessionId = sessionResponse.sessionId;
      console.log(`[Agent ${agentId}] newSession response:`, JSON.stringify(sessionResponse, null, 2));

      // Store session modes from response
      if (sessionResponse.modes) {
        agent.currentModeId = sessionResponse.modes.currentModeId;
        agent.availableModes = sessionResponse.modes.availableModes;
        console.log(
          `[Agent ${agentId}] Session created with mode: ${agent.currentModeId}`,
          `Available modes:`, agent.availableModes?.map(m => m.id).join(', ')
        );
      } else {
        console.log(`[Agent ${agentId}] Session created:`, sessionResponse.sessionId);
      }

      // Set initial mode if requested (must be done after session creation)
      if (options.initialMode && agent.sessionId) {
        console.log(`[Agent ${agentId}] Setting initial mode to: ${options.initialMode}`);
        await this.setSessionMode(agentId, options.initialMode);
      }

      agent.status = "ready";

      // If an initial prompt was provided, send it
      if (options.initialPrompt) {
        console.log(`[Agent ${agentId}] Sending initial prompt`);
        await this.sendPrompt(agentId, options.initialPrompt);
      }

      return agentId;
    } catch (error) {
      this.handleAgentError(
        agentId,
        `Initialization failed: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  /**
   * Send a prompt to an agent
   * @param agentId - Agent ID
   * @param prompt - The prompt text
   * @param options - Optional settings: maxWait (ms), sessionMode to set before sending
   * @returns Object with didComplete boolean indicating if agent finished within maxWait time
   */
  async sendPrompt(
    agentId: string,
    prompt: string,
    options?: { maxWait?: number; sessionMode?: string }
  ): Promise<{ didComplete: boolean; stopReason?: string }> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    if (agent.status === "killed" || agent.status === "failed") {
      throw new Error(`Agent ${agentId} is ${agent.status}`);
    }

    // Set session mode if specified
    if (options?.sessionMode) {
      await this.setSessionMode(agentId, options.sessionMode);
    }

    agent.status = "processing";
    this.notifySubscribers(agentId);

    // Start the prompt (this will eventually complete and update status)
    const promptPromise = agent.connection.prompt({
      sessionId: agent.sessionId!,
      prompt: [
        {
          type: "text",
          text: prompt,
        },
      ],
    });

    // Handle completion in background
    promptPromise
      .then((response) => {
        // Handle completion based on stopReason from the protocol
        console.log(`[Agent ${agentId}] Prompt completed with stopReason: ${response.stopReason}`);

        if (response.stopReason === "end_turn") {
          agent.status = "completed";
        } else if (response.stopReason === "refusal") {
          agent.status = "failed";
          agent.error = "Agent refused to process the prompt";
        } else if (response.stopReason === "cancelled") {
          agent.status = "ready";
        } else {
          // max_tokens, max_turn_requests - still completed but may be truncated
          agent.status = "completed";
        }

        this.notifyStatusChange(agentId);
      })
      .catch((error) => {
        this.handleAgentError(
          agentId,
          `Prompt failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });

    const maxWait = options?.maxWait;

    // If no maxWait specified, return immediately
    if (maxWait === undefined) {
      console.log(`[Agent ${agentId}] Prompt sent (non-blocking, use get_agent_status to check completion)`);
      return { didComplete: false };
    }

    // If maxWait specified, race between completion and timeout
    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), maxWait)
      );

      const response = await Promise.race([promptPromise, timeoutPromise]);

      console.log(`[Agent ${agentId}] Prompt completed within ${maxWait}ms with stopReason: ${response.stopReason}`);
      return { didComplete: true, stopReason: response.stopReason };
    } catch (error) {
      if (error instanceof Error && error.message === "timeout") {
        console.log(`[Agent ${agentId}] Prompt did not complete within ${maxWait}ms (still processing)`);
        return { didComplete: false };
      }
      // Real error - rethrow
      throw error;
    }
  }

  /**
   * Cancel an agent's current task
   */
  async cancelAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    if (!agent.sessionId) {
      throw new Error(`Agent ${agentId} has no active session`);
    }

    try {
      await agent.connection.cancel({
        sessionId: agent.sessionId,
      });
      agent.status = "ready";
      this.notifySubscribers(agentId);
    } catch (error) {
      console.error(`[Agent ${agentId}] Cancel failed:`, error);
      throw error;
    }
  }

  /**
   * Kill an agent
   * Terminates the process and removes it from the manager
   */
  async killAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    agent.status = "killed";

    // Notify subscribers BEFORE removing from manager
    // This ensures subscribers can still query agent info
    this.notifySubscribers(agentId);

    // Kill the process
    agent.process.kill("SIGTERM");

    // Wait a bit, then force kill if still alive
    setTimeout(() => {
      if (!agent.process.killed) {
        agent.process.kill("SIGKILL");
      }
    }, 5000);

    // Remove from manager after a small delay to allow status updates to propagate
    setTimeout(() => {
      this.agents.delete(agentId);
      console.log(`[Agent ${agentId}] Removed from manager`);
    }, 100);
  }

  /**
   * Get the status of an agent
   */
  getAgentStatus(agentId: string): AgentStatus {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }
    return agent.status;
  }

  /**
   * List all agents
   */
  listAgents(): AgentInfo[] {
    return Array.from(this.agents.values()).map((agent) => ({
      id: agent.id,
      status: agent.status,
      createdAt: agent.createdAt.toISOString(),
      type: "claude" as const,
      sessionId: agent.sessionId ?? null,
      error: agent.error ?? null,
      currentModeId: agent.currentModeId ?? null,
      availableModes: agent.availableModes ?? null,
      title: agent.title ?? null,
      cwd: agent.cwd,
    }));
  }

  /**
   * Subscribe to updates from an agent
   */
  subscribeToUpdates(
    agentId: string,
    callback: AgentUpdateCallback
  ): () => void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    agent.subscribers.add(callback);

    // Return unsubscribe function
    return () => {
      agent.subscribers.delete(callback);
    };
  }

  /**
   * Get all updates for an agent
   */
  getAgentUpdates(agentId: string): AgentUpdate[] {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }
    return [...agent.updates];
  }

  /**
   * Get the current session mode for an agent
   */
  getCurrentMode(agentId: string): string | null {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }
    return agent.currentModeId ?? null;
  }

  /**
   * Get available session modes for an agent
   */
  getAvailableModes(agentId: string): SessionMode[] | null {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }
    return agent.availableModes ?? null;
  }

  /**
   * Set the session mode for an agent
   * Validates that the mode is available before setting
   */
  async setSessionMode(agentId: string, modeId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    if (!agent.sessionId) {
      throw new Error(`Agent ${agentId} has no active session`);
    }

    // Validate mode is available
    const availableModes = agent.availableModes || [];
    const mode = availableModes.find((m) => m.id === modeId);
    if (!mode && availableModes.length > 0) {
      const availableIds = availableModes.map((m) => m.id).join(", ");
      throw new Error(
        `Mode '${modeId}' not available for agent ${agentId}. Available modes: ${availableIds}`
      );
    }

    try {
      await agent.connection.setSessionMode({
        sessionId: agent.sessionId,
        modeId,
      });

      agent.currentModeId = modeId;
      console.log(`[Agent ${agentId}] Session mode changed to: ${modeId}`);
    } catch (error) {
      console.error(`[Agent ${agentId}] Failed to set mode:`, error);
      throw error;
    }
  }

  /**
   * Handle session notifications from the ACP connection
   * Augments agent message and thought chunks with stable message IDs
   */
  private handleSessionNotification(agentId: string, update: SessionNotification): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Augment update with stable message IDs for deduplication
    let enrichedUpdate: EnrichedSessionNotification = update;

    const updateType = update.update.sessionUpdate;

    // Agent message chunks - add stable message ID
    if (updateType === 'agent_message_chunk') {
      if (!agent.currentAssistantMessageId) {
        agent.currentAssistantMessageId = uuidv4();
      }
      enrichedUpdate = {
        ...update,
        update: {
          ...update.update,
          messageId: agent.currentAssistantMessageId,
        },
      };
    }
    // Agent thought chunks - add stable message ID
    else if (updateType === 'agent_thought_chunk') {
      if (!agent.currentThoughtId) {
        agent.currentThoughtId = uuidv4();
      }
      enrichedUpdate = {
        ...update,
        update: {
          ...update.update,
          messageId: agent.currentThoughtId,
        },
      };
    }
    // Reset message IDs on new turn (user message or tool call starts new turn)
    else if (updateType === 'tool_call' || updateType === 'user_message_chunk') {
      agent.currentAssistantMessageId = null;
      agent.currentThoughtId = null;
    }

    // Create agent update with enriched notification
    const agentUpdate: AgentUpdate = {
      agentId,
      timestamp: new Date(),
      notification: enrichedUpdate,
    };

    // Store the update in history
    agent.updates.push(agentUpdate);

    // Handle mode change notifications
    if ((update as any).type === "currentModeUpdate" && (update as any).currentModeId) {
      agent.currentModeId = (update as any).currentModeId;
      console.log(`[Agent ${agentId}] Mode changed to: ${agent.currentModeId}`);
    }

    // Log update for debugging
    console.log(
      `[Agent ${agentId}] Session update:`,
      updateType
    );

    // Notify all subscribers
    for (const subscriber of agent.subscribers) {
      try {
        subscriber(agentUpdate);
      } catch (error) {
        console.error(`[Agent ${agentId}] Subscriber error:`, error);
      }
    }
  }

  /**
   * Notify subscribers of a status change
   */
  private notifyStatusChange(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const update: AgentUpdate = {
      agentId,
      timestamp: new Date(),
      notification: {
        type: "sessionUpdate",
        sessionUpdate: {
          sessionId: agent.sessionId || "",
          sessionUpdate: "status_change",
          status: agent.status,
        },
      } as any,
    };

    for (const subscriber of agent.subscribers) {
      try {
        subscriber(update);
      } catch (error) {
        console.error(`[Agent ${agentId}] Subscriber error:`, error);
      }
    }
  }

  /**
   * Handle agent errors
   */
  private handleAgentError(agentId: string, errorMessage: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    console.error(`[Agent ${agentId}] Error:`, errorMessage);
    agent.status = "failed";
    agent.error = errorMessage;
    this.notifySubscribers(agentId);
  }

  /**
   * Notify subscribers that agent status has changed
   */
  private notifySubscribers(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const update: AgentUpdate = {
      agentId,
      timestamp: new Date(),
      notification: {
        type: "sessionUpdate",
        sessionUpdate: {
          sessionId: agent.sessionId || "",
          status: agent.status,
          state: agent.error ? { kind: "error", error: agent.error } : undefined,
        },
      } as any,
    };

    for (const subscriber of agent.subscribers) {
      try {
        subscriber(update);
      } catch (error) {
        console.error(`[Agent ${agentId}] Subscriber error:`, error);
      }
    }
  }

  /**
   * Set the title for an agent
   */
  setAgentTitle(agentId: string, title: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    agent.title = title;
    console.log(`[Agent ${agentId}] Title set to: "${title}"`);
  }

  /**
   * Get the title for an agent
   */
  getAgentTitle(agentId: string): string | null {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }
    return agent.title ?? null;
  }

  /**
   * Mark that title generation has been triggered for this agent
   */
  markTitleGenerationTriggered(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }
    agent.titleGenerationTriggered = true;
  }

  /**
   * Check if title generation has been triggered for this agent
   */
  isTitleGenerationTriggered(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }
    return agent.titleGenerationTriggered;
  }

  /**
   * Handle permission request from ACP
   * Creates a pending permission and emits it via session notifications
   */
  private handlePermissionRequest(
    agentId: string,
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    // Generate unique request ID
    const requestId = uuidv4();

    console.log(`[Agent ${agentId}] Creating pending permission request: ${requestId}`);

    // Create a promise that will be resolved when user responds
    return new Promise<RequestPermissionResponse>((resolve, reject) => {
      // Store the pending permission
      const pendingPermission: PendingPermission = {
        requestId,
        sessionId: params.sessionId,
        params,
        resolve,
        reject,
      };

      agent.pendingPermissions.set(requestId, pendingPermission);

      // Emit permission request via session notification
      // This will be picked up by subscribers (Session) and forwarded to UI
      const permissionNotification: any = {
        type: "permissionRequest",
        permissionRequest: {
          agentId,
          requestId,
          sessionId: params.sessionId,
          toolCall: params.toolCall,
          options: params.options,
        },
      };

      const agentUpdate: AgentUpdate = {
        agentId,
        timestamp: new Date(),
        notification: permissionNotification,
      };

      // Store the update in history
      agent.updates.push(agentUpdate);

      // Notify all subscribers
      for (const subscriber of agent.subscribers) {
        try {
          subscriber(agentUpdate);
        } catch (error) {
          console.error(`[Agent ${agentId}] Subscriber error:`, error);
        }
      }

      console.log(`[Agent ${agentId}] Permission request emitted: ${requestId}`);

      // Set a timeout to auto-reject after 5 minutes if no response
      setTimeout(() => {
        if (agent.pendingPermissions.has(requestId)) {
          console.warn(`[Agent ${agentId}] Permission request ${requestId} timed out`);
          agent.pendingPermissions.delete(requestId);
          reject(new Error("Permission request timed out"));
        }
      }, 5 * 60 * 1000); // 5 minutes
    });
  }

  /**
   * Respond to a pending permission request
   * Called when user makes a choice in the UI
   */
  respondToPermission(
    agentId: string,
    requestId: string,
    optionId: string
  ): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const pendingPermission = agent.pendingPermissions.get(requestId);
    if (!pendingPermission) {
      throw new Error(
        `Permission request ${requestId} not found for agent ${agentId}`
      );
    }

    console.log(
      `[Agent ${agentId}] Resolving permission ${requestId} with option: ${optionId}`
    );

    // Resolve the promise with the user's choice
    pendingPermission.resolve({
      outcome: {
        outcome: "selected" as const,
        optionId,
      },
    });

    // Remove from pending
    agent.pendingPermissions.delete(requestId);
  }

  /**
   * Get all pending permission requests across all agents
   * Used by orchestrator to see what permissions are waiting
   */
  getPendingPermissions(): Array<{
    agentId: string;
    requestId: string;
    sessionId: string;
    toolCall: any;
    options: Array<{
      kind: string;
      name: string;
      optionId: string;
    }>;
  }> {
    const allPermissions: Array<{
      agentId: string;
      requestId: string;
      sessionId: string;
      toolCall: any;
      options: Array<{
        kind: string;
        name: string;
        optionId: string;
      }>;
    }> = [];

    for (const [agentId, agent] of this.agents) {
      for (const [requestId, permission] of agent.pendingPermissions) {
        allPermissions.push({
          agentId,
          requestId,
          sessionId: permission.sessionId,
          toolCall: permission.params.toolCall,
          options: permission.params.options,
        });
      }
    }

    return allPermissions;
  }
}
