import { randomUUID } from "node:crypto";
import os from "node:os";
import type { Logger } from "pino";

import type {
  AgentPermissionResponse,
  AgentProvider,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import { PASEO_MCP_SERVER_NAME } from "../agent/runtime-mcp-config.js";
import {
  asAgentRealtimeVoiceSession,
  type AgentRealtimeVoiceEvent,
  type AgentRealtimeVoiceSession,
} from "../agent/agent-realtime-voice.js";
import type { LiveVoiceStartContext } from "./live-voice-context.js";
import type { LiveVoiceHostProfile } from "./live-voice-host-profile.js";
import {
  LiveVoiceRouteBroker,
  type LiveVoiceRouteObservation,
  type LiveVoiceRouteRegistration,
} from "./live-voice-route-broker.js";
import { LIVE_VOICE_ROUTING_TOOLS } from "./live-voice-routing-tools.js";
import {
  AssistantStoreError,
  type AssistantStore,
  type AssistantCallHandle,
} from "../assistants/assistant-store.js";
import { buildAssistantContext } from "../assistants/assistant-context.js";

/** How long to wait for the provider's async answer-SDP notification before giving up. */
const START_SDP_TIMEOUT_MS = 30_000;

/** Shows up only in daemon logs and internal listings — the host session is hidden. */
const HOST_TITLE = "Live Voice host";

/**
 * A provider may route realtime delegations into separate turns on the host
 * thread, so the backend executor gets the shared Live Voice prompt plus this
 * block. It restates the rules that matter most when the executor acts on its
 * own: the user is waiting on a live call, and everything must stay
 * Paseo-visible.
 */
const BACKEND_EXECUTOR_INSTRUCTIONS = [
  "Delegations arrive here from a live voice call while the user waits, so:",
  "- You are the user's chief of staff, not one of their workers. Your job is to be an intermediary to their full text-based agent sessions: route work to them through Paseo's tools and report back. Never code, edit files, or run project commands yourself.",
  "- Every agent you start must be started through Paseo so it is visible in the Paseo UI. Never create an agent any other way.",
  "- For a status question, read first: the answer is usually already in the session's existing output via get_agent_activity, get_agent_status, and list_pending_permissions. Prompt a session only when reading cannot answer.",
  "- Be quick. The user is on a live call: return a useful answer from what you can read fast, start anything slow in the background and say you did, and never leave them waiting on a long turn.",
].join("\n");

export type LiveVoiceStartErrorCode =
  | "busy"
  | "assistant_busy"
  | "not_found"
  | "unsupported"
  | "paseo_tools_disabled"
  | "start_failed";

export type LiveVoiceCloseCause =
  | "assistant_deleted"
  | "requested"
  | "owner_disconnected"
  | "error"
  | "provider_closed"
  | "provider_exit"
  | "host_session_closed"
  | "daemon_shutdown"
  | "start_failed";

/**
 * Causes where the provider session is still usable, so we tell it to tear
 * down its realtime session. `host_session_closed` qualifies: `onAgentClosing`
 * fires before the provider session is disposed, so the stop still has a live
 * transport and keeps the upstream realtime session from outliving a stalled
 * teardown. The remaining causes mean the provider already ended the session
 * (`provider_closed`) or its transport is gone (`provider_exit`) — calling
 * `realtimeStop()` there would respawn the provider process.
 */
const CAUSES_REQUIRING_PROVIDER_STOP: ReadonlySet<LiveVoiceCloseCause> = new Set([
  "assistant_deleted",
  "requested",
  "owner_disconnected",
  "error",
  "start_failed",
  "host_session_closed",
  "daemon_shutdown",
]);

/** Mirrors the protocol's `VoiceLiveEventSchema` union. */
export type LiveVoiceUpdateEvent =
  | { kind: "started" }
  | { kind: "transcript"; role: "user" | "assistant"; transcriptId: string; text: string }
  | { kind: "error"; code: string; message: string; fatal: boolean }
  | { kind: "closed"; cause: string; detail?: string };

export interface LiveVoiceUpdate {
  liveSessionId: string;
  seq: number;
  event: LiveVoiceUpdateEvent;
}

/**
 * Identifies the reconnectable client session that owns a call. The media path
 * can remain active while a mobile client's physical control socket is absent.
 */
export interface LiveVoiceOwner {
  readonly sessionKey: object;
  readonly principalId?: string;
}

export interface LiveVoiceStartRequest {
  assistantId?: string;
  offerSdp: string;
  voice?: string;
  owner: LiveVoiceOwner;
  emit: (update: LiveVoiceUpdate) => void;
  sendRouteRequest?: LiveVoiceRouteRegistration["send"];
  /** The client will report agents this call did not start; tell the model so. */
  ambientAgentReports?: boolean;
  /** The user's standing instruction for those reports. */
  ambientAgentGuidance?: string | undefined;
  /** Prompt component ids the user turned off. The context builder validates them. */
  disabledPromptComponents?: readonly string[] | undefined;
  /** The user's standing instructions for the whole call, verbatim. */
  customVoiceInstructions?: string | undefined;
  /** Where new workspaces go when a request names no workspace of its own. */
  defaultWorkspaceDirectory?: string | undefined;
  /** Backend-executor model override; absent uses the daemon's fast default. */
  backendModel?: string | undefined;
  backendThinkingOptionId?: string | undefined;
}

/** What the coordinator hands the context builder for one call. */
export interface LiveVoiceContextBuildOptions {
  crossHostRoutingAvailable: boolean;
  /** The host profile's accounting, so the snapshot budget matches the provider. */
  limits?: LiveVoiceHostProfile["contextLimits"];
  ambientAgentReports?: boolean;
  ambientAgentGuidance?: string | undefined;
  disabledPromptComponents?: readonly string[] | undefined;
  customVoiceInstructions?: string | undefined;
  defaultWorkspaceDirectory?: string | undefined;
}

/** Only the fields the context builder reads, with absent ones dropped. */
function toContextBuildOptions(
  request: LiveVoiceStartRequest,
  limits: LiveVoiceHostProfile["contextLimits"],
): LiveVoiceContextBuildOptions {
  return {
    crossHostRoutingAvailable: request.sendRouteRequest !== undefined,
    limits,
    ...(request.ambientAgentReports ? { ambientAgentReports: true } : {}),
    ...(request.ambientAgentGuidance ? { ambientAgentGuidance: request.ambientAgentGuidance } : {}),
    ...(request.disabledPromptComponents?.length
      ? { disabledPromptComponents: request.disabledPromptComponents }
      : {}),
    ...(request.customVoiceInstructions
      ? { customVoiceInstructions: request.customVoiceInstructions }
      : {}),
    ...(request.defaultWorkspaceDirectory
      ? { defaultWorkspaceDirectory: request.defaultWorkspaceDirectory }
      : {}),
  };
}

export type LiveVoiceStartResult =
  | { accepted: true; liveSessionId: string; answerSdp: string }
  | { accepted: false; errorCode: LiveVoiceStartErrorCode; errorMessage: string };

/** The agent-manager surface used to spawn and dispose host sessions. */
export interface LiveVoiceHostAgent {
  id: string;
  capabilities: { readonly [capability: string]: boolean | undefined };
  session: unknown;
}

interface LiveVoiceHostSession extends AgentRealtimeVoiceSession {
  subscribe(callback: (event: AgentStreamEvent) => void): () => void;
  respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<unknown>;
}

function asLiveVoiceHostSession(value: unknown): LiveVoiceHostSession | null {
  const realtime = asAgentRealtimeVoiceSession(value);
  if (!realtime || value == null || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<LiveVoiceHostSession>;
  return typeof candidate.subscribe === "function" &&
    typeof candidate.respondToPermission === "function"
    ? (candidate as LiveVoiceHostSession)
    : null;
}

/**
 * The slice of the agent manager the coordinator needs. `AgentManager` satisfies
 * it structurally; tests supply a minimal fake.
 */
export interface LiveVoiceAgentSource {
  hasPaseoMcpInjection(provider?: AgentProvider, requiredTools?: readonly string[]): boolean;
  getProviderAvailability(
    provider: AgentProvider,
  ): Promise<{ available: boolean; error?: string | null }>;
  createAgent(
    config: AgentSessionConfig,
    agentId: string | undefined,
    options: { workspaceId: string | undefined; initialTitle?: string | null },
  ): Promise<LiveVoiceHostAgent>;
  closeAgent(agentId: string): Promise<void>;
  onAgentClosing(callback: (agentId: string) => void): () => void;
}

interface LiveVoiceCall {
  assistant: AssistantCallHandle | null;
  readonly liveSessionId: string;
  readonly owner: LiveVoiceOwner;
  readonly emit: (update: LiveVoiceUpdate) => void;
  /** Both are filled once the host session is up; null while it is being spawned. */
  hostAgentId: string | null;
  provider: AgentRealtimeVoiceSession | null;
  state: "starting" | "active" | "stopping" | "closed";
  seq: number;
  unsubscribeRealtime: (() => void) | null;
  unsubscribeHost: (() => void) | null;
  deniedHostPermissionIds: Set<string>;
  startTimer: NodeJS.Timeout | null;
  /**
   * A provider may answer `realtimeStart` with an empty result and deliver the
   * answer SDP as a separate event, which can land before or after that
   * result. Buffer whichever arrives first.
   */
  bufferedAnswerSdp: string | null;
  sdpWaiter: { resolve: (sdp: string) => void; reject: (error: Error) => void } | null;
  unregisterRoute: (() => void) | null;
  /**
   * Timing diagnostics. Transcript arrival is the closest external proxy for
   * when a party finished speaking; the gap from here to the next routed tool
   * call brackets everything opaque — turn detection, model thinking, and
   * argument generation. Best-effort: transcripts can arrive late or not at
   * all, so a missing timestamp just omits the derived field from the log.
   */
  lastUserTranscriptAt: number | null;
  lastAssistantTranscriptAt: number | null;
  lastRoutedToolEndAt: number | null;
}

/**
 * Supplies the Paseo prompt and state snapshot handed to the voice model at
 * start. Optional: without it the provider falls back to its own startup
 * context, which yields a working but Paseo-unaware call.
 */
export interface LiveVoiceContextProvider {
  build(options?: LiveVoiceContextBuildOptions): Promise<LiveVoiceStartContext | null>;
}

export interface LiveVoiceCoordinatorOptions {
  assistantStore?: AssistantStore;
  agents: LiveVoiceAgentSource;
  logger: Logger;
  /** The provider adapter that hosts calls on this daemon. */
  hostProfile: LiveVoiceHostProfile;
  startSdpTimeoutMs?: number;
  context?: LiveVoiceContextProvider;
  routeBroker: LiveVoiceRouteBroker;
  createHostAgentId?: () => string;
  /** Where the host session runs. Neutral by design — it is not a project session. */
  hostCwd?: string;
}

/** Start failure that means this daemon cannot host live voice at all. */
class LiveVoiceUnsupportedError extends Error {
  readonly name = "LiveVoiceUnsupportedError";
}

/** Start refusal for a user-actionable daemon setting, distinct from provider support. */
class LiveVoicePaseoToolsDisabledError extends Error {
  readonly name = "LiveVoicePaseoToolsDisabledError";
}

function resolveStartErrorCode(error: unknown): LiveVoiceStartErrorCode {
  if (
    error instanceof AssistantStoreError &&
    (error.code === "assistant_busy" || error.code === "not_found")
  )
    return error.code;
  if (error instanceof LiveVoiceUnsupportedError) return "unsupported";
  if (error instanceof LiveVoicePaseoToolsDisabledError) return "paseo_tools_disabled";
  return "start_failed";
}

/**
 * Daemon-global owner of Live Voice calls. A call is not attached to an agent:
 * each one spawns its own hidden host session to run the realtime conversation
 * on, so concurrent calls from different clients never share a provider thread
 * (a provider may silently replace an existing realtime session when a second
 * `realtimeStart` lands on the same thread). One call per client session.
 */
export class LiveVoiceCoordinator {
  private readonly assistantStore: AssistantStore | undefined;
  private readonly calls = new Map<string, LiveVoiceCall>();
  private readonly agents: LiveVoiceAgentSource;
  private readonly logger: Logger;
  private readonly hostProfile: LiveVoiceHostProfile;
  private readonly startSdpTimeoutMs: number;
  private readonly context: LiveVoiceContextProvider | null;
  private readonly routeBroker: LiveVoiceRouteBroker;
  private readonly createHostAgentId: () => string;
  private readonly hostCwd: string;
  private readonly unsubscribeAgentClosing: () => void;

  constructor(options: LiveVoiceCoordinatorOptions) {
    this.assistantStore = options.assistantStore;
    this.agents = options.agents;
    this.logger = options.logger.child({ module: "live-voice" });
    this.hostProfile = options.hostProfile;
    this.startSdpTimeoutMs = options.startSdpTimeoutMs ?? START_SDP_TIMEOUT_MS;
    this.context = options.context ?? null;
    this.routeBroker = options.routeBroker;
    this.createHostAgentId = options.createHostAgentId ?? randomUUID;
    this.hostCwd = options.hostCwd ?? os.homedir();
    this.unsubscribeAgentClosing = this.agents.onAgentClosing((agentId) => {
      this.closeForHostAgent(agentId, "host_session_closed");
    });
  }

  async start(request: LiveVoiceStartRequest): Promise<LiveVoiceStartResult> {
    if (this.findCallForSession(request.owner.sessionKey)) {
      return {
        accepted: false,
        errorCode: "busy",
        errorMessage: "This client already has a live voice call.",
      };
    }

    // Registered synchronously — everything above is sync, so no second start
    // from the same client session can interleave before the map entry exists, and a
    // close arriving while the host spawns finds a call to close.
    const call: LiveVoiceCall = {
      assistant: null,
      liveSessionId: randomUUID(),
      owner: request.owner,
      emit: request.emit,
      hostAgentId: null,
      provider: null,
      state: "starting",
      seq: 0,
      unsubscribeRealtime: null,
      unsubscribeHost: null,
      deniedHostPermissionIds: new Set(),
      startTimer: null,
      bufferedAnswerSdp: null,
      sdpWaiter: null,
      unregisterRoute: null,
      lastUserTranscriptAt: null,
      lastAssistantTranscriptAt: null,
      lastRoutedToolEndAt: null,
    };
    this.calls.set(call.liveSessionId, call);

    try {
      if (request.assistantId) {
        if (!this.assistantStore || !request.owner.principalId)
          throw new AssistantStoreError("not_found", "Assistant ownership is unavailable");
        call.assistant = await this.assistantStore.openCall(
          request.owner.principalId,
          request.assistantId,
          call.liveSessionId,
          () => this.close(call, "assistant_deleted"),
        );
        if (call.state !== "starting") {
          await call.assistant.close("start_failed");
          throw new Error("Live voice call closed while loading assistant");
        }
        const configuration = call.assistant.assistant.configuration;
        const {
          voice: _voice,
          backendModel: _model,
          backendThinkingOptionId: _thinking,
          customVoiceInstructions: _instructions,
          ...rest
        } = request;
        request = {
          ...rest,
          ...(configuration.voice ? { voice: configuration.voice } : {}),
          ...(configuration.backendModel ? { backendModel: configuration.backendModel } : {}),
          ...(configuration.backendThinkingOptionId
            ? { backendThinkingOptionId: configuration.backendThinkingOptionId }
            : {}),
          customVoiceInstructions: configuration.instructions,
        };
      }
      const host = await this.spawnHostSession(call, request);
      if (call.state !== "starting" || this.calls.get(call.liveSessionId) !== call) {
        // The call was torn down while the host was still spawning; the host is
        // ours alone, so it dies with the call rather than leaking.
        this.disposeHostSession(host.agentId);
        throw new Error("Live voice call closed during startup");
      }
      call.hostAgentId = host.agentId;
      call.provider = host.provider;
      call.unsubscribeHost = host.provider.subscribe((event) => {
        this.handleHostEvent(call, host.provider, event);
      });
      call.unsubscribeRealtime = host.provider.subscribeRealtimeEvents((event) => {
        this.handleRealtimeEvent(call, event);
      });

      const answerSdp = await this.performHandshake(call, host.provider, request, host.context);
      if (call.state !== "starting" || this.calls.get(call.liveSessionId) !== call) {
        // A terminal cause landed between the SDP arriving and this resumption;
        // the call is already gone and must not be resurrected.
        throw new Error("Live voice call closed during startup");
      }
      call.state = "active";
      this.publish(call, { kind: "started" });
      this.logger.info(
        { liveSessionId: call.liveSessionId, hostAgentId: call.hostAgentId },
        "live_voice.call.started",
      );
      return { accepted: true, liveSessionId: call.liveSessionId, answerSdp };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.close(call, "start_failed", errorMessage);
      this.logger.warn(
        { err: error, liveSessionId: call.liveSessionId },
        "live_voice.call.start_failed",
      );
      return {
        accepted: false,
        errorCode: resolveStartErrorCode(error),
        errorMessage,
      };
    }
  }

  /**
   * Speaks something into a running call from outside the conversation. The
   * caller must be the client session that owns the call: a client may only put words
   * in the mouth of its own call, never another client's.
   */
  async say(params: {
    liveSessionId: string;
    sessionKey: object;
    text: string;
  }): Promise<{ delivered: true } | { delivered: false; errorCode: string; errorMessage: string }> {
    const call = this.calls.get(params.liveSessionId);
    if (!call || call.owner.sessionKey !== params.sessionKey) {
      return {
        delivered: false,
        errorCode: "unknown_call",
        errorMessage: "This client does not own a live voice call with that id.",
      };
    }
    if (call.state !== "active" || !call.provider) {
      return {
        delivered: false,
        errorCode: "call_not_active",
        errorMessage: "The live voice call is not active.",
      };
    }
    try {
      await call.provider.realtimeAppendText({ text: params.text, role: "developer" });
      return { delivered: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        { err: error, liveSessionId: call.liveSessionId },
        "live_voice.say.append_failed",
      );
      return { delivered: false, errorCode: "append_failed", errorMessage };
    }
  }

  stop(params: { liveSessionId: string; sessionKey: object }): void {
    const call = this.calls.get(params.liveSessionId);
    // A stop for an already-closed call is a no-op; the caller still gets a
    // response.
    if (!call || call.owner.sessionKey !== params.sessionKey) {
      return;
    }
    this.close(call, "requested");
  }

  /** Teardown when the whole client session goes away. */
  closeForSession(sessionKey: object): void {
    for (const call of Array.from(this.calls.values())) {
      if (call.owner.sessionKey === sessionKey) {
        this.close(call, "owner_disconnected");
      }
    }
  }

  /** The host session died under a call — close the call it was hosting. */
  closeForHostAgent(hostAgentId: string, cause: LiveVoiceCloseCause): void {
    for (const call of Array.from(this.calls.values())) {
      if (call.hostAgentId === hostAgentId) {
        this.close(call, cause);
      }
    }
  }

  hasActiveCall(liveSessionId: string): boolean {
    return this.calls.has(liveSessionId);
  }

  hasActiveCallForSession(sessionKey: object): boolean {
    for (const call of this.calls.values()) {
      if (call.owner.sessionKey === sessionKey) {
        return true;
      }
    }
    return false;
  }

  dispose(): void {
    this.unsubscribeAgentClosing();
    for (const call of Array.from(this.calls.values())) {
      // The daemon is going away and the host sessions with it.
      this.close(call, "daemon_shutdown");
    }
  }

  private findCallForSession(sessionKey: object): LiveVoiceCall | null {
    for (const call of this.calls.values()) {
      if (call.owner.sessionKey === sessionKey) {
        return call;
      }
    }
    return null;
  }

  private async buildCallContext(
    call: LiveVoiceCall,
    request: LiveVoiceStartRequest,
  ): Promise<LiveVoiceStartContext | null> {
    const context = this.context
      ? await this.buildContext(toContextBuildOptions(request, this.hostProfile.contextLimits))
      : null;
    if (call.assistant) {
      if (!context)
        throw new Error("Could not prepare assistant context. Try starting the call again.");
      return {
        ...context,
        initialItems: [
          ...buildAssistantContext(call.assistant, this.hostProfile.contextLimits),
          ...context.initialItems,
        ],
      };
    }
    return context;
  }

  /**
   * Spawns the hidden session that hosts the realtime conversation. It is
   * internal (never listed, never persisted, no notifications) and lives in a
   * neutral directory: it is the model's own session, not a project session.
   */
  private async spawnHostSession(
    call: LiveVoiceCall,
    request: LiveVoiceStartRequest,
  ): Promise<{
    agentId: string;
    provider: LiveVoiceHostSession;
    context: LiveVoiceStartContext | null;
  }> {
    const hostProvider = this.hostProfile.provider;
    const requiredTools = request.sendRouteRequest ? LIVE_VOICE_ROUTING_TOOLS : [];
    if (!this.agents.hasPaseoMcpInjection(hostProvider, requiredTools)) {
      throw new LiveVoicePaseoToolsDisabledError(
        "Enable Paseo tools in this host's settings to use Live Voice.",
      );
    }
    const availability = await this.agents.getProviderAvailability(hostProvider);
    if (!availability.available) {
      throw new LiveVoiceUnsupportedError(
        `This daemon cannot host live voice: ${availability.error ?? `provider '${hostProvider}' is unavailable`}`,
      );
    }
    if (call.state !== "starting" || this.calls.get(call.liveSessionId) !== call) {
      throw new Error("Live voice call closed while checking host availability");
    }

    const context = await this.buildCallContext(call, request);
    if (call.state !== "starting" || this.calls.get(call.liveSessionId) !== call) {
      throw new Error("Live voice call closed while building context");
    }

    const config: AgentSessionConfig = {
      provider: hostProvider,
      model: request.backendModel ?? this.hostProfile.model,
      thinkingOptionId: request.backendThinkingOptionId ?? this.hostProfile.thinkingOptionId,
      cwd: this.hostCwd,
      title: HOST_TITLE,
      internal: true,
      inheritMcpServers: false,
      ...(this.hostProfile.providerOptions
        ? { providerOptions: this.hostProfile.providerOptions }
        : {}),
      toolPolicy: {
        preapproved: LIVE_VOICE_ROUTING_TOOLS.map((tool) => ({
          kind: "mcp" as const,
          server: PASEO_MCP_SERVER_NAME,
          tool,
        })),
      },
      // `realtimeStart`'s prompt configures only the conversational
      // intermediary. A provider may route a realtime delegation into a
      // separate turn on this host thread, so give that backend executor the
      // same Live Voice rules through the thread's developer instructions too.
      ...(context
        ? {
            systemPrompt: `${context.prompt}\n\n${BACKEND_EXECUTOR_INSTRUCTIONS}`,
          }
        : {}),
    };
    // The exact id is registered before agent creation. Both native tool
    // injection and the HTTP MCP catalog can be built during createAgent, so
    // registering afterward would expose the ordinary privileged catalog to the
    // hidden host for a race window.
    const hostAgentId = this.createHostAgentId();
    call.unregisterRoute = this.routeBroker.register({
      hostAgentId,
      liveSessionId: call.liveSessionId,
      sourceKey: call.owner.sessionKey,
      send:
        request.sendRouteRequest ??
        (() => {
          throw new Error("Update the Paseo app to enable Live Voice tool routing.");
        }),
      observer: (observation) => this.observeRoutedOperation(call, observation),
    });
    let agent: LiveVoiceHostAgent;
    try {
      agent = await this.agents.createAgent(config, hostAgentId, {
        workspaceId: undefined,
        initialTitle: HOST_TITLE,
      });
    } catch (error) {
      call.unregisterRoute?.();
      call.unregisterRoute = null;
      this.routeBroker.releaseHost(hostAgentId);
      throw error;
    }
    if (agent.id !== hostAgentId) {
      this.disposeHostSession(agent.id);
      throw new Error(`Live Voice host id mismatch: expected ${hostAgentId}, received ${agent.id}`);
    }

    // Provider-agnostic on purpose: any provider whose session implements the
    // realtime seam and advertises the capability can host a call.
    const provider = agent.capabilities.supportsLiveVoice
      ? asLiveVoiceHostSession(agent.session)
      : null;
    if (!provider) {
      // Spawned but useless — don't leave it running.
      this.disposeHostSession(agent.id);
      throw new LiveVoiceUnsupportedError(
        "This daemon's agent provider does not support live voice.",
      );
    }
    // Info, not debug: daemons run at info, and this is the only record of what
    // the call was actually configured with. Without it, a question as basic as
    // "did the model override apply?" can only be answered by reading the
    // provider's own session files.
    this.logger.info(
      {
        hostAgentId: agent.id,
        cwd: this.hostCwd,
        model: config.model,
        thinkingOptionId: config.thinkingOptionId,
        overridden: request.backendModel !== undefined,
      },
      "live_voice.host.started",
    );
    return { agentId: agent.id, provider, context };
  }

  private handleHostEvent(
    call: LiveVoiceCall,
    provider: LiveVoiceHostSession,
    event: AgentStreamEvent,
  ): void {
    if (event.type !== "permission_requested") {
      return;
    }
    if (call.deniedHostPermissionIds.has(event.request.id)) {
      return;
    }
    call.deniedHostPermissionIds.add(event.request.id);

    const response: AgentPermissionResponse = {
      behavior: "deny",
      message: "Live Voice can only act through Paseo routing tools.",
    };
    this.logger.warn(
      {
        liveSessionId: call.liveSessionId,
        hostAgentId: call.hostAgentId,
        permissionId: event.request.id,
        permissionName: event.request.name,
      },
      "live_voice.host.permission_auto_denied",
    );
    void provider.respondToPermission(event.request.id, response).catch((error) => {
      if (call.state === "closed" || this.calls.get(call.liveSessionId) !== call) {
        return;
      }
      this.publish(call, {
        kind: "error",
        code: "host_permission_denial_failed",
        message: "Live Voice could not reject an unsupported host action.",
        fatal: true,
      });
      this.close(call, "error", error instanceof Error ? error.message : String(error));
    });
  }

  /**
   * One log line per routed tool call, at start and at end, in `daemon.log`.
   *
   * `tool_start` is the first externally visible moment of a model action: its
   * arguments are complete. So `msSinceUserSpoke` brackets everything opaque —
   * turn detection, thinking, argument generation, and any backend-executor
   * turn the provider ran in between — and `argChars` is the generation-cost
   * proxy. If
   * a near-empty call and a 2,000-char call show the same gap, the time is
   * thinking, not typing; if the gap scales with argChars, it is typing.
   * Everything from `tool_start` to `tool_end` is Paseo's own routing and
   * execution. Every call is an experiment; nothing here samples or aggregates.
   */
  private observeRoutedOperation(
    call: LiveVoiceCall,
    observation: LiveVoiceRouteObservation,
  ): void {
    const operation = observation.operation;
    const toolName = operation.kind === "execute_tool" ? operation.toolName : operation.kind;
    const targetServerId = operation.kind === "execute_tool" ? operation.targetServerId : undefined;
    const now = Date.now();
    if (observation.phase === "start") {
      const argChars =
        operation.kind === "execute_tool" ? JSON.stringify(operation.arguments).length : 0;
      this.logger.info(
        {
          liveSessionId: call.liveSessionId,
          requestId: observation.requestId,
          toolName,
          ...(targetServerId ? { targetServerId } : {}),
          argChars,
          ...(call.lastUserTranscriptAt !== null
            ? { msSinceUserSpoke: now - call.lastUserTranscriptAt }
            : {}),
          ...(call.lastAssistantTranscriptAt !== null
            ? { msSinceAssistantSpoke: now - call.lastAssistantTranscriptAt }
            : {}),
          ...(call.lastRoutedToolEndAt !== null
            ? { msSincePreviousToolEnd: now - call.lastRoutedToolEndAt }
            : {}),
        },
        "live_voice.timing.tool_start",
      );
      return;
    }
    call.lastRoutedToolEndAt = now;
    this.appendHistory(call, {
      kind: "delegation",
      requestId: observation.requestId,
      description: `${toolName}${targetServerId ? ` on ${targetServerId}` : ""}`,
      ok: observation.ok === true,
      ...(observation.errorCode ? { errorCode: observation.errorCode } : {}),
    });
    this.logger.info(
      {
        liveSessionId: call.liveSessionId,
        requestId: observation.requestId,
        toolName,
        ...(targetServerId ? { targetServerId } : {}),
        durationMs: observation.durationMs,
        ok: observation.ok === true,
        ...(observation.errorCode ? { errorCode: observation.errorCode } : {}),
      },
      "live_voice.timing.tool_end",
    );
  }

  /** Fire-and-forget: release classification only after confirmed teardown. */
  private disposeHostSession(hostAgentId: string): void {
    void this.agents
      .closeAgent(hostAgentId)
      .then(() => {
        this.routeBroker.releaseHost(hostAgentId);
        return undefined;
      })
      .catch((error) => {
        this.logger.warn({ err: error, hostAgentId }, "live_voice.host.close_failed");
      });
  }

  private async performHandshake(
    call: LiveVoiceCall,
    provider: AgentRealtimeVoiceSession,
    request: LiveVoiceStartRequest,
    context: LiveVoiceStartContext | null,
  ): Promise<string> {
    const sdpPromise = this.waitForAnswerSdp(call);
    // Observe the waiter immediately: `close()` can reject it while
    // `realtimeStart` is still in flight (owner disconnect, host session death),
    // and a rejection with no handler attached in that window is an unhandled
    // rejection. The `await` below still sees the rejection.
    sdpPromise.catch(() => undefined);
    const startPromise = provider.realtimeStart({
      sdp: request.offerSdp,
      realtimeSessionId: call.liveSessionId,
      ...(request.voice ? { voice: request.voice } : {}),
      ...(context
        ? {
            prompt: context.prompt,
            initialItems: context.initialItems,
            // Our snapshot replaces the provider's own startup context.
            includeStartupContext: false,
          }
        : {}),
    });
    const handshakePromise = Promise.all([startPromise, sdpPromise]).then(([, sdp]) => sdp);
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      call.startTimer = setTimeout(() => {
        call.startTimer = null;
        reject(new Error(`Timed out after ${this.startSdpTimeoutMs}ms starting live voice`));
      }, this.startSdpTimeoutMs);
      call.startTimer.unref?.();
    });
    try {
      return await Promise.race([handshakePromise, timeoutPromise]);
    } finally {
      if (call.startTimer) {
        clearTimeout(call.startTimer);
        call.startTimer = null;
      }
    }
  }

  /**
   * A context failure must not cost the user their call: fall back to the
   * provider's default context rather than aborting the start.
   */
  private async buildContext(
    options: LiveVoiceContextBuildOptions,
  ): Promise<LiveVoiceStartContext | null> {
    if (!this.context) {
      return null;
    }
    try {
      return await this.context.build(options);
    } catch (error) {
      this.logger.warn({ err: error }, "live_voice.context.build_failed");
      return null;
    }
  }

  private waitForAnswerSdp(call: LiveVoiceCall): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (call.bufferedAnswerSdp !== null) {
        resolve(call.bufferedAnswerSdp);
        return;
      }
      if (call.state === "closed" || call.state === "stopping") {
        reject(new Error("Live voice call closed before the answer SDP arrived"));
        return;
      }
      call.sdpWaiter = { resolve, reject };
    });
  }

  private handleRealtimeEvent(call: LiveVoiceCall, event: AgentRealtimeVoiceEvent): void {
    if (call.state === "closed" || call.state === "stopping") {
      return;
    }
    switch (event.kind) {
      case "sdp":
        this.deliverAnswerSdp(call, event.sdp);
        return;
      case "started":
        // Informational: the wire `started` is published once the handshake
        // completes and the client has the liveSessionId.
        this.logger.debug(
          {
            liveSessionId: call.liveSessionId,
            hostAgentId: call.hostAgentId,
            realtimeSessionId: event.realtimeSessionId,
            version: event.version,
          },
          "live_voice.provider.realtime_started",
        );
        return;
      case "transcript":
        this.appendHistory(call, { kind: "transcript", role: event.role, text: event.text });
        if (event.role === "user") {
          call.lastUserTranscriptAt = Date.now();
        } else {
          call.lastAssistantTranscriptAt = Date.now();
        }
        // Sizes only — transcript text is user content and stays out of logs.
        this.logger.debug(
          {
            liveSessionId: call.liveSessionId,
            role: event.role,
            chars: event.text.length,
          },
          "live_voice.timing.transcript",
        );
        this.publish(call, {
          kind: "transcript",
          role: event.role,
          transcriptId: randomUUID(),
          text: event.text,
        });
        return;
      case "error":
        this.publish(call, {
          kind: "error",
          code: "provider_realtime_error",
          message: event.message,
          fatal: true,
        });
        this.close(call, "error", event.message);
        return;
      case "closed":
        this.close(call, "provider_closed", event.reason ?? undefined);
        return;
      case "transport_closed":
        this.close(call, "provider_exit", event.reason);
        return;
    }
  }

  private deliverAnswerSdp(call: LiveVoiceCall, sdp: string): void {
    call.bufferedAnswerSdp = sdp;
    const waiter = call.sdpWaiter;
    call.sdpWaiter = null;
    waiter?.resolve(sdp);
  }

  private appendHistory(
    call: LiveVoiceCall,
    entry: Parameters<AssistantCallHandle["append"]>[0],
  ): void {
    if (!call.assistant) return;
    void call.assistant.append(entry).catch((error) => {
      this.logger.error(
        { err: error, liveSessionId: call.liveSessionId },
        "assistant.history.write_failed",
      );
      if (call.state === "closed" || call.state === "stopping") return;
      this.publish(call, {
        kind: "error",
        code: "history_write_failed",
        message: "Could not save assistant history. The call has ended.",
        fatal: true,
      });
      this.close(call, "error");
    });
  }

  private publish(call: LiveVoiceCall, event: LiveVoiceUpdateEvent): void {
    const update: LiveVoiceUpdate = {
      liveSessionId: call.liveSessionId,
      seq: call.seq++,
      event,
    };
    try {
      call.emit(update);
    } catch (error) {
      this.logger.warn(
        { err: error, liveSessionId: call.liveSessionId },
        "live_voice.update.emit_failed",
      );
    }
  }

  /** Idempotent: the first terminal cause wins and cleanup runs exactly once. */
  private close(call: LiveVoiceCall, cause: LiveVoiceCloseCause, detail?: string): void {
    if (call.state === "stopping" || call.state === "closed") {
      return;
    }
    const notifyOwner = call.state === "active";
    call.state = "stopping";

    if (call.startTimer) {
      clearTimeout(call.startTimer);
      call.startTimer = null;
    }
    call.unsubscribeRealtime?.();
    call.unsubscribeRealtime = null;
    call.unsubscribeHost?.();
    call.unsubscribeHost = null;

    const waiter = call.sdpWaiter;
    call.sdpWaiter = null;
    call.unregisterRoute?.();
    call.unregisterRoute = null;

    // Deregistered before the host teardown below: closing the host re-enters
    // through `onAgentClosing`, which must find no call to close.
    if (this.calls.get(call.liveSessionId) === call) {
      this.calls.delete(call.liveSessionId);
    }

    if (call.provider && CAUSES_REQUIRING_PROVIDER_STOP.has(cause)) {
      void call.provider.realtimeStop().catch((error) => {
        this.logger.debug(
          { err: error, liveSessionId: call.liveSessionId, cause },
          "live_voice.provider.stop_failed",
        );
      });
    }

    // The host session exists only for this call, so every cause disposes it.
    const hostAgentId = call.hostAgentId;
    call.hostAgentId = null;
    if (hostAgentId) {
      this.disposeHostSession(hostAgentId);
    }

    call.state = "closed";
    void call.assistant?.close(cause).catch((error) => {
      this.logger.error(
        { err: error, liveSessionId: call.liveSessionId },
        "assistant.history.close_failed",
      );
    });

    // A call that never went active has no `closed` update to send: the client
    // learns the outcome from the start response instead.
    if (notifyOwner) {
      this.publish(call, { kind: "closed", cause, ...(detail ? { detail } : {}) });
    }

    waiter?.reject(new Error(`Live voice call closed (${cause})`));

    this.logger.info(
      { liveSessionId: call.liveSessionId, hostAgentId, cause, detail },
      "live_voice.call.closed",
    );
  }
}
