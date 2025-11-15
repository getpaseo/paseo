import { v4 as uuidv4 } from "uuid";
import { readFile, mkdir, writeFile } from "fs/promises";
import { exec } from "child_process";
import { promisify, inspect } from "util";
import { join } from "path";
import invariant from "tiny-invariant";
import { streamText, stepCountIs } from "ai";
import type { ToolSet } from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  createOpenRouter,
  OpenRouterProviderOptions,
} from "@openrouter/ai-sdk-provider";
import {
  serializeAgentSnapshot,
  serializeAgentStreamEvent,
  type AgentSnapshotPayload,
  type SessionInboundMessage,
  type SessionOutboundMessage,
  type FileExplorerRequest,
} from "./messages.js";
import { getSystemPrompt } from "./agent/system-prompt.js";
import { getAllTools } from "./agent/llm-openai.js";
import { TTSManager } from "./agent/tts-manager.js";
import { STTManager } from "./agent/stt-manager.js";
import {
  saveConversation,
  listConversations,
  deleteConversation,
} from "./persistence.js";
import { experimental_createMCPClient } from "ai";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTerminalMcpServer } from "./terminal-mcp/index.js";
import { createAgentMcpServer } from "./agent/mcp-server.js";
import { AgentManager } from "./agent/agent-manager.js";
import type { AgentSnapshot } from "./agent/agent-manager.js";
import type {
  AgentPermissionResponse,
  AgentPromptInput,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent/agent-sdk-types.js";
import { AgentRegistry } from "./agent/agent-registry.js";
import { expandTilde } from "./terminal-mcp/tmux.js";
import {
  listDirectoryEntries,
  readExplorerFile,
} from "./file-explorer/service.js";
import {
  generateAgentTitle,
  isTitleGeneratorInitialized,
} from "../services/agent-title-generator.js";
import type { TerminalManager } from "./terminal-mcp/terminal-manager.js";

const execAsync = promisify(exec);
const ACTIVE_TITLE_GENERATIONS = new Set<string>();

type ProcessingPhase = "idle" | "transcribing" | "llm";

/**
 * Type for present_artifact tool arguments
 */
interface PresentArtifactArgs {
  type: "markdown" | "diff" | "image" | "code";
  source:
    | { type: "file"; path: string }
    | { type: "command_output"; command: string }
    | { type: "text"; text: string };
  title: string;
}

/**
 * Session represents a single client conversation session.
 * It owns all state management, orchestration logic, and message processing.
 * Session has no knowledge of WebSockets - it only emits and receives messages.
 */
export class Session {
  private readonly clientId: string;
  private readonly conversationId: string;
  private readonly onMessage: (msg: SessionOutboundMessage) => void;

  // State machine
  private abortController: AbortController;
  private processingPhase: ProcessingPhase = "idle";
  private currentStreamPromise: Promise<void> | null = null;

  // Realtime mode state
  private isRealtimeMode = false;

  // Audio buffering for interruption handling
  private pendingAudioSegments: Array<{ audio: Buffer; format: string }> = [];
  private bufferTimeout: NodeJS.Timeout | null = null;
  private audioBuffer: { chunks: Buffer[]; format: string } | null = null;

  // Conversation history
  private messages: ModelMessage[] = [];
  private turnIndex = 0;

  // Per-session managers
  private readonly ttsManager: TTSManager;
  private readonly sttManager: STTManager;

  // Per-session MCP client and tools
  private terminalMcpClient: Awaited<
    ReturnType<typeof experimental_createMCPClient>
  > | null = null;
  private terminalTools: ToolSet | null = null;
  private terminalManager: TerminalManager | null = null;
  private agentMcpClient: Awaited<
    ReturnType<typeof experimental_createMCPClient>
  > | null = null;
  private agentTools: ToolSet | null = null;
  private agentManager: AgentManager;
  private readonly agentRegistry: AgentRegistry;
  private agentTitleCache: Map<string, string | null> = new Map();
  private unsubscribeAgentEvents: (() => void) | null = null;

  constructor(
    clientId: string,
    onMessage: (msg: SessionOutboundMessage) => void,
    agentManager: AgentManager,
    agentRegistry: AgentRegistry,
    options?: {
      conversationId?: string;
      initialMessages?: ModelMessage[];
    }
  ) {
    this.clientId = clientId;
    this.conversationId = options?.conversationId || uuidv4();
    this.onMessage = onMessage;
    this.agentManager = agentManager;
    this.agentRegistry = agentRegistry;
    this.abortController = new AbortController();

    // Initialize conversation history
    if (options?.initialMessages) {
      this.messages = options.initialMessages;
      console.log(
        `[Session ${this.clientId}] Restored conversation ${this.conversationId} with ${this.messages.length} messages`
      );
    }

    // Initialize per-session managers
    this.ttsManager = new TTSManager(this.conversationId);
    this.sttManager = new STTManager(this.conversationId);

    // Initialize terminal + agent MCP clients asynchronously
    void this.initializeTerminalMcp();
    void this.initializeAgentMcp();
    this.subscribeToAgentEvents();

    console.log(
      `[Session ${this.clientId}] Created with conversation ${this.conversationId}`
    );
  }

  /**
   * Get the conversation ID for this session
   */
  public getConversationId(): string {
    return this.conversationId;
  }

  /**
   * Send initial state to client after connection
   */
  public async sendInitialState(): Promise<void> {
    await this.sendSessionState();
  }

  /**
   * Normalize a user prompt (with optional image metadata) for AgentManager
   */
  private buildAgentPrompt(
    text: string,
    images?: Array<{ data: string; mimeType: string }>
  ): AgentPromptInput {
    const normalized = text?.trim() ?? "";
    if (!images || images.length === 0) {
      return normalized;
    }

    const attachmentSummary = images
      .map((image, index) => {
        const sizeKb = Math.round((image.data.length * 0.75) / 1024);
        return `Attachment ${index + 1}: ${image.mimeType}, ~${sizeKb}KB base64`;
      })
      .join("\n");

    const base = normalized.length > 0 ? normalized : "User shared image attachment(s).";
    return `${base}\n\n[Image attachments]\n${attachmentSummary}\n(Actual image bytes omitted; request a screenshot or file if needed.)`;
  }

  /**
   * Start streaming an agent run and forward results via the websocket broadcast
   */
  private startAgentStream(agentId: string, prompt: AgentPromptInput): void {
    console.log(
      `[Session ${this.clientId}] Starting agent stream for ${agentId}`
    );

    let iterator: AsyncGenerator<AgentStreamEvent>;
    try {
      iterator = this.agentManager.streamAgent(agentId, prompt);
    } catch (error) {
      this.handleAgentRunError(agentId, error, "Failed to start agent run");
      return;
    }

    void (async () => {
      try {
        for await (const _ of iterator) {
          // Events are forwarded via the session's AgentManager subscription.
        }
      } catch (error) {
        this.handleAgentRunError(agentId, error, "Agent stream failed");
      }
    })();
  }

  private handleAgentRunError(
    agentId: string,
    error: unknown,
    context: string
  ): void {
    const message =
      error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
    console.error(
      `[Session ${this.clientId}] ${context} for agent ${agentId}:`,
      error
    );
    this.emit({
      type: "activity_log",
      payload: {
        id: uuidv4(),
        timestamp: new Date(),
        type: "error",
        content: `${context}: ${message}`,
      },
    });
  }

  /**
   * Initialize Terminal MCP client for this session
   */
  private async initializeTerminalMcp(): Promise<void> {
    try {
      // Create Terminal Manager directly
      const { TerminalManager } = await import(
        "./terminal-mcp/terminal-manager.js"
      );
      this.terminalManager = new TerminalManager(this.conversationId);
      await this.terminalManager.initialize();

      // Create Terminal MCP server with conversation-specific session
      const server = await createTerminalMcpServer({
        sessionName: this.conversationId,
      });

      // Create linked transport pair
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();

      // Connect server to its transport
      await server.connect(serverTransport);

      // Create client connected to the other side
      this.terminalMcpClient = await experimental_createMCPClient({
        transport: clientTransport,
      });

      // Get tools from the client
      this.terminalTools = (await this.terminalMcpClient.tools()) as ToolSet;

      console.log(
        `[Session ${this.clientId}] Terminal MCP initialized with session ${this.conversationId}`
      );
    } catch (error) {
      console.error(
        `[Session ${this.clientId}] Failed to initialize Terminal MCP:`,
        error
      );
      throw error;
    }
  }

  /**
   * Initialize Agent MCP client for this session
   */
  private async initializeAgentMcp(): Promise<void> {
    try {
      const server = await createAgentMcpServer({
        agentManager: this.agentManager,
        agentRegistry: this.agentRegistry,
      });

      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();

      await server.connect(serverTransport);

      this.agentMcpClient = await experimental_createMCPClient({
        transport: clientTransport,
      });

      this.agentTools = (await this.agentMcpClient.tools()) as ToolSet;
      const agentToolCount = Object.keys(this.agentTools ?? {}).length;
      console.log(
        `[Session ${this.clientId}] Agent MCP initialized with ${agentToolCount} tools`
      );
    } catch (error) {
      console.error(
        `[Session ${this.clientId}] Failed to initialize Agent MCP:`,
        error
      );
    }
  }

  /**
   * Subscribe to AgentManager events and forward them to the client
   */
  private subscribeToAgentEvents(): void {
    if (this.unsubscribeAgentEvents) {
      this.unsubscribeAgentEvents();
    }

    this.unsubscribeAgentEvents = this.agentManager.subscribe(
      (event) => {
        if (event.type === "agent_state") {
          void this.forwardAgentState(event.agent);
          return;
        }

        const payload = {
          agentId: event.agentId,
          event: serializeAgentStreamEvent(event.event),
          timestamp: new Date().toISOString(),
        } as const;

        this.emit({
          type: "agent_stream",
          payload,
        });

        if (event.event.type === "permission_requested") {
          this.emit({
            type: "agent_permission_request",
            payload: {
              agentId: event.agentId,
              request: event.event.request,
            },
          });
        } else if (event.event.type === "permission_resolved") {
          this.emit({
            type: "agent_permission_resolved",
            payload: {
              agentId: event.agentId,
              requestId: event.event.requestId,
              resolution: event.event.resolution,
            },
          });
        }

        if (
          event.event.type === "timeline" ||
          event.event.type === "turn_completed"
        ) {
          void this.maybeGenerateAgentTitle(event.agentId);
        }
      },
      { replayState: false }
    );
  }

  private async buildAgentPayload(
    agent: AgentSnapshot
  ): Promise<AgentSnapshotPayload> {
    const title = await this.getStoredAgentTitle(agent.id);
    return serializeAgentSnapshot(agent, { title });
  }

  private async forwardAgentState(agent: AgentSnapshot): Promise<void> {
    try {
      const payload = await this.buildAgentPayload(agent);
      this.emit({
        type: "agent_state",
        payload,
      });
    } catch (error) {
      console.error(
        `[Session ${this.clientId}] Failed to emit agent state:`,
        error
      );
    }
  }

  private async getStoredAgentTitle(agentId: string): Promise<string | null> {
    if (this.agentTitleCache.has(agentId)) {
      return this.agentTitleCache.get(agentId) ?? null;
    }

    try {
      const record = await this.agentRegistry.get(agentId);
      const title = record?.title ?? null;
      this.agentTitleCache.set(agentId, title);
      return title;
    } catch (error) {
      console.error(
        `[Session ${this.clientId}] Failed to load registry record for agent ${agentId}:`,
        error
      );
      return null;
    }
  }

  private setCachedTitle(agentId: string, title: string | null): void {
    this.agentTitleCache.set(agentId, title);
  }

  private async maybeGenerateAgentTitle(agentId: string): Promise<void> {
    if (!isTitleGeneratorInitialized()) {
      return;
    }

    const existingTitle = await this.getStoredAgentTitle(agentId);
    if (existingTitle) {
      return;
    }

    if (ACTIVE_TITLE_GENERATIONS.has(agentId)) {
      return;
    }

    const timeline = this.agentManager.getTimeline(agentId);
    if (timeline.length === 0) {
      return;
    }

    const snapshot = this.agentManager.getAgent(agentId);
    if (!snapshot) {
      return;
    }

    ACTIVE_TITLE_GENERATIONS.add(agentId);
    try {
      console.log(
        `[Session ${this.clientId}] Generating title for agent ${agentId}`
      );
      const title = await generateAgentTitle(timeline, snapshot.cwd);
      await this.agentRegistry.setTitle(agentId, title);
      this.setCachedTitle(agentId, title);
      const latest = this.agentManager.getAgent(agentId) ?? snapshot;
      await this.forwardAgentState(latest);
    } catch (error) {
      console.error(
        `[Session ${this.clientId}] Failed to generate title for agent ${agentId}:`,
        error
      );
    } finally {
      ACTIVE_TITLE_GENERATIONS.delete(agentId);
    }
  }

  /**
   * Main entry point for processing session messages
   */
  public async handleMessage(msg: SessionInboundMessage): Promise<void> {
    try {
      switch (msg.type) {
        case "user_text":
          await this.handleUserText(msg.text);
          break;

        case "realtime_audio_chunk":
          await this.handleAudioChunk(msg);
          break;

        case "abort_request":
          await this.handleAbort();
          break;

        case "audio_played":
          this.handleAudioPlayed(msg.id);
          break;

        case "load_conversation_request":
          await this.handleLoadConversation();
          break;

        case "list_conversations_request":
          await this.handleListConversations();
          break;

        case "delete_conversation_request":
          await this.handleDeleteConversation(msg.conversationId);
          break;

        case "set_realtime_mode":
          this.handleSetRealtimeMode(msg.enabled);
          break;

        case "send_agent_message":
          await this.handleSendAgentMessage(
            msg.agentId,
            msg.text,
            msg.messageId,
            msg.images
          );
          break;

        case "send_agent_audio":
          await this.handleSendAgentAudio(msg);
          break;

        case "create_agent_request":
          await this.handleCreateAgentRequest(msg);
          break;

        case "initialize_agent_request":
          await this.handleInitializeAgentRequest(msg.agentId, msg.requestId);
          break;

        case "set_agent_mode":
          await this.handleSetAgentMode(msg.agentId, msg.modeId);
          break;

        case "agent_permission_response":
          await this.handleAgentPermissionResponse(
            msg.agentId,
            msg.requestId,
            msg.response
          );
          break;

        case "git_diff_request":
          await this.handleGitDiffRequest(msg.agentId);
          break;

        case "file_explorer_request":
          await this.handleFileExplorerRequest(msg);
          break;
      }
    } catch (error: any) {
      console.error(
        `[Session ${this.clientId}] Error handling message:`,
        error
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Error: ${error.message}`,
        },
      });
    }
  }

  /**
   * Load existing conversation
   */
  public async handleLoadConversation(): Promise<void> {
    // This is handled during construction, but we emit a confirmation message
    this.emit({
      type: "conversation_loaded",
      payload: {
        conversationId: this.conversationId,
        messageCount: this.messages.length,
      },
    });

    // Send current session state (live agents and commands)
    await this.sendSessionState();
  }

  /**
   * List all conversations
   */
  public async handleListConversations(): Promise<void> {
    try {
      const conversations = await listConversations();
      this.emit({
        type: "list_conversations_response",
        payload: {
          conversations: conversations.map((conv) => ({
            id: conv.id,
            lastUpdated: conv.lastUpdated.toISOString(),
            messageCount: conv.messageCount,
          })),
        },
      });
    } catch (error: any) {
      console.error(
        `[Session ${this.clientId}] Failed to list conversations:`,
        error
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to list conversations: ${error.message}`,
        },
      });
    }
  }

  /**
   * Delete a conversation
   */
  public async handleDeleteConversation(conversationId: string): Promise<void> {
    try {
      await deleteConversation(conversationId);
      this.emit({
        type: "delete_conversation_response",
        payload: {
          conversationId,
          success: true,
        },
      });
      console.log(
        `[Session ${this.clientId}] Deleted conversation ${conversationId}`
      );
    } catch (error: any) {
      console.error(
        `[Session ${this.clientId}] Failed to delete conversation ${conversationId}:`,
        error
      );
      this.emit({
        type: "delete_conversation_response",
        payload: {
          conversationId,
          success: false,
          error: error.message,
        },
      });
    }
  }

  /**
   * Handle realtime mode toggle
   */
  private handleSetRealtimeMode(enabled: boolean): void {
    this.isRealtimeMode = enabled;
    console.log(
      `[Session ${this.clientId}] Realtime mode ${
        enabled ? "enabled" : "disabled"
      }`
    );
  }

  /**
   * Handle text message to agent (with optional image attachments)
   */
  private async handleSendAgentMessage(
    agentId: string,
    text: string,
    _messageId?: string,
    images?: Array<{ data: string; mimeType: string }>
  ): Promise<void> {
    console.log(
      `[Session ${
        this.clientId
      }] Sending text to agent ${agentId}: ${text.substring(0, 50)}...${images && images.length > 0 ? ` with ${images.length} image attachment(s)` : ''}`
    );

    const prompt = this.buildAgentPrompt(text, images);
    this.startAgentStream(agentId, prompt);
  }

  /**
   * Handle audio message to agent (transcribe then send)
   */
  private async handleSendAgentAudio(
    msg: Extract<SessionInboundMessage, { type: "send_agent_audio" }>
  ): Promise<void> {
    const { agentId, audio, format, isLast, requestId } = msg;

    // Decode base64
    const audioBuffer = Buffer.from(audio, "base64");

    // For now, we'll process each audio segment immediately
    // In the future, we might want to buffer chunks similar to realtime audio
    if (!isLast) {
      console.log(
        `[Session ${this.clientId}] Buffering agent audio chunk for agent ${agentId}`
      );
      // TODO: Implement buffering if needed
      return;
    }

    console.log(
      `[Session ${this.clientId}] Transcribing audio for agent ${agentId}`
    );

    try {
      // Transcribe the audio
      const result = await this.sttManager.transcribe(audioBuffer, format);

      const transcriptText = result.text.trim();
      if (!transcriptText) {
        console.log(
          `[Session ${this.clientId}] Empty transcription for agent ${agentId}, ignoring`
        );
        return;
      }

      console.log(
        `[Session ${this.clientId}] Transcribed audio for agent ${agentId}: ${transcriptText}`
      );

      // Emit transcription result to client with requestId
      this.emit({
        type: "transcription_result",
        payload: {
          text: result.text,
          language: result.language,
          duration: result.duration,
          requestId,
        },
      });

      // Send transcribed text to agent
      this.startAgentStream(agentId, transcriptText);
      console.log(
        `[Session ${this.clientId}] Sent transcribed text to agent ${agentId}`
      );
    } catch (error: any) {
      console.error(
        `[Session ${this.clientId}] Failed to process audio for agent ${agentId}:`,
        error
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to process audio for agent: ${error.message}`,
        },
      });
      throw error;
    }
  }

  /**
   * Handle on-demand agent initialization request from client
   */
  private async handleInitializeAgentRequest(
    agentId: string,
    requestId?: string
  ): Promise<void> {
    console.log(
      `[Session ${this.clientId}] Initializing agent ${agentId} on demand`
    );

    try {
      const snapshot = this.agentManager.getAgent(agentId);
      if (!snapshot) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      await this.forwardAgentState(snapshot);

      const timelineSize = this.emitAgentTimelineSnapshot(snapshot);

      if (requestId) {
        this.emit({
          type: "status",
          payload: {
            status: "agent_initialized",
            agentId,
            requestId,
            timelineSize,
          },
        });
      }

      console.log(
        `[Session ${this.clientId}] Agent ${agentId} initialized with ${timelineSize} timeline item(s)`
      );
    } catch (error: any) {
      console.error(
        `[Session ${this.clientId}] Failed to initialize agent ${agentId}:`,
        error
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to initialize agent: ${error.message}`,
        },
      });
    }
  }

  /**
   * Handle create agent request
   */
  private async handleCreateAgentRequest(
    msg: Extract<SessionInboundMessage, { type: "create_agent_request" }>
  ): Promise<void> {
    const { config, worktreeName, requestId } = msg;
    console.log(
      `[Session ${this.clientId}] Creating agent in ${config.cwd} (${config.provider})${
        worktreeName ? ` with worktree ${worktreeName}` : ""
      }`
    );

    try {
      const sessionConfig = await this.buildAgentSessionConfig(
        config,
        worktreeName
      );
      const snapshot = await this.agentManager.createAgent(sessionConfig);
      this.setCachedTitle(snapshot.id, null);
      try {
        await this.agentRegistry.recordConfig(
          snapshot.id,
          snapshot.provider,
          snapshot.cwd,
          {
            modeId: sessionConfig.modeId,
            model: sessionConfig.model,
            extra: sessionConfig.extra,
          }
        );
      } catch (registryError) {
        console.error(
          `[Session ${this.clientId}] Failed to record agent config for ${snapshot.id}:`,
          registryError
        );
      }

      await this.forwardAgentState(snapshot);

      if (requestId) {
        this.emit({
          type: "status",
          payload: {
            status: "agent_created",
            agentId: snapshot.id,
            requestId,
          },
        });
      }

      console.log(
        `[Session ${this.clientId}] Created agent ${snapshot.id} (${snapshot.provider})`
      );
    } catch (error: any) {
      console.error(
        `[Session ${this.clientId}] Failed to create agent:`,
        error
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to create agent: ${error.message}`,
        },
      });
    }
  }

  private async buildAgentSessionConfig(
    config: AgentSessionConfig,
    worktreeName?: string
  ): Promise<AgentSessionConfig> {
    let cwd = expandTilde(config.cwd);

    if (worktreeName) {
      const { createWorktree } = await import("../utils/worktree.js");
      console.log(
        `[Session ${this.clientId}] Creating worktree '${worktreeName}' from ${cwd}`
      );
      const worktreeConfig = await createWorktree({
        branchName: worktreeName,
        cwd,
      });
      cwd = worktreeConfig.worktreePath;
    }

    return {
      ...config,
      cwd,
    };
  }

  /**
   * Handle set agent mode request
   */
  private async handleSetAgentMode(
    agentId: string,
    modeId: string
  ): Promise<void> {
    console.log(
      `[Session ${this.clientId}] Setting agent ${agentId} mode to ${modeId}`
    );

    try {
      await this.agentManager.setAgentMode(agentId, modeId);
      console.log(
        `[Session ${this.clientId}] Agent ${agentId} mode set to ${modeId}`
      );
    } catch (error: any) {
      console.error(
        `[Session ${this.clientId}] Failed to set agent mode:`,
        error
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to set agent mode: ${error.message}`,
        },
      });
      throw error;
    }
  }

  /**
   * Handle agent permission response from user
   */
  private async handleAgentPermissionResponse(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse
  ): Promise<void> {
    console.log(
      `[Session ${this.clientId}] Handling permission response for agent ${agentId}, request ${requestId}`
    );

    try {
      await this.agentManager.respondToPermission(agentId, requestId, response);
      console.log(
        `[Session ${this.clientId}] Permission response forwarded to agent ${agentId}`
      );
    } catch (error: any) {
      console.error(
        `[Session ${this.clientId}] Failed to respond to permission:`,
        error
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to respond to permission: ${error.message}`,
        },
      });
      throw error;
    }
  }

  /**
   * Handle git diff request for an agent
   */
  private async handleGitDiffRequest(agentId: string): Promise<void> {
    console.log(
      `[Session ${this.clientId}] Handling git diff request for agent ${agentId}`
    );

    try {
      const agents = this.agentManager.listAgents();
      const agent = agents.find((a) => a.id === agentId);

      if (!agent) {
        this.emit({
          type: "git_diff_response",
          payload: {
            agentId,
            diff: "",
            error: `Agent not found: ${agentId}`,
          },
        });
        return;
      }

      const { stdout } = await execAsync("git diff HEAD", {
        cwd: agent.cwd,
      });

      this.emit({
        type: "git_diff_response",
        payload: {
          agentId,
          diff: stdout,
          error: null,
        },
      });

      console.log(
        `[Session ${this.clientId}] Git diff for agent ${agentId} completed (${stdout.length} bytes)`
      );
    } catch (error: any) {
      console.error(
        `[Session ${this.clientId}] Failed to get git diff for agent ${agentId}:`,
        error
      );
      this.emit({
        type: "git_diff_response",
        payload: {
          agentId,
          diff: "",
          error: error.message,
        },
      });
    }
  }

  /**
   * Handle read-only file explorer requests scoped to an agent's cwd
   */
  private async handleFileExplorerRequest(
    request: FileExplorerRequest
  ): Promise<void> {
    const { agentId, path: requestedPath = ".", mode } = request;

    console.log(
      `[Session ${this.clientId}] Handling file explorer request for agent ${agentId} (${mode} ${requestedPath})`
    );

    try {
      const agents = this.agentManager.listAgents();
      const agent = agents.find((a) => a.id === agentId);

      if (!agent) {
        this.emit({
          type: "file_explorer_response",
          payload: {
            agentId,
            path: requestedPath,
            mode,
            directory: null,
            file: null,
            error: `Agent not found: ${agentId}`,
          },
        });
        return;
      }

      if (mode === "list") {
        const directory = await listDirectoryEntries({
          root: agent.cwd,
          relativePath: requestedPath,
        });

        this.emit({
          type: "file_explorer_response",
          payload: {
            agentId,
            path: directory.path,
            mode,
            directory,
            file: null,
            error: null,
          },
        });
      } else {
        const file = await readExplorerFile({
          root: agent.cwd,
          relativePath: requestedPath,
        });

        this.emit({
          type: "file_explorer_response",
          payload: {
            agentId,
            path: file.path,
            mode,
            directory: null,
            file,
            error: null,
          },
        });
      }
    } catch (error: any) {
      console.error(
        `[Session ${this.clientId}] Failed to fulfill file explorer request for agent ${agentId}:`,
        error
      );
      this.emit({
        type: "file_explorer_response",
        payload: {
          agentId,
          path: requestedPath,
          mode,
          directory: null,
          file: null,
          error: error.message,
        },
      });
    }
  }

  /**
   * Send current session state (live agents and commands) to client
   */
  private async sendSessionState(): Promise<void> {
    try {
      // Get live agents with session modes
      const agentSnapshots = this.agentManager.listAgents();
      const agents = await Promise.all(
        agentSnapshots.map((agent) => this.buildAgentPayload(agent))
      );

      // Get live commands from terminal manager
      let commands: any[] = [];
      if (this.terminalManager) {
        try {
          commands = await this.terminalManager.listCommands();
        } catch (error) {
          console.error(
            `[Session ${this.clientId}] Failed to list commands:`,
            error
          );
        }
      }

      // Emit session state
      this.emit({
        type: "session_state",
        payload: {
          agents,
          commands,
        },
      });

      console.log(
        `[Session ${this.clientId}] Sent session state: ${agents.length} agents, ${commands.length} commands`
      );

      for (const agent of agentSnapshots) {
        this.emitAgentTimelineSnapshot(agent);
        void this.maybeGenerateAgentTitle(agent.id);
      }
    } catch (error) {
      console.error(
        `[Session ${this.clientId}] Failed to send session state:`,
        error
      );
    }
  }

  private emitAgentTimelineSnapshot(agent: AgentSnapshot): number {
    const timeline = this.agentManager.getTimeline(agent.id);
    if (timeline.length === 0) {
      return 0;
    }

    const events = timeline.map((item) => ({
      event: serializeAgentStreamEvent({
        type: "timeline",
        provider: agent.provider,
        item,
      }),
      timestamp: new Date().toISOString(),
    }));

    this.emit({
      type: "agent_stream_snapshot",
      payload: {
        agentId: agent.id,
        events,
      },
    });

    return timeline.length;
  }

  /**
   * Handle text message from user
   */
  private async handleUserText(text: string): Promise<void> {
    // Abort any in-progress stream immediately
    this.createAbortController();

    // Wait for aborted stream to finish cleanup (save partial response)
    if (this.currentStreamPromise) {
      console.log(
        `[Session ${this.clientId}] Waiting for aborted stream to finish cleanup`
      );
      await this.currentStreamPromise;
      console.log(`[Session ${this.clientId}] Aborted stream finished cleanup`);
    }

    // Emit user message activity log
    this.emit({
      type: "activity_log",
      payload: {
        id: uuidv4(),
        timestamp: new Date(),
        type: "transcript",
        content: text,
      },
    });

    // Add to conversation
    this.messages.push({ role: "user", content: text });

    // Process through LLM (TTS enabled in realtime mode for voice conversations)
    this.currentStreamPromise = this.processWithLLM(this.isRealtimeMode);
    await this.currentStreamPromise;
  }

  /**
   * Handle audio chunk for buffering and transcription
   */
  private async handleAudioChunk(
    msg: Extract<SessionInboundMessage, { type: "realtime_audio_chunk" }>
  ): Promise<void> {
    // Decode base64
    const audioBuffer = Buffer.from(msg.audio, "base64");

    if (!msg.isLast) {
      // Buffer the chunk
      if (!this.audioBuffer) {
        this.audioBuffer = { chunks: [], format: msg.format };
      }
      this.audioBuffer.chunks.push(audioBuffer);
      console.log(
        `[Session ${this.clientId}] Buffered audio chunk (${audioBuffer.length} bytes, total: ${this.audioBuffer.chunks.length})`
      );
    } else {
      // Complete segment received
      const allChunks = this.audioBuffer
        ? [...this.audioBuffer.chunks, audioBuffer]
        : [audioBuffer];
      const format = this.audioBuffer?.format || msg.format;
      const currentSegmentAudio = Buffer.concat(allChunks);

      console.log(
        `[Session ${this.clientId}] Complete audio segment (${currentSegmentAudio.length} bytes, ${allChunks.length} chunks)`
      );

      // Clear chunk buffer
      this.audioBuffer = null;

      // Decision: buffer or process?
      const shouldBuffer =
        this.processingPhase === "transcribing" &&
        this.pendingAudioSegments.length === 0;

      if (shouldBuffer) {
        // Currently transcribing first segment - buffer this one
        console.log(
          `[Session ${this.clientId}] Buffering audio segment (phase: ${this.processingPhase})`
        );
        this.pendingAudioSegments.push({
          audio: currentSegmentAudio,
          format,
        });
        this.setBufferTimeout();
      } else if (this.pendingAudioSegments.length > 0) {
        // We have buffered segments - add this one and process all together
        this.pendingAudioSegments.push({
          audio: currentSegmentAudio,
          format,
        });
        console.log(
          `[Session ${this.clientId}] Processing ${this.pendingAudioSegments.length} buffered segments together`
        );

        // Clear pending segments and timeout
        const pendingSegments = [...this.pendingAudioSegments];
        this.pendingAudioSegments = [];
        this.clearBufferTimeout();

        // Concatenate all segments
        const allSegmentAudios = pendingSegments.map((s) => s.audio);
        const combinedAudio = Buffer.concat(allSegmentAudios);

        await this.processAudio(combinedAudio, format);
      } else {
        // Normal flow - no buffering needed
        await this.processAudio(currentSegmentAudio, format);
      }
    }
  }

  /**
   * Process audio through STT and then LLM
   */
  private async processAudio(audio: Buffer, format: string): Promise<void> {
    this.setPhase("transcribing");

    this.emit({
      type: "activity_log",
      payload: {
        id: uuidv4(),
        timestamp: new Date(),
        type: "system",
        content: "Transcribing audio...",
      },
    });

    try {
      const result = await this.sttManager.transcribe(audio, format);

      const transcriptText = result.text.trim();
      if (!transcriptText) {
        console.log(
          `[Session ${this.clientId}] Empty transcription (false positive), not aborting`
        );
        this.setPhase("idle");
        return;
      }

      // Has content - abort any in-progress stream now
      this.createAbortController();

      // Wait for aborted stream to finish cleanup (save partial response)
      if (this.currentStreamPromise) {
        console.log(
          `[Session ${this.clientId}] Waiting for aborted stream to finish cleanup`
        );
        await this.currentStreamPromise;
      }

      // Emit transcription result
      this.emit({
        type: "transcription_result",
        payload: {
          text: result.text,
          language: result.language,
          duration: result.duration,
        },
      });

      // Emit activity log
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "transcript",
          content: result.text,
          metadata: {
            language: result.language,
            duration: result.duration,
          },
        },
      });

      // Add to conversation
      this.messages.push({ role: "user", content: result.text });

      // Set phase to LLM and process (TTS enabled in realtime mode for voice conversations)
      this.setPhase("llm");
      this.currentStreamPromise = this.processWithLLM(this.isRealtimeMode);
      await this.currentStreamPromise;
      this.setPhase("idle");
    } catch (error: any) {
      this.setPhase("idle");
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Transcription error: ${error.message}`,
        },
      });
      throw error;
    }
  }

  /**
   * Process user message through LLM with streaming and tool execution
   */
  private async processWithLLM(enableTTS: boolean): Promise<void> {
    let assistantResponse = "";
    let pendingTTS: Promise<void> | null = null;
    let textBuffer = "";

    const flushTextBuffer = () => {
      if (textBuffer.length > 0) {
        // TTS handling (capture mode at generation time for drift protection)
        if (enableTTS) {
          const modeAtGeneration = this.isRealtimeMode;
          pendingTTS = this.ttsManager.generateAndWaitForPlayback(
            textBuffer,
            (msg) => this.emit(msg),
            this.abortController.signal,
            modeAtGeneration
          );
        }

        // Emit activity log
        this.emit({
          type: "activity_log",
          payload: {
            id: uuidv4(),
            timestamp: new Date(),
            type: "assistant",
            content: textBuffer,
          },
        });
      }
      textBuffer = "";
    };

    try {
      // Debug: dump conversation before LLM call
      await this.dumpConversation();

      invariant(
        process.env.OPENROUTER_API_KEY,
        "OPENROUTER_API_KEY is required"
      );

      const openrouter = createOpenRouter({
        apiKey: process.env.OPENROUTER_API_KEY,
      });

      // Wait for terminal MCP to initialize if needed
      if (!this.terminalTools) {
        console.log(
          `[Session ${this.clientId}] Waiting for terminal MCP initialization...`
        );
        // Wait up to 5 seconds for initialization
        const startTime = Date.now();
        while (!this.terminalTools && Date.now() - startTime < 5000) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!this.terminalTools) {
          throw new Error("Terminal MCP failed to initialize");
        }
      }

      if (!this.agentTools) {
        console.log(
          `[Session ${this.clientId}] Waiting for agent MCP initialization...`
        );
        const startTime = Date.now();
        while (!this.agentTools && Date.now() - startTime < 5000) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!this.agentTools) {
          console.log(
            `[Session ${this.clientId}] Agent MCP tools unavailable; continuing with default tool set`
          );
        }
      }

      const allTools = await getAllTools(this.terminalTools, this.agentTools ?? undefined);

      const result = await streamText({
        model: openrouter("anthropic/claude-haiku-4.5"),
        system: getSystemPrompt(),
        providerOptions: {
          openrouter: {
            transforms: ["middle-out"], // Compress prompts that are > context size.
          } as OpenRouterProviderOptions,
        },
        messages: this.messages,
        tools: allTools,
        abortSignal: this.abortController.signal,
        onFinish: async (event) => {
          const newMessages = event.response.messages;
          if (newMessages.length > 0) {
            this.messages.push(...newMessages);
            console.log(
              `[Session ${this.clientId}] onFinish - saved message with ${newMessages.length} steps`
            );
          }

          // Persist conversation to disk
          try {
            await saveConversation(this.conversationId, this.messages);
          } catch (error) {
            console.error(
              `[Session ${this.clientId}] Failed to persist conversation:`,
              error
            );
            // Don't break conversation flow on persistence errors
          }
        },
        onChunk: async ({ chunk }) => {
          if (chunk.type === "text-delta") {
            // Accumulate text in buffer
            textBuffer += chunk.text;
            assistantResponse += chunk.text;

            // Emit chunk for UI streaming
            this.emit({
              type: "assistant_chunk",
              payload: { chunk: chunk.text },
            });
          } else if (chunk.type === "tool-call") {
            // Flush accumulated text as a segment before tool call
            flushTextBuffer();

            // Wait for pending TTS before executing tool
            if (pendingTTS) {
              console.log(
                `[Session ${this.clientId}] Waiting for TTS before executing ${chunk.toolName}`
              );
              await pendingTTS;
            }

            // Handle present_artifact tool specially
            if (chunk.toolName === "present_artifact") {
              await this.handlePresentArtifact(
                chunk.toolCallId,
                chunk.input as PresentArtifactArgs
              );
            }

            // Emit tool call activity log
            this.emit({
              type: "activity_log",
              payload: {
                id: chunk.toolCallId,
                timestamp: new Date(),
                type: "tool_call",
                content: `Calling ${chunk.toolName}`,
                metadata: {
                  toolCallId: chunk.toolCallId,
                  toolName: chunk.toolName,
                  arguments: chunk.input,
                },
              },
            });
          } else if (chunk.type === "tool-result") {
            // Check if this is a create_coding_agent result
            if (chunk.toolName === "create_coding_agent" && chunk.output) {
              const result = chunk.output as any;
              if (result.structuredContent?.agentId) {
                const agentId = result.structuredContent.agentId;
                this.emit({
                  type: "status",
                  payload: {
                    status: "agent_created",
                    agentId,
                  },
                });
              }
            }

            // Emit tool result event
            this.emit({
              type: "activity_log",
              payload: {
                id: chunk.toolCallId,
                timestamp: new Date(),
                type: "tool_result",
                content: `Tool ${chunk.toolName} completed`,
                metadata: {
                  toolCallId: chunk.toolCallId,
                  toolName: chunk.toolName,
                  result: chunk.output,
                },
              },
            });
          }
        },
        onError: async (error) => {
          console.error(error);

          this.emit({
            type: "activity_log",
            payload: {
              id: uuidv4(),
              timestamp: new Date(),
              type: "error",
              content: `Stream error: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          });
        },
        stopWhen: stepCountIs(10),
      });

      // Consume the fullStream to handle tool-error chunks
      for await (const part of result.fullStream) {
        if (part.type === "tool-error") {
          this.emit({
            type: "activity_log",
            payload: {
              id: part.toolCallId,
              timestamp: new Date(),
              type: "error",
              content: `Tool ${part.toolName} failed: ${
                part.error instanceof Error
                  ? part.error.message
                  : String(part.error)
              }`,
              metadata: {
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                error: part.error,
              },
            },
          });
        }
      }

      // Flush any remaining text at the end
      flushTextBuffer();

      // Note: Message is saved by onFinish callback with proper tool calls

      // Now wait for any pending TTS, but don't fail if it times out
      if (pendingTTS) {
        try {
          await pendingTTS;
        } catch (ttsError) {
          console.error(
            `[Session ${this.clientId}] TTS playback failed (message already saved):`,
            ttsError
          );
        }
      }
    } catch (error) {
      // Note: Partial messages are saved by onAbort callback with proper tool calls

      // Check if this is an abort error
      const isAbortError =
        error instanceof Error && error.name === "AbortError";

      // Only emit error log for non-abort errors
      if (!isAbortError) {
        this.emit({
          type: "activity_log",
          payload: {
            id: uuidv4(),
            timestamp: new Date(),
            type: "error",
            content: `Error: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        });
      }

      // Don't re-throw abort errors (they're expected during interruptions)
      if (isAbortError) {
        console.log(
          `[Session ${this.clientId}] Stream aborted (partial response saved)`
        );
        return;
      }

      // Re-throw unexpected errors
      throw error;
    } finally {
      // Increment turn index for next LLM call
      this.turnIndex++;

      // Clear the stream promise tracker
      this.currentStreamPromise = null;
    }
  }

  /**
   * Handle present_artifact tool execution
   */
  private async handlePresentArtifact(
    toolCallId: string,
    args: PresentArtifactArgs
  ): Promise<void> {
    let content: string;
    let isBase64 = false;

    try {
      if (args.source.type === "file") {
        const fileBuffer = await readFile(args.source.path);
        content = fileBuffer.toString("base64");
        isBase64 = true;
      } else if (args.source.type === "command_output") {
        const { stdout } = await execAsync(args.source.command, {
          encoding: "buffer",
        });
        content = stdout.toString("base64");
        isBase64 = true;
      } else if (args.source.type === "text") {
        content = args.source.text;
        isBase64 = false;
      } else {
        content = "[Unknown source type]";
        isBase64 = false;
      }
    } catch (error) {
      console.error(
        `[Session ${this.clientId}] Failed to resolve artifact source:`,
        error
      );
      content = `[Error: ${
        error instanceof Error ? error.message : String(error)
      }]`;
      isBase64 = false;
    }

    // Emit artifact message
    this.emit({
      type: "artifact",
      payload: {
        type: args.type,
        id: toolCallId,
        title: args.title,
        content,
        isBase64,
      },
    });

    // Emit activity log for artifact
    this.emit({
      type: "activity_log",
      payload: {
        id: toolCallId,
        timestamp: new Date(),
        type: "system",
        content: `${args.type} artifact: ${args.title}`,
        metadata: { artifactId: toolCallId, artifactType: args.type },
      },
    });
  }

  /**
   * Handle abort request from client
   */
  private async handleAbort(): Promise<void> {
    console.log(
      `[Session ${this.clientId}] Abort request, phase: ${this.processingPhase}`
    );

    if (this.processingPhase === "llm") {
      // Already in LLM phase - abort and wait for cleanup
      this.abortController.abort();
      console.log(`[Session ${this.clientId}] Aborted LLM processing`);

      // Wait for stream to finish saving partial response
      if (this.currentStreamPromise) {
        console.log(
          `[Session ${this.clientId}] Waiting for stream cleanup after abort`
        );
        await this.currentStreamPromise;
      }

      // Reset phase to idle
      this.setPhase("idle");

      // Clear any pending segments and timeouts
      this.pendingAudioSegments = [];
      this.clearBufferTimeout();
    } else if (this.processingPhase === "transcribing") {
      // Still in STT phase - we'll buffer the next audio
      console.log(
        `[Session ${this.clientId}] Will buffer next audio (currently transcribing)`
      );
      // Phase stays as 'transcribing', handleAudioChunk will handle buffering
    }
    // If idle, nothing to do
  }

  /**
   * Handle audio playback confirmation from client
   */
  private handleAudioPlayed(id: string): void {
    this.ttsManager.confirmAudioPlayed(id);
  }

  /**
   * Create new AbortController, aborting the previous one
   */
  private createAbortController(): AbortController {
    this.abortController.abort();
    this.abortController = new AbortController();
    return this.abortController;
  }

  /**
   * Set the processing phase
   */
  private setPhase(phase: ProcessingPhase): void {
    this.processingPhase = phase;
    console.log(`[Session ${this.clientId}] Phase: ${phase}`);
  }

  /**
   * Set timeout to process buffered audio segments
   */
  private setBufferTimeout(): void {
    this.clearBufferTimeout();

    this.bufferTimeout = setTimeout(async () => {
      console.log(
        `[Session ${this.clientId}] Buffer timeout reached, processing pending segments`
      );

      if (this.pendingAudioSegments.length > 0) {
        const segments = [...this.pendingAudioSegments];
        this.pendingAudioSegments = [];
        this.bufferTimeout = null;

        const combined = Buffer.concat(segments.map((s) => s.audio));
        await this.processAudio(combined, segments[0].format);
      }
    }, 10000); // 10 second timeout
  }

  /**
   * Clear buffer timeout
   */
  private clearBufferTimeout(): void {
    if (this.bufferTimeout) {
      clearTimeout(this.bufferTimeout);
      this.bufferTimeout = null;
    }
  }

  /**
   * Emit a message to the client
   */
  private emit(msg: SessionOutboundMessage): void {
    this.onMessage(msg);
  }

  /**
   * Debug helper: dump conversation to disk
   */
  private async dumpConversation(): Promise<void> {
    try {
      const dumpDir = join(process.cwd(), ".debug.conversations");
      await mkdir(dumpDir, { recursive: true });

      const filename = `${this.conversationId}-${this.turnIndex}.json`;
      const filepath = join(dumpDir, filename);

      const dump = {
        conversationId: this.conversationId,
        turnIndex: this.turnIndex,
        timestamp: new Date().toISOString(),
        messages: this.messages,
      };

      await writeFile(filepath, inspect(dump, { depth: null }), "utf-8");
      console.log(
        `[Session ${this.clientId}] Dumped conversation to ${filepath}`
      );
    } catch (error) {
      console.error(
        `[Session ${this.clientId}] Failed to dump conversation:`,
        error
      );
    }
  }

  /**
   * Clean up session resources
   */
  public async cleanup(): Promise<void> {
    console.log(`[Session ${this.clientId}] Cleaning up`);

    if (this.unsubscribeAgentEvents) {
      this.unsubscribeAgentEvents();
      this.unsubscribeAgentEvents = null;
    }

    // Abort any ongoing operations
    this.abortController.abort();

    // Clear timeouts
    this.clearBufferTimeout();

    // Clear buffers
    this.pendingAudioSegments = [];
    this.audioBuffer = null;

    // Cleanup managers
    this.ttsManager.cleanup();
    this.sttManager.cleanup();

    // Kill tmux session for this conversation
    try {
      console.log(
        `[Session ${this.clientId}] Killing tmux session ${this.conversationId}`
      );
      await execAsync(`tmux kill-session -t ${this.conversationId}`);
      console.log(
        `[Session ${this.clientId}] Tmux session ${this.conversationId} killed`
      );
    } catch (error) {
      // Session might not exist or already be killed - that's okay
      console.log(
        `[Session ${this.clientId}] Tmux session cleanup (session may not exist):`,
        error instanceof Error ? error.message : String(error)
      );
    }

    // Close MCP clients
    if (this.terminalMcpClient) {
      try {
        await this.terminalMcpClient.close();
        console.log(`[Session ${this.clientId}] Terminal MCP client closed`);
      } catch (error) {
        console.error(
          `[Session ${this.clientId}] Failed to close Terminal MCP client:`,
          error
        );
      }
    }

    if (this.agentMcpClient) {
      try {
        await this.agentMcpClient.close();
        console.log(`[Session ${this.clientId}] Agent MCP client closed`);
      } catch (error) {
        console.error(
          `[Session ${this.clientId}] Failed to close Agent MCP client:`,
          error
        );
      }
      this.agentMcpClient = null;
      this.agentTools = null;
    }

  }
}
