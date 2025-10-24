import { spawn } from "child_process";
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
import { expandTilde } from "../terminal-mcp/tmux.js";
import type {
  AgentStatus,
  AgentInfo,
  AgentUpdate,
  CreateAgentOptions,
  AgentUpdateCallback,
  SessionMode,
  EnrichedSessionNotification,
  EnrichedSessionUpdate,
  AgentRuntime,
  ManagedAgentState,
} from "./types.js";
import { AgentPersistence, type AgentOptions } from "./agent-persistence.js";

interface PendingPermission {
  requestId: string;
  sessionId: string;
  params: RequestPermissionRequest;
  resolve: (response: RequestPermissionResponse) => void;
  reject: (error: Error) => void;
}

interface ManagedAgent {
  id: string;
  cwd: string;
  createdAt: Date;
  title: string;
  options: AgentOptions;
  subscribers: Set<AgentUpdateCallback>;
  updates: AgentUpdate[];
  pendingPermissions: Map<string, PendingPermission>;
  currentAssistantMessageId: string | null;
  currentThoughtId: string | null;
  titleGenerationTriggered: boolean;
  pendingSessionMode: string | null;
  state: ManagedAgentState;
}

/**
 * Get the status from an agent's state
 */
function getAgentStatusFromState(state: ManagedAgentState): AgentStatus {
  return state.type;
}

/**
 * Get the error message from an agent's state
 */
function getAgentError(state: ManagedAgentState): string | undefined {
  if (state.type === "failed") {
    return state.lastError;
  }
  if (state.type === "uninitialized" && state.lastError) {
    return state.lastError;
  }
  return undefined;
}

/**
 * Client implementation for ACP callbacks
 */
class ACPClient implements Client {
  constructor(
    private agentId: string,
    private onUpdate: (agentId: string, update: SessionNotification) => void,
    private onPermissionRequest: (agentId: string, params: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
    private persistence: AgentPersistence
  ) {}

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    console.log(`[Agent ${this.agentId}] Permission requested:`, params);

    // Forward to agent manager which will handle the permission flow
    return this.onPermissionRequest(this.agentId, params);
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    // Check if this update contains a Claude session ID
    const claudeSessionId = params._meta?.claudeSessionId as string | undefined;
    if (claudeSessionId && this.persistence) {
      const persisted = await this.persistence.load();
      const persistedAgent = persisted.find(a => a.id === this.agentId);
      if (persistedAgent && persistedAgent.options.type === "claude") {
        if (persistedAgent.options.sessionId === null || persistedAgent.options.sessionId !== claudeSessionId) {
          // Update the Claude session ID
          persistedAgent.options.sessionId = claudeSessionId;
          await this.persistence.upsert(persistedAgent);
        }
      }
    }
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
  private persistence = new AgentPersistence();

  /**
   * Initialize the agent manager and load persisted agents
   * Agents are loaded as uninitialized and will be started lazily on first use
   */
  async initialize(): Promise<void> {
    console.log("[AgentManager] Initializing and loading persisted agents...");
    const persistedAgents = await this.persistence.load();

    for (const persistedAgent of persistedAgents) {
      try {
        console.log(`[AgentManager] Loading agent ${persistedAgent.id} as uninitialized`);
        const agent: ManagedAgent = {
          id: persistedAgent.id,
          cwd: expandTilde(persistedAgent.cwd),
          createdAt: new Date(persistedAgent.createdAt),
          title: persistedAgent.title,
          options: persistedAgent.options,
          subscribers: new Set(),
          updates: [],
          pendingPermissions: new Map(),
          currentAssistantMessageId: null,
          currentThoughtId: null,
          titleGenerationTriggered: true,
          pendingSessionMode: null,
          state: {
            type: "uninitialized",
            persistedSessionId: persistedAgent.sessionId,
          },
        };
        this.agents.set(persistedAgent.id, agent);
      } catch (error) {
        console.error(`[AgentManager] Failed to load agent ${persistedAgent.id}:`, error);
      }
    }

    console.log(`[AgentManager] Loaded ${this.agents.size} agents as uninitialized`);
  }

  /**
   * Create a new agent
   * Creates an uninitialized agent record that will lazily start on first use
   */
  async createAgent(options: CreateAgentOptions): Promise<string> {
    const agentId = uuidv4();
    const cwd = expandTilde(options.cwd);

    // Validate that the working directory exists
    try {
      await access(cwd, constants.R_OK | constants.X_OK);
    } catch (error) {
      throw new Error(
        `Working directory does not exist or is not accessible: ${cwd}`
      );
    }

    const createdAt = new Date();
    const agentOptions: AgentOptions = {
      type: "claude",
      sessionId: null,
    };

    const agent: ManagedAgent = {
      id: agentId,
      cwd,
      createdAt,
      title: "",
      options: agentOptions,
      subscribers: new Set(),
      updates: [],
      pendingPermissions: new Map(),
      currentAssistantMessageId: null,
      currentThoughtId: null,
      titleGenerationTriggered: false,
      pendingSessionMode: options.initialPrompt ? null : options.initialMode ?? null,
      state: {
        type: "uninitialized",
        persistedSessionId: null,
      },
    };

    this.agents.set(agentId, agent);

    await this.persistence.upsert({
      id: agentId,
      title: agent.title || `Agent ${agentId.slice(0, 8)}`,
      sessionId: null,
      options: agent.options,
      createdAt: createdAt.toISOString(),
      cwd: agent.cwd,
    });

    this.notifySubscribers(agentId);

    if (options.initialPrompt) {
      console.log(`[Agent ${agentId}] Sending initial prompt after creation`);
      await this.sendPrompt(agentId, options.initialPrompt, {
        sessionMode: options.initialMode,
      });
    }

    return agentId;
  }

  /**
   * Send a prompt to an agent
   * @param agentId - Agent ID
   * @param prompt - The prompt text
   * @param options - Optional settings: maxWait (ms), sessionMode to set before sending, messageId for deduplication
   * @returns Object with didComplete boolean indicating if agent finished within maxWait time
   */
  async sendPrompt(
    agentId: string,
    prompt: string,
    options?: { maxWait?: number; sessionMode?: string; messageId?: string }
  ): Promise<{ didComplete: boolean; stopReason?: string }> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    // Ensure agent is initialized
    await this.ensureInitialized(agentId);

    const status = getAgentStatusFromState(agent.state);
    if (status === "killed" || status === "failed") {
      throw new Error(`Agent ${agentId} is ${status}`);
    }

    // Auto-cancel if agent is currently processing
    if (status === "processing") {
      console.log(`[Agent ${agentId}] Auto-cancelling current task before new prompt`);
      try {
        await this.cancelAgent(agentId);
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.warn(`[Agent ${agentId}] Cancel failed, continuing with new prompt:`, error);
      }
    }

    // Get runtime (guaranteed to exist after ensureInitialized)
    if (
      agent.state.type !== "ready" &&
      agent.state.type !== "processing" &&
      agent.state.type !== "completed"
    ) {
      throw new Error(`Agent ${agentId} is not ready (state: ${agent.state.type})`);
    }

    const runtime = agent.state.runtime;

    // Reset message IDs for new turn
    agent.currentAssistantMessageId = null;
    agent.currentThoughtId = null;

    // Set session mode if specified
    if (options?.sessionMode) {
      await this.setSessionMode(agentId, options.sessionMode);
    }

    // Emit user message notification
    const userMessageUpdate: AgentUpdate = {
      agentId,
      timestamp: new Date(),
      notification: {
        type: 'session',
        notification: {
          sessionId: runtime.sessionId,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: {
              type: 'text',
              text: prompt,
            },
            ...(options?.messageId ? { messageId: options.messageId } : {}),
          },
        },
      },
    };

    agent.updates.push(userMessageUpdate);

    for (const subscriber of agent.subscribers) {
      try {
        subscriber(userMessageUpdate);
      } catch (error) {
        console.error(`[Agent ${agentId}] Subscriber error:`, error);
      }
    }

    // Update state to processing
    agent.state = { type: "processing", runtime };
    this.notifySubscribers(agentId);

    // Start the prompt
    const promptPromise = runtime.connection.prompt({
      sessionId: runtime.sessionId,
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
        console.log(`[Agent ${agentId}] Prompt completed with stopReason: ${response.stopReason}`);

        const agent = this.agents.get(agentId);
        if (!agent || agent.state.type !== "processing") return;

        if (response.stopReason === "end_turn") {
          agent.state = {
            type: "completed",
            runtime: agent.state.runtime,
            stopReason: response.stopReason,
          };
        } else if (response.stopReason === "refusal") {
          agent.state = {
            type: "failed",
            lastError: "Agent refused to process the prompt",
            runtime: agent.state.runtime,
          };
        } else if (response.stopReason === "cancelled") {
          agent.state = { type: "ready", runtime: agent.state.runtime };
        } else {
          agent.state = {
            type: "completed",
            runtime: agent.state.runtime,
            stopReason: response.stopReason,
          };
        }

        this.notifySubscribers(agentId);
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

    const runtime = this.getRuntime(agent);
    if (!runtime) {
      throw new Error(`Agent ${agentId} has no active runtime to cancel`);
    }

    if (agent.state.type !== "processing") {
      console.log(
        `[Agent ${agentId}] Cancel called but agent is in state ${agent.state.type}; skipping`
      );
      return;
    }

    try {
      await runtime.connection.cancel({
        sessionId: runtime.sessionId,
      });
      agent.state = { type: "ready", runtime };
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

    const runtime = this.getRuntime(agent);

    agent.state = { type: "killed" };

    // Notify subscribers BEFORE removing from manager
    // This ensures subscribers can still query agent info
    this.notifySubscribers(agentId);

    // Remove from persistence
    await this.persistence.remove(agentId);

    // Kill the process
    if (runtime) {
      runtime.process.kill("SIGTERM");
    }

    // Wait a bit, then force kill if still alive
    if (runtime) {
      setTimeout(() => {
        if (!runtime.process.killed) {
          runtime.process.kill("SIGKILL");
        }
      }, 5000);
    }

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
    return getAgentStatusFromState(agent.state);
  }

  /**
   * List all agents
   */
  listAgents(): AgentInfo[] {
    return Array.from(this.agents.values()).map((agent) => {
      const status = getAgentStatusFromState(agent.state);
      const error = getAgentError(agent.state);
      const sessionId =
        agent.state.type !== "uninitialized" && agent.state.type !== "killed" && agent.state.type !== "failed"
          ? agent.state.runtime.sessionId
          : null;
      const currentModeId =
        agent.state.type !== "uninitialized" && agent.state.type !== "killed" && agent.state.type !== "failed"
          ? agent.state.runtime.currentModeId
          : null;
      const availableModes =
        agent.state.type !== "uninitialized" && agent.state.type !== "killed" && agent.state.type !== "failed"
          ? agent.state.runtime.availableModes
          : null;

      return {
        id: agent.id,
        status,
        createdAt: agent.createdAt,
        type: "claude" as const,
        sessionId,
        error: error ?? null,
        currentModeId,
        availableModes,
        title: agent.title,
        cwd: agent.cwd,
      };
    });
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
    const runtime = this.getRuntime(agent);
    return runtime?.currentModeId ?? null;
  }

  /**
   * Get available session modes for an agent
   */
  getAvailableModes(agentId: string): SessionMode[] | null {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }
    const runtime = this.getRuntime(agent);
    return runtime?.availableModes ?? null;
  }

  /**
   * Set the session mode for an agent
   * Validates that the mode is available before setting
   */
  async setSessionMode(agentId: string, modeId: string): Promise<void> {
    await this.ensureInitialized(agentId);

    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const runtime = this.getRuntime(agent);
    if (!runtime) {
      throw new Error(`Agent ${agentId} has no active session`);
    }

    // Validate mode is available if we have the list
    const availableModes = runtime.availableModes ?? [];
    if (availableModes.length > 0) {
      const mode = availableModes.find((m) => m.id === modeId);
      if (!mode) {
        const availableIds = availableModes.map((m) => m.id).join(", ");
        throw new Error(
          `Mode '${modeId}' not available for agent ${agentId}. Available modes: ${availableIds}`
        );
      }
    }

    try {
      await runtime.connection.setSessionMode({
        sessionId: runtime.sessionId,
        modeId,
      });

      const updatedRuntime: AgentRuntime = {
        ...runtime,
        currentModeId: modeId,
      };

      switch (agent.state.type) {
        case "ready":
          agent.state = { type: "ready", runtime: updatedRuntime };
          break;
        case "processing":
          agent.state = { type: "processing", runtime: updatedRuntime };
          break;
        case "completed":
          agent.state = {
            type: "completed",
            runtime: updatedRuntime,
            stopReason: agent.state.stopReason,
          };
          break;
        case "initializing":
          agent.state = {
            type: "initializing",
            runtime: updatedRuntime,
            initStartedAt: agent.state.initStartedAt,
          };
          break;
        case "failed":
          agent.state = {
            type: "failed",
            lastError: agent.state.lastError,
            runtime: updatedRuntime,
          };
          break;
        default:
          break;
      }

      console.log(`[Agent ${agentId}] Session mode changed to: ${modeId}`);
      this.notifySubscribers(agentId);
    } catch (error) {
      console.error(`[Agent ${agentId}] Failed to set mode:`, error);
      throw error;
    }
  }

  /**
   * Ensure an agent is initialized, starting runtime if needed
   * Handles concurrent initialization requests by memoizing the promise
   */
  private async ensureInitialized(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const state = agent.state;

    // Already initialized
    if (
      state.type === "ready" ||
      state.type === "processing" ||
      state.type === "completed"
    ) {
      return;
    }

    // Initialization already in progress - wait for the promise
    if (state.type === "initializing") {
      await state.initPromise;
      return;
    }

    // Failed - don't retry automatically
    if (state.type === "failed") {
      throw new Error(
        `Agent ${agentId} is in failed state: ${state.lastError}`
      );
    }

    // Killed - can't initialize
    if (state.type === "killed") {
      throw new Error(`Agent ${agentId} has been killed`);
    }

    // Uninitialized - start initialization
    if (state.type === "uninitialized") {
      const persistedSessionId = state.persistedSessionId;

      // Create the init promise
      const initPromise = (async () => {
        try {
          const hasPersistedSession =
            (agent.options.type === "claude" && agent.options.sessionId !== null) ||
            !!persistedSessionId;
          const mode = hasPersistedSession ? "resume" : "new";

          console.log(
            `[Agent ${agentId}] Starting lazy initialization (mode: ${mode})`
          );
          await this.startRuntimeForAgent(agent, mode, persistedSessionId);
          console.log(`[Agent ${agentId}] Lazy initialization completed`);
        } catch (error) {
          console.error(
            `[Agent ${agentId}] Lazy initialization failed:`,
            error
          );
          throw error;
        }
      })();

      // Transition to initializing state with the promise
      agent.state = {
        type: "initializing",
        persistedSessionId,
        initPromise,
        initStartedAt: new Date(),
      };

      await initPromise;
    }
  }

  private getRuntime(agent: ManagedAgent): AgentRuntime | null {
    if (
      agent.state.type === "ready" ||
      agent.state.type === "processing" ||
      agent.state.type === "completed"
    ) {
      return agent.state.runtime;
    }

    if (agent.state.type === "initializing") {
      return agent.state.runtime;
    }

    if (agent.state.type === "failed" && agent.state.runtime) {
      return agent.state.runtime;
    }

    return null;
  }

  /**
   * Start runtime for an agent (spawn process, create connection, initialize session)
   */
  private async startRuntimeForAgent(
    agent: ManagedAgent,
    mode: "new" | "resume",
    resumeSessionId?: string | null
  ): Promise<void> {
    const agentId = agent.id;
    const cwd = agent.cwd;

    console.log(`[Agent ${agentId}] Starting runtime (mode: ${mode})`);

    try {
      await access(cwd, constants.R_OK | constants.X_OK);
    } catch {
      const errorMessage = `Working directory does not exist or is not accessible: ${cwd}`;
      console.error(`[Agent ${agentId}] ${errorMessage}`);
      agent.state = {
        type: "failed",
        lastError: errorMessage,
      };
      this.notifySubscribers(agentId);
      throw new Error(errorMessage);
    }

    const agentProcess = spawn("npx", ["@boudra/claude-code-acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
    });

    const input = Writable.toWeb(agentProcess.stdin);
    const output = Readable.toWeb(agentProcess.stdout);
    const stream = ndJsonStream(input, output);

    const client = new ACPClient(
      agentId,
      (id, update) => {
        this.handleSessionNotification(id, update);
      },
      (id, params) => {
        return this.handlePermissionRequest(id, params);
      },
      this.persistence
    );
    const connection = new ClientSideConnection(() => client, stream);

    const runtime: AgentRuntime = {
      process: agentProcess,
      connection,
      sessionId: "",
      currentModeId: null,
      availableModes: null,
    };

    agent.state = {
      type: "initializing",
      runtime,
      initStartedAt: new Date(),
    };

    agentProcess.on("error", (error) => {
      this.handleAgentError(agentId, `Process error: ${error.message}`);
    });

    agentProcess.on("exit", (code, signal) => {
      const currentAgent = this.agents.get(agentId);
      if (!currentAgent) return;

      const status = getAgentStatusFromState(currentAgent.state);
      if (status !== "completed" && status !== "killed") {
        this.handleAgentError(
          agentId,
          `Process exited unexpectedly: code=${code}, signal=${signal}`
        );
      }
    });

    agentProcess.stderr.on("data", (data) => {
      console.error(`[Agent ${agentId}] stderr:`, data.toString());
    });

    try {
      await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
        },
      });

      let sessionResponse:
        | Awaited<ReturnType<typeof connection.newSession>>
        | Awaited<ReturnType<typeof connection.loadSession>>;
      let effectiveSessionId: string;
      if (mode === "resume") {
        const sessionIdToResume =
          (agent.options.type === "claude" && agent.options.sessionId) ||
          resumeSessionId ||
          null;

        if (!sessionIdToResume) {
          throw new Error(`Cannot resume agent ${agentId}: No session ID available`);
        }

        console.log(`[Agent ${agentId}] Loading session: ${sessionIdToResume}`);
        sessionResponse = await connection.loadSession({
          sessionId: sessionIdToResume,
          cwd,
          mcpServers: [],
        });
        effectiveSessionId = sessionIdToResume;
      } else {
        console.log(`[Agent ${agentId}] Creating new session`);
        const newSessionResponse = await connection.newSession({
          cwd,
          mcpServers: [],
        });
        sessionResponse = newSessionResponse;
        effectiveSessionId = newSessionResponse.sessionId;
      }

      runtime.sessionId = effectiveSessionId;
      runtime.currentModeId = sessionResponse.modes?.currentModeId ?? null;
      runtime.availableModes = sessionResponse.modes?.availableModes ?? null;

      const claudeSessionId =
        sessionResponse._meta?.claudeSessionId as string | undefined;
      if (
        claudeSessionId &&
        agent.options.type === "claude" &&
        agent.options.sessionId !== claudeSessionId
      ) {
        agent.options = {
          ...agent.options,
          sessionId: claudeSessionId,
        };
      }

      console.log(
        `[Agent ${agentId}] Session ${mode === "new" ? "created" : "loaded"}: ACP=${effectiveSessionId}, Claude=${claudeSessionId || "N/A"}`
      );

      await this.persistence.upsert({
        id: agentId,
        title: agent.title || `Agent ${agentId.slice(0, 8)}`,
        sessionId: runtime.sessionId,
        options: agent.options,
        createdAt: agent.createdAt.toISOString(),
        cwd: agent.cwd,
      });

      agent.state = {
        type: "ready",
        runtime,
      };

      this.notifySubscribers(agentId);

      if (agent.pendingSessionMode) {
        const pendingMode = agent.pendingSessionMode;
        agent.pendingSessionMode = null;
        try {
          await this.setSessionMode(agentId, pendingMode);
        } catch (error) {
          console.error(
            `[Agent ${agentId}] Failed to apply pending session mode ${pendingMode}:`,
            error
          );
        }
      }

      console.log(
        `[Agent ${agentId}] Runtime started successfully with mode: ${runtime.currentModeId}`
      );
    } catch (error) {
      const errorMessage = `Runtime startup failed: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[Agent ${agentId}]`, errorMessage);
      agent.state = {
        type: "failed",
        lastError: errorMessage,
      };
      this.notifySubscribers(agentId);
      try {
        agentProcess.kill("SIGTERM");
      } catch {
        // ignore kill errors
      }
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
    let enrichedUpdate: EnrichedSessionNotification;

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
        } as EnrichedSessionUpdate,
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
        } as EnrichedSessionUpdate,
      };
    }
    // For other update types, use update as-is
    else {
      enrichedUpdate = update as EnrichedSessionNotification;

      // Reset message IDs on new turn (user message or tool call starts new turn)
      if (updateType === 'tool_call' || updateType === 'user_message_chunk') {
        agent.currentAssistantMessageId = null;
        agent.currentThoughtId = null;
      }
    }

    // Create agent update with enriched notification wrapped in discriminated union
    const agentUpdate: AgentUpdate = {
      agentId,
      timestamp: new Date(),
      notification: {
        type: 'session',
        notification: enrichedUpdate,
      },
    };

    // Store the update in history
    agent.updates.push(agentUpdate);

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
   * Handle agent errors
   */
  private handleAgentError(agentId: string, errorMessage: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    console.error(`[Agent ${agentId}] Error:`, errorMessage);

    // Preserve runtime if it exists
    const runtime =
      agent.state.type !== "uninitialized" && agent.state.type !== "killed" && agent.state.type !== "failed"
        ? agent.state.runtime
        : undefined;

    agent.state = {
      type: "failed",
      lastError: errorMessage,
      runtime,
    };
    this.notifySubscribers(agentId);
  }

  /**
   * Notify subscribers that agent status has changed
   */
  private notifySubscribers(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const status = getAgentStatusFromState(agent.state);
    const error = getAgentError(agent.state);

    const update: AgentUpdate = {
      agentId,
      timestamp: new Date(),
      notification: {
        type: 'status',
        status,
        error,
      },
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
  async setAgentTitle(agentId: string, title: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    agent.title = title;
    console.log(`[Agent ${agentId}] Title set to: "${title}"`);

    await this.persistence.updateTitle(agentId, title);
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

      // Emit permission request via discriminated union
      // This will be picked up by subscribers (Session) and forwarded to UI
      const agentUpdate: AgentUpdate = {
        agentId,
        timestamp: new Date(),
        notification: {
          type: 'permission',
          requestId,  // Pass the requestId that we stored in pendingPermissions
          request: params,
        },
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

    // Emit permission_resolved notification so UI can update
    const agentUpdate: AgentUpdate = {
      agentId,
      timestamp: new Date(),
      notification: {
        type: 'permission_resolved',
        requestId,
        agentId,
        optionId,
      },
    };

    // Store the update in history
    agent.updates.push(agentUpdate);

    // Notify all subscribers (including Session which will forward to WebSocket)
    for (const subscriber of agent.subscribers) {
      try {
        subscriber(agentUpdate);
      } catch (error) {
        console.error(`[Agent ${agentId}] Subscriber error:`, error);
      }
    }

    console.log(`[Agent ${agentId}] Permission resolved notification emitted: ${requestId}`);
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
