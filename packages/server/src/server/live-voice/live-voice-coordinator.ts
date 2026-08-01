import { randomUUID } from "node:crypto";
import os from "node:os";
import type { Logger } from "pino";

import type { AgentProvider, AgentSessionConfig } from "../agent/agent-sdk-types.js";
import {
  asAgentRealtimeVoiceSession,
  type AgentRealtimeVoiceEvent,
  type AgentRealtimeVoiceSession,
} from "../agent/agent-realtime-voice.js";
import type { LiveVoiceStartContext } from "./live-voice-context.js";
import {
  LiveVoiceRouteBroker,
  type LiveVoiceRouteRegistration,
} from "./live-voice-route-broker.js";

/** How long to wait for codex's async answer-SDP notification before giving up. */
const START_SDP_TIMEOUT_MS = 30_000;

/**
 * Provider the hidden host session runs on. Codex is the only provider that
 * implements the realtime seam today; the capability check below stays
 * provider-agnostic so this constant is the only thing to change if another
 * provider gains it.
 */
const HOST_PROVIDER: AgentProvider = "codex";

/** Shows up only in daemon logs and internal listings — the host session is hidden. */
const HOST_TITLE = "Live Voice host";

export type LiveVoiceStartErrorCode = "busy" | "unsupported" | "start_failed";

export type LiveVoiceCloseCause =
  | "requested"
  | "owner_disconnected"
  | "error"
  | "codex_closed"
  | "codex_exit"
  | "host_session_closed"
  | "start_failed";

/**
 * Causes where the provider session is still usable, so we tell codex to tear
 * down its realtime session. `host_session_closed` qualifies: `onAgentClosing`
 * fires before the provider session is disposed, so the stop still has a live
 * transport and keeps the upstream realtime session from outliving a stalled
 * teardown. The remaining causes mean codex already ended the session
 * (`codex_closed`) or the process is gone (`codex_exit`) — calling
 * `realtimeStop()` there would respawn the app-server.
 */
const CAUSES_REQUIRING_CODEX_STOP: ReadonlySet<LiveVoiceCloseCause> = new Set([
  "requested",
  "owner_disconnected",
  "error",
  "start_failed",
  "host_session_closed",
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
}

export interface LiveVoiceStartRequest {
  offerSdp: string;
  voice?: string;
  owner: LiveVoiceOwner;
  emit: (update: LiveVoiceUpdate) => void;
  sendRouteRequest?: LiveVoiceRouteRegistration["send"];
  /** The client will report agents this call did not start; tell the model so. */
  ambientAgentReports?: boolean;
  /** The user's standing instruction for those reports. */
  ambientAgentGuidance?: string | undefined;
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

/**
 * The slice of the agent manager the coordinator needs. `AgentManager` satisfies
 * it structurally; tests supply a minimal fake.
 */
export interface LiveVoiceAgentSource {
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
  readonly liveSessionId: string;
  readonly owner: LiveVoiceOwner;
  readonly emit: (update: LiveVoiceUpdate) => void;
  /** Both are filled once the host session is up; null while it is being spawned. */
  hostAgentId: string | null;
  provider: AgentRealtimeVoiceSession | null;
  state: "starting" | "active" | "stopping" | "closed";
  seq: number;
  unsubscribeRealtime: (() => void) | null;
  startTimer: NodeJS.Timeout | null;
  /**
   * Codex answers `thread/realtime/start` with an empty result and delivers the
   * answer SDP as a separate notification, which can land before or after that
   * result. Buffer whichever arrives first.
   */
  bufferedAnswerSdp: string | null;
  sdpWaiter: { resolve: (sdp: string) => void; reject: (error: Error) => void } | null;
  unregisterRoute: (() => void) | null;
}

/**
 * Supplies the Paseo prompt and state snapshot handed to the voice model at
 * start. Optional: without it the provider falls back to its own startup
 * context, which yields a working but Paseo-unaware call.
 */
export interface LiveVoiceContextProvider {
  build(options?: {
    crossHostRoutingAvailable: boolean;
    ambientAgentReports?: boolean;
    ambientAgentGuidance?: string | undefined;
  }): Promise<LiveVoiceStartContext | null>;
}

export interface LiveVoiceCoordinatorOptions {
  agents: LiveVoiceAgentSource;
  logger: Logger;
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

/**
 * Daemon-global owner of Live Voice calls. A call is not attached to an agent:
 * each one spawns its own hidden host session to run the realtime conversation
 * on, so concurrent calls from different clients never share a codex thread
 * (codex silently replaces an existing realtime session when a second
 * `thread/realtime/start` lands on the same thread). One call per client session.
 */
export class LiveVoiceCoordinator {
  private readonly calls = new Map<string, LiveVoiceCall>();
  private readonly agents: LiveVoiceAgentSource;
  private readonly logger: Logger;
  private readonly startSdpTimeoutMs: number;
  private readonly context: LiveVoiceContextProvider | null;
  private readonly routeBroker: LiveVoiceRouteBroker;
  private readonly createHostAgentId: () => string;
  private readonly hostCwd: string;
  private readonly unsubscribeAgentClosing: () => void;

  constructor(options: LiveVoiceCoordinatorOptions) {
    this.agents = options.agents;
    this.logger = options.logger.child({ module: "live-voice" });
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
      liveSessionId: randomUUID(),
      owner: request.owner,
      emit: request.emit,
      hostAgentId: null,
      provider: null,
      state: "starting",
      seq: 0,
      unsubscribeRealtime: null,
      startTimer: null,
      bufferedAnswerSdp: null,
      sdpWaiter: null,
      unregisterRoute: null,
    };
    this.calls.set(call.liveSessionId, call);

    try {
      const host = await this.spawnHostSession(call, request);
      if (call.state !== "starting" || this.calls.get(call.liveSessionId) !== call) {
        // The call was torn down while the host was still spawning; the host is
        // ours alone, so it dies with the call rather than leaking.
        this.disposeHostSession(host.agentId);
        throw new Error("Live voice call closed during startup");
      }
      call.hostAgentId = host.agentId;
      call.provider = host.provider;
      call.unsubscribeRealtime = host.provider.subscribeRealtimeEvents((event) => {
        this.handleRealtimeEvent(call, event);
      });

      const answerSdp = await this.performHandshake(call, host.provider, request);
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
        errorCode: error instanceof LiveVoiceUnsupportedError ? "unsupported" : "start_failed",
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

  stop(params: { liveSessionId: string }): void {
    const call = this.calls.get(params.liveSessionId);
    // A stop for an already-closed call is a no-op; the caller still gets a
    // response.
    if (!call) {
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
      this.close(call, "host_session_closed");
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
    provider: AgentRealtimeVoiceSession;
  }> {
    const availability = await this.agents.getProviderAvailability(HOST_PROVIDER);
    if (!availability.available) {
      throw new LiveVoiceUnsupportedError(
        `This daemon cannot host live voice: ${availability.error ?? `provider '${HOST_PROVIDER}' is unavailable`}`,
      );
    }
    if (call.state !== "starting" || this.calls.get(call.liveSessionId) !== call) {
      throw new Error("Live voice call closed while checking host availability");
    }

    const config: AgentSessionConfig = {
      provider: HOST_PROVIDER,
      cwd: this.hostCwd,
      title: HOST_TITLE,
      internal: true,
    };
    // The exact id is registered before agent creation. Both native tool
    // injection and the HTTP MCP catalog can be built during createAgent, so
    // registering afterward would expose the ordinary privileged catalog to the
    // hidden host for a race window.
    const hostAgentId = this.createHostAgentId();
    if (request.sendRouteRequest) {
      call.unregisterRoute = this.routeBroker.register({
        hostAgentId,
        liveSessionId: call.liveSessionId,
        sourceKey: call.owner.sessionKey,
        send: request.sendRouteRequest,
      });
    }
    const agent = await this.agents.createAgent(config, hostAgentId, {
      workspaceId: undefined,
      initialTitle: HOST_TITLE,
    });
    if (agent.id !== hostAgentId) {
      this.disposeHostSession(agent.id);
      throw new Error(`Live Voice host id mismatch: expected ${hostAgentId}, received ${agent.id}`);
    }

    // Provider-agnostic on purpose: any provider whose session implements the
    // realtime seam and advertises the capability can host a call.
    const provider = agent.capabilities.supportsLiveVoice
      ? asAgentRealtimeVoiceSession(agent.session)
      : null;
    if (!provider) {
      // Spawned but useless — don't leave it running.
      this.disposeHostSession(agent.id);
      throw new LiveVoiceUnsupportedError(
        "This daemon's agent provider does not support live voice.",
      );
    }
    this.logger.debug({ hostAgentId: agent.id, cwd: this.hostCwd }, "live_voice.host.started");
    return { agentId: agent.id, provider };
  }

  /** Fire-and-forget: a failed host teardown must not fail the call teardown. */
  private disposeHostSession(hostAgentId: string): void {
    void this.agents.closeAgent(hostAgentId).catch((error) => {
      this.logger.warn({ err: error, hostAgentId }, "live_voice.host.close_failed");
    });
  }

  private async performHandshake(
    call: LiveVoiceCall,
    provider: AgentRealtimeVoiceSession,
    request: LiveVoiceStartRequest,
  ): Promise<string> {
    // Built before the waiter is armed: it only awaits daemon state, and no SDP
    // can arrive until `realtimeStart` below is issued.
    const context = await this.buildContext({
      crossHostRoutingAvailable: request.sendRouteRequest !== undefined,
      ...(request.ambientAgentReports ? { ambientAgentReports: true } : {}),
      ...(request.ambientAgentGuidance
        ? { ambientAgentGuidance: request.ambientAgentGuidance }
        : {}),
    });
    if (call.state !== "starting") {
      throw new Error("Live voice call closed while building context");
    }

    const sdpPromise = this.waitForAnswerSdp(call);
    // Observe the waiter immediately: `close()` can reject it while
    // `realtimeStart` is still in flight (owner disconnect, host session death),
    // and a rejection with no handler attached in that window is an unhandled
    // rejection. The `await` below still sees the rejection.
    sdpPromise.catch(() => undefined);
    await provider.realtimeStart({
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
    return await sdpPromise;
  }

  /**
   * A context failure must not cost the user their call: fall back to the
   * provider's default context rather than aborting the start.
   */
  private async buildContext(options: {
    crossHostRoutingAvailable: boolean;
    ambientAgentReports?: boolean;
    ambientAgentGuidance?: string | undefined;
  }): Promise<LiveVoiceStartContext | null> {
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
      call.startTimer = setTimeout(() => {
        call.startTimer = null;
        const waiter = call.sdpWaiter;
        call.sdpWaiter = null;
        waiter?.reject(
          new Error(`Timed out after ${this.startSdpTimeoutMs}ms waiting for the answer SDP`),
        );
      }, this.startSdpTimeoutMs);
      call.startTimer.unref?.();
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
          "live_voice.codex.started",
        );
        return;
      case "transcript":
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
          code: "codex_realtime_error",
          message: event.message,
          fatal: true,
        });
        this.close(call, "error", event.message);
        return;
      case "closed":
        this.close(call, "codex_closed", event.reason ?? undefined);
        return;
      case "transport_closed":
        this.close(call, "codex_exit", event.reason);
        return;
    }
  }

  private deliverAnswerSdp(call: LiveVoiceCall, sdp: string): void {
    call.bufferedAnswerSdp = sdp;
    const waiter = call.sdpWaiter;
    call.sdpWaiter = null;
    if (call.startTimer) {
      clearTimeout(call.startTimer);
      call.startTimer = null;
    }
    waiter?.resolve(sdp);
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

    const waiter = call.sdpWaiter;
    call.sdpWaiter = null;
    call.unregisterRoute?.();
    call.unregisterRoute = null;

    // Deregistered before the host teardown below: closing the host re-enters
    // through `onAgentClosing`, which must find no call to close.
    if (this.calls.get(call.liveSessionId) === call) {
      this.calls.delete(call.liveSessionId);
    }

    if (call.provider && CAUSES_REQUIRING_CODEX_STOP.has(cause)) {
      void call.provider.realtimeStop().catch((error) => {
        this.logger.debug(
          { err: error, liveSessionId: call.liveSessionId, cause },
          "live_voice.codex.stop_failed",
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
