import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import {
  asAgentRealtimeVoiceSession,
  type AgentRealtimeVoiceEvent,
  type AgentRealtimeVoiceSession,
} from "../agent/agent-realtime-voice.js";

/** How long to wait for codex's async answer-SDP notification before giving up. */
const START_SDP_TIMEOUT_MS = 30_000;

export type LiveVoiceStartErrorCode =
  | "busy"
  | "unsupported"
  | "agent_not_found"
  | "agent_busy"
  | "start_failed";

export type LiveVoiceCloseCause =
  | "requested"
  | "owner_disconnected"
  | "error"
  | "codex_closed"
  | "codex_exit"
  | "agent_closed"
  | "start_failed";

/**
 * Causes where the provider session is still usable, so we tell codex to tear
 * down its realtime session. `agent_closed` qualifies: `onAgentClosing` fires
 * before the provider session is disposed, so the stop still has a live
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
  "agent_closed",
]);

/** Mirrors the protocol's `VoiceLiveEventSchema` union. */
export type LiveVoiceUpdateEvent =
  | { kind: "started" }
  | { kind: "transcript"; role: "user" | "assistant"; transcriptId: string; text: string }
  | { kind: "error"; code: string; message: string; fatal: boolean }
  | { kind: "closed"; cause: string; detail?: string };

export interface LiveVoiceUpdate {
  agentId: string;
  liveSessionId: string;
  seq: number;
  event: LiveVoiceUpdateEvent;
}

/**
 * Identifies the client that owns a call. `sessionKey` is the client session and
 * `sourceKey` the individual socket within it, so a socket detaching tears down
 * only its own calls while a whole session going away tears down all of them.
 */
export interface LiveVoiceOwner {
  readonly sessionKey: object;
  readonly sourceKey: object;
}

export interface LiveVoiceStartRequest {
  agentId: string;
  offerSdp: string;
  voice?: string;
  owner: LiveVoiceOwner;
  emit: (update: LiveVoiceUpdate) => void;
}

export type LiveVoiceStartResult =
  | { accepted: true; liveSessionId: string; answerSdp: string }
  | { accepted: false; errorCode: LiveVoiceStartErrorCode; errorMessage: string };

/**
 * The slice of the agent manager the coordinator needs. `AgentManager` satisfies
 * it structurally; tests supply a minimal fake.
 */
export interface LiveVoiceAgentSource {
  getAgent(agentId: string): LiveVoiceAgentRef | null;
  onAgentClosing(callback: (agentId: string) => void): () => void;
}

export interface LiveVoiceAgentRef {
  lifecycle: string;
  capabilities: { readonly [capability: string]: boolean | undefined };
  session: unknown;
  activeForegroundTurnId: string | null;
}

interface LiveVoiceCall {
  readonly agentId: string;
  readonly liveSessionId: string;
  readonly owner: LiveVoiceOwner;
  readonly emit: (update: LiveVoiceUpdate) => void;
  readonly provider: AgentRealtimeVoiceSession;
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
}

export interface LiveVoiceCoordinatorOptions {
  agents: LiveVoiceAgentSource;
  logger: Logger;
  startSdpTimeoutMs?: number;
}

/**
 * Daemon-global owner of Live Voice calls. Exactly one call per agent: codex
 * silently replaces an existing realtime session when a second
 * `thread/realtime/start` lands on the same thread, so exclusivity has to be
 * enforced here.
 */
export class LiveVoiceCoordinator {
  private readonly calls = new Map<string, LiveVoiceCall>();
  private readonly agents: LiveVoiceAgentSource;
  private readonly logger: Logger;
  private readonly startSdpTimeoutMs: number;
  private readonly unsubscribeAgentClosing: () => void;

  constructor(options: LiveVoiceCoordinatorOptions) {
    this.agents = options.agents;
    this.logger = options.logger.child({ module: "live-voice" });
    this.startSdpTimeoutMs = options.startSdpTimeoutMs ?? START_SDP_TIMEOUT_MS;
    this.unsubscribeAgentClosing = this.agents.onAgentClosing((agentId) => {
      this.closeForAgent(agentId, "agent_closed");
    });
  }

  async start(request: LiveVoiceStartRequest): Promise<LiveVoiceStartResult> {
    const { agentId } = request;
    if (this.calls.has(agentId)) {
      return {
        accepted: false,
        errorCode: "busy",
        errorMessage: "Another client already has a live voice call on this agent.",
      };
    }

    const resolved = this.resolveProvider(agentId);
    if (!resolved.ok) {
      return {
        accepted: false,
        errorCode: resolved.errorCode,
        errorMessage: resolved.errorMessage,
      };
    }

    // Reserve the agent synchronously: everything above is sync, so no second
    // caller can interleave before the map entry exists.
    const call: LiveVoiceCall = {
      agentId,
      liveSessionId: randomUUID(),
      owner: request.owner,
      emit: request.emit,
      provider: resolved.provider,
      state: "starting",
      seq: 0,
      unsubscribeRealtime: null,
      startTimer: null,
      bufferedAnswerSdp: null,
      sdpWaiter: null,
    };
    this.calls.set(agentId, call);
    call.unsubscribeRealtime = resolved.provider.subscribeRealtimeEvents((event) => {
      this.handleRealtimeEvent(call, event);
    });

    try {
      const answerSdp = await this.performHandshake(call, request);
      if (call.state !== "starting" || this.calls.get(agentId) !== call) {
        // A terminal cause landed between the SDP arriving and this resumption;
        // the call is already gone and must not be resurrected.
        throw new Error("Live voice call closed during startup");
      }
      call.state = "active";
      this.publish(call, { kind: "started" });
      this.logger.info({ agentId, liveSessionId: call.liveSessionId }, "live_voice.call.started");
      return { accepted: true, liveSessionId: call.liveSessionId, answerSdp };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.close(call, "start_failed", errorMessage);
      this.logger.warn({ err: error, agentId }, "live_voice.call.start_failed");
      return { accepted: false, errorCode: "start_failed", errorMessage };
    }
  }

  stop(params: { agentId: string; liveSessionId: string }): void {
    const call = this.calls.get(params.agentId);
    // A stop for a superseded or already-closed call is a no-op; the caller
    // still gets a response.
    if (!call || call.liveSessionId !== params.liveSessionId) {
      return;
    }
    this.close(call, "requested");
  }

  /** Immediate teardown when the owning socket detaches. No retention grace. */
  closeForSource(sourceKey: object): void {
    for (const call of Array.from(this.calls.values())) {
      if (call.owner.sourceKey === sourceKey) {
        this.close(call, "owner_disconnected");
      }
    }
  }

  /** Teardown when the whole client session goes away. */
  closeForSession(sessionKey: object): void {
    for (const call of Array.from(this.calls.values())) {
      if (call.owner.sessionKey === sessionKey) {
        this.close(call, "owner_disconnected");
      }
    }
  }

  closeForAgent(agentId: string, cause: LiveVoiceCloseCause): void {
    const call = this.calls.get(agentId);
    if (call) {
      this.close(call, cause);
    }
  }

  hasActiveCall(agentId: string): boolean {
    return this.calls.has(agentId);
  }

  dispose(): void {
    this.unsubscribeAgentClosing();
    for (const call of Array.from(this.calls.values())) {
      this.close(call, "agent_closed");
    }
  }

  private async performHandshake(
    call: LiveVoiceCall,
    request: LiveVoiceStartRequest,
  ): Promise<string> {
    const sdpPromise = this.waitForAnswerSdp(call);
    // Observe the waiter immediately: `close()` can reject it while
    // `realtimeStart` is still in flight (owner disconnect, agent archive), and
    // a rejection with no handler attached in that window is an unhandled
    // rejection. The `await` below still sees the rejection.
    sdpPromise.catch(() => undefined);
    await call.provider.realtimeStart({
      sdp: request.offerSdp,
      realtimeSessionId: call.liveSessionId,
      ...(request.voice ? { voice: request.voice } : {}),
    });
    return await sdpPromise;
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

  private resolveProvider(
    agentId: string,
  ):
    | { ok: true; provider: AgentRealtimeVoiceSession }
    | { ok: false; errorCode: LiveVoiceStartErrorCode; errorMessage: string } {
    const agent = this.agents.getAgent(agentId);
    if (!agent) {
      return {
        ok: false,
        errorCode: "agent_not_found",
        errorMessage: "Agent is not loaded. Open it and try again.",
      };
    }
    if (agent.lifecycle === "closed" || agent.session === null) {
      return {
        ok: false,
        errorCode: "agent_not_found",
        errorMessage: "Agent is not running. Open it and try again.",
      };
    }
    // Provider-agnostic on purpose: any provider whose session implements the
    // realtime seam and advertises the capability can host a call.
    const provider = agent.capabilities.supportsLiveVoice
      ? asAgentRealtimeVoiceSession(agent.session)
      : null;
    if (!provider) {
      return {
        ok: false,
        errorCode: "unsupported",
        errorMessage: "This agent does not support live voice.",
      };
    }
    if (agent.lifecycle === "running" || agent.activeForegroundTurnId !== null) {
      return {
        ok: false,
        errorCode: "agent_busy",
        errorMessage: "Agent is mid-turn. Wait for it to finish and try again.",
      };
    }
    return { ok: true, provider };
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
            agentId: call.agentId,
            liveSessionId: call.liveSessionId,
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
      agentId: call.agentId,
      liveSessionId: call.liveSessionId,
      seq: call.seq++,
      event,
    };
    try {
      call.emit(update);
    } catch (error) {
      this.logger.warn(
        { err: error, agentId: call.agentId, liveSessionId: call.liveSessionId },
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

    if (this.calls.get(call.agentId) === call) {
      this.calls.delete(call.agentId);
    }

    if (CAUSES_REQUIRING_CODEX_STOP.has(cause)) {
      void call.provider.realtimeStop().catch((error) => {
        this.logger.debug(
          { err: error, agentId: call.agentId, liveSessionId: call.liveSessionId, cause },
          "live_voice.codex.stop_failed",
        );
      });
    }

    call.state = "closed";

    // A call that never went active has no `closed` update to send: the client
    // learns the outcome from the start response instead.
    if (notifyOwner) {
      this.publish(call, { kind: "closed", cause, ...(detail ? { detail } : {}) });
    }

    waiter?.reject(new Error(`Live voice call closed (${cause})`));

    this.logger.info(
      { agentId: call.agentId, liveSessionId: call.liveSessionId, cause, detail },
      "live_voice.call.closed",
    );
  }
}
