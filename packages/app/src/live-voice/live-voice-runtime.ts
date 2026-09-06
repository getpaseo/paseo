/**
 * Live Voice runtime — the non-React state machine behind the feature.
 *
 * Same shape as `@/voice/voice-runtime`: a plain object with a listener set and
 * a stable snapshot, so React can consume it through `useSyncExternalStore`
 * without the runtime knowing React exists.
 *
 * Each call owns its resources independently of later start attempts:
 *   - the WebRTC session handle,
 *   - the `voice.live.update` subscription (and the stale-update filter),
 *   - the finalized transcript list,
 *   - the microphone lease token.
 *   - the connection pin, retained until the daemon acknowledges stop.
 *
 * Errors are reported structurally (`code` + optional server message) rather
 * than as prose, so the UI owns all translation.
 */

import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import {
  audioSessionLease,
  type AudioSessionLease,
  type AudioSessionLeaseToken,
  type AudioSessionOwner,
} from "@/audio/audio-session-lease";
import {
  isLiveVoiceSessionSupported,
  startLiveVoiceSession,
  type LiveVoiceSession,
  type StartLiveVoiceSessionOptions,
} from "@/live-voice/live-voice-session";
import { resolveLiveVoiceVoiceForCall } from "@/live-voice/live-voice-voice-catalog";

type VoiceLiveUpdateMessage = Extract<SessionOutboundMessage, { type: "voice.live.update" }>;

export type LiveVoicePhase = "idle" | "starting" | "active" | "stopping" | "error";

export interface LiveVoiceTranscriptEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
}

/**
 * `code` is an open string: the daemon's rejection codes stay `z.string()` on the
 * wire so a newer daemon can add codes without breaking us. The UI translates the
 * codes it knows and falls back to `message`.
 */
export interface LiveVoiceErrorInfo {
  code: string;
  message: string | null;
  /** Set when `code` is `mic_busy`: who is holding the microphone lease. */
  owner?: AudioSessionOwner;
}

export interface LiveVoiceSnapshot {
  phase: LiveVoicePhase;
  serverId: string | null;
  /** The durable assistant this call attached to; null for a legacy ephemeral call. */
  assistantId: string | null;
  liveSessionId: string | null;
  isMuted: boolean;
  /** Autoplay policy blocked remote audio; the UI must offer "tap to enable audio". */
  isAudioBlocked: boolean;
  transcripts: LiveVoiceTranscriptEntry[];
  error: LiveVoiceErrorInfo | null;
  /** `cause` of the last terminal `closed` update, for a post-call explanation. */
  closedCause: string | null;
}

/**
 * The slice of `DaemonClient` the runtime needs. Narrowed to three calls so tests
 * can supply a plain object instead of a real client.
 *
 * `subscribeUpdates` exists rather than the client's `on(type, handler)` because
 * `on` is an overloaded generic; a one-line adapter at the construction site
 * (`client.on("voice.live.update", handler)`) keeps the runtime's dependency
 * surface honest and mockable.
 */
export interface LiveVoiceDaemonClient {
  startLiveVoice(input: {
    negotiation: { kind: "webrtc_sdp"; offerSdp: string };
    assistantId?: string;
    voice?: string;
    ambientAgentReports?: boolean;
    ambientAgentGuidance?: string;
    disabledPromptComponents?: string[];
    customVoiceInstructions?: string;
    defaultWorkspaceDirectory?: string;
    backendModel?: string;
    backendThinkingOptionId?: string;
  }): Promise<{
    liveSessionId: string;
    negotiation: { kind: "webrtc_sdp"; answerSdp: string };
  }>;
  stopLiveVoice(input: { liveSessionId: string }): Promise<void>;
  listLiveVoiceVoices?(): Promise<string[]>;
  subscribeUpdates(handler: (message: VoiceLiveUpdateMessage) => void): () => void;
}

export interface LiveVoiceConnectionPin {
  readonly client: LiveVoiceDaemonClient;
  release(): void;
}

export interface LiveVoiceRuntimeDeps {
  getClient(serverId: string): LiveVoiceDaemonClient | null;
  /**
   * Pin the exact daemon client used for the call so HostRuntime cannot replace
   * its transport after SDP negotiation. Optional for non-mobile/test hosts.
   */
  pinConnection?(serverId: string): LiveVoiceConnectionPin | null;
  startSession(options: StartLiveVoiceSessionOptions): Promise<LiveVoiceSession>;
  isSessionSupported: boolean;
  lease: AudioSessionLease;
  /**
   * Reporting agents this call did not start. Absent on hosts that have no
   * multi-host registry to watch (tests, and any client without one).
   */
  ambientAgentReports?: {
    /** The user's setting, read at start so a mid-call change cannot confuse the model. */
    read(): { enabled: boolean; guidance: string | undefined };
    enable(input: { sourceServerId: string; liveSessionId: string }): Promise<void>;
    disable(input: { liveSessionId: string }): Promise<void>;
  };
  /** The selected provider voice, read once when a new call starts. */
  voice?: {
    read(): string | undefined;
  };
  /** The user's call configuration — prompt and backend model — read once at start. */
  callSettings?: {
    read(): {
      disabledPromptComponents: string[] | undefined;
      customVoiceInstructions: string | undefined;
      defaultWorkspaceDirectory: string | undefined;
      backendModel: string | undefined;
      backendThinkingOptionId: string | undefined;
    };
  };
  /**
   * The durable assistant a new call on this host attaches to, read once at
   * start. When it names one, the assistant's own voice, instructions, and
   * backend settings replace the per-call values above; the daemon ignores
   * them anyway, so they are not sent.
   */
  assistant?: {
    read(serverId: string): string | undefined;
  };
}

export interface LiveVoiceRuntime {
  subscribe(listener: () => void): () => void;
  getSnapshot(): LiveVoiceSnapshot;
  start(serverId: string): Promise<void>;
  /** Pending platform startup cannot be cancelled; its lease survives until it settles. */
  stop(): Promise<void>;
  /** Drive mute to an absolute value. No-op unless a call is active. */
  setMuted(muted: boolean): void;
  toggleMute(): void;
  /** Retry autoplay-blocked playback. Must be driven by a user gesture. */
  resumeAudio(): Promise<void>;
  /**
   * Clear a terminal error/ended state and its retained transcript from the
   * footer control. No-op while a call is live.
   */
  dismiss(): void;
  isActiveForServer(serverId: string): boolean;
  /**
   * The host replaced the exact pinned client this call was placed over. Tears
   * the local half down and asks the replacement to stop the retained daemon
   * session. A transient socket disconnect on the same client is handled
   * by that client's reconnect loop and must not call this method.
   */
  handleConnectionLost(serverId: string): void;
  destroy(): Promise<void>;
}

async function resolveSelectedLiveVoice(
  selectedVoice: string | undefined,
  client: LiveVoiceDaemonClient,
): Promise<string | undefined> {
  const listVoices = client.listLiveVoiceVoices?.bind(client);
  return await resolveLiveVoiceVoiceForCall({
    selectedVoice,
    ...(listVoices ? { listVoices } : {}),
  });
}

function resolveLiveVoiceClient(
  deps: LiveVoiceRuntimeDeps,
  serverId: string,
  pin: LiveVoiceConnectionPin | null,
): LiveVoiceDaemonClient | null {
  return deps.pinConnection ? (pin?.client ?? null) : deps.getClient(serverId);
}

/** Thrown by `start`. Mirrors the snapshot's `error` so callers can toast it. */
export class LiveVoiceStartError extends Error {
  readonly name = "LiveVoiceStartError";
  readonly info: LiveVoiceErrorInfo;

  constructor(info: LiveVoiceErrorInfo) {
    super(info.message ?? info.code);
    this.info = info;
  }
}

/**
 * Upper bound on retained transcript entries. A call is open-ended, so without a
 * cap a long conversation grows the snapshot (and every re-render that copies
 * it) forever. The UI only ever shows the tail; older entries just age out.
 */
const MAX_RETAINED_TRANSCRIPTS = 200;

/**
 * Guidance only travels when reports are on: it exists to shape reports, and
 * sending it without them would describe a behavior the call does not have.
 */
function toAmbientStartFields(
  ambient: { enabled: boolean; guidance: string | undefined } | undefined,
): {
  ambientAgentReports?: true;
  ambientAgentGuidance?: string;
} {
  if (!ambient?.enabled) {
    return {};
  }
  return {
    ambientAgentReports: true,
    ...(ambient.guidance ? { ambientAgentGuidance: ambient.guidance } : {}),
  };
}

/**
 * Arms the ambient watches once the call is live. Deliberately not awaited: a
 * host that is slow to arm must not delay the conversation the user is already
 * having, and a host that never arms just does not report.
 */
function beginAmbientAgentReports(
  deps: LiveVoiceRuntimeDeps,
  startFields: { ambientAgentReports?: true },
  sourceServerId: string,
  liveSessionId: string,
): void {
  if (!startFields.ambientAgentReports) {
    return;
  }
  void deps.ambientAgentReports?.enable({ sourceServerId, liveSessionId }).catch(() => undefined);
}

const IDLE_SNAPSHOT: LiveVoiceSnapshot = {
  phase: "idle",
  serverId: null,
  assistantId: null,
  liveSessionId: null,
  isMuted: false,
  isAudioBlocked: false,
  transcripts: [],
  error: null,
  closedCause: null,
};

export function createDefaultLiveVoiceRuntimeDeps(
  getClient: (serverId: string) => LiveVoiceDaemonClient | null,
  pinConnection?: (serverId: string) => LiveVoiceConnectionPin | null,
  ambientAgentReports?: LiveVoiceRuntimeDeps["ambientAgentReports"],
  voice?: LiveVoiceRuntimeDeps["voice"],
  callSettings?: LiveVoiceRuntimeDeps["callSettings"],
  assistant?: LiveVoiceRuntimeDeps["assistant"],
): LiveVoiceRuntimeDeps {
  return {
    getClient,
    ...(pinConnection ? { pinConnection } : {}),
    ...(ambientAgentReports ? { ambientAgentReports } : {}),
    ...(voice ? { voice } : {}),
    ...(callSettings ? { callSettings } : {}),
    ...(assistant ? { assistant } : {}),
    startSession: startLiveVoiceSession,
    isSessionSupported: isLiveVoiceSessionSupported,
    lease: audioSessionLease,
  };
}

interface LiveVoiceCall {
  client: LiveVoiceDaemonClient;
  pin: LiveVoiceConnectionPin | null;
  assistantId: string | null;
  leaseToken: AudioSessionLeaseToken | null;
  session: LiveVoiceSession | null;
  unsubscribe: (() => void) | null;
  pendingUpdates: VoiceLiveUpdateMessage[];
  liveSessionId: string | null;
  lastSequence: number;
  starting: boolean;
  ended: boolean;
  stopRequested: boolean;
  stopPromise: Promise<void> | null;
  closePromise: Promise<void> | null;
}

export function createLiveVoiceRuntime(deps: LiveVoiceRuntimeDeps): LiveVoiceRuntime {
  const listeners = new Set<() => void>();
  let snapshot: LiveVoiceSnapshot = IDLE_SNAPSHOT;
  let currentCall: LiveVoiceCall | null = null;

  function publish(next: LiveVoiceSnapshot): void {
    if (next === snapshot) return;
    snapshot = next;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A broken subscriber must not wedge the call.
      }
    }
  }

  function patch(update: Partial<LiveVoiceSnapshot>): void {
    publish({ ...snapshot, ...update });
  }

  function isCurrent(call: LiveVoiceCall): boolean {
    return currentCall === call && !call.ended;
  }

  function releasePin(call: LiveVoiceCall): void {
    const pin = call.pin;
    call.pin = null;
    pin?.release();
  }

  function stopDaemon(call: LiveVoiceCall): void {
    if (!call.stopRequested || !call.liveSessionId || call.stopPromise) return;
    call.stopPromise = call.client
      .stopLiveVoice({ liveSessionId: call.liveSessionId })
      .catch(() => undefined);
  }

  function releaseResources(call: LiveVoiceCall): void {
    // A pending transport still owns its microphone until startSession settles.
    if (!call.ended || call.starting || call.closePromise) return;
    deps.lease.release(call.leaseToken);
    call.leaseToken = null;
    if (call.stopPromise) {
      void call.stopPromise.then(() => releasePin(call));
    } else {
      releasePin(call);
    }
  }

  function reportCloseFailure(error: unknown): void {
    console.warn("[LiveVoice] Failed to close local audio session", error);
  }

  function closeSession(session: LiveVoiceSession): void | Promise<void> {
    try {
      return session.close()?.catch(reportCloseFailure);
    } catch (error) {
      reportCloseFailure(error);
    }
  }

  function endCall(call: LiveVoiceCall, requestStop: boolean): void {
    call.stopRequested ||= requestStop;
    stopDaemon(call);
    if (!call.ended) {
      call.ended = true;
      if (currentCall === call) currentCall = null;
      call.unsubscribe?.();
      call.unsubscribe = null;
      call.pendingUpdates = [];
      const session = call.session;
      call.session = null;
      const closing = session ? closeSession(session) : undefined;
      if (closing) {
        call.closePromise = closing.then(() => {
          call.closePromise = null;
          return releaseResources(call);
        });
      }
      if (call.liveSessionId) {
        void deps.ambientAgentReports
          ?.disable({ liveSessionId: call.liveSessionId })
          .catch(() => undefined);
      }
    }
    releaseResources(call);
  }

  function applyUpdate(call: LiveVoiceCall, message: VoiceLiveUpdateMessage): void {
    const { liveSessionId, seq, event } = message.payload;
    if (!isCurrent(call) || liveSessionId !== call.liveSessionId || seq <= call.lastSequence) {
      return;
    }
    call.lastSequence = seq;
    switch (event.kind) {
      case "started":
        return;
      case "transcript": {
        const entry: LiveVoiceTranscriptEntry = {
          id: event.transcriptId,
          role: event.role,
          text: event.text,
        };
        const existing = snapshot.transcripts.findIndex((item) => item.id === entry.id);
        const transcripts =
          existing === -1
            ? [...snapshot.transcripts, entry].slice(-MAX_RETAINED_TRANSCRIPTS)
            : snapshot.transcripts.map((item, index) => (index === existing ? entry : item));
        patch({ transcripts });
        return;
      }
      case "error": {
        const error: LiveVoiceErrorInfo = { code: event.code, message: event.message };
        if (!event.fatal) {
          patch({ error });
          return;
        }
        endCall(call, false);
        patch({ phase: "error", error, liveSessionId: null, isAudioBlocked: false });
        return;
      }
      case "closed":
        endCall(call, false);
        patch({
          phase: "idle",
          liveSessionId: null,
          isAudioBlocked: false,
          closedCause: event.cause,
        });
        return;
    }
  }

  function handleUpdate(call: LiveVoiceCall, message: VoiceLiveUpdateMessage): void {
    if (!isCurrent(call)) return;
    if (call.session === null) {
      call.pendingUpdates.push(message);
      return;
    }
    applyUpdate(call, message);
  }

  function failStart(serverId: string, info: LiveVoiceErrorInfo): never {
    publish({ ...IDLE_SNAPSHOT, phase: "error", serverId, error: info });
    throw new LiveVoiceStartError(info);
  }

  function toErrorInfo(error: unknown): LiveVoiceErrorInfo {
    if (error && typeof error === "object") {
      const candidate = error as { errorCode?: unknown; code?: unknown; message?: unknown };
      const code = typeof candidate.errorCode === "string" ? candidate.errorCode : candidate.code;
      if (typeof code === "string" && code.length > 0) {
        return {
          code,
          message: typeof candidate.message === "string" ? candidate.message : null,
        };
      }
    }
    return {
      code: "start_failed",
      message: error instanceof Error ? error.message : null,
    };
  }

  function setMuted(muted: boolean): void {
    const session = currentCall?.session;
    if (!session || snapshot.phase !== "active" || snapshot.isMuted === muted) return;
    session.setMuted(muted);
    patch({ isMuted: muted });
  }

  async function startCall(call: LiveVoiceCall, serverId: string): Promise<void> {
    try {
      if (!isCurrent(call)) return;
      call.unsubscribe = call.client.subscribeUpdates((message) => handleUpdate(call, message));
      const ambientStartFields = toAmbientStartFields(deps.ambientAgentReports?.read());
      const callSettings = deps.callSettings?.read();
      // An assistant carries its own voice; only a legacy call resolves one here.
      const assistantId = call.assistantId;
      const voice = assistantId
        ? undefined
        : await resolveSelectedLiveVoice(deps.voice?.read(), call.client);
      if (!isCurrent(call)) return;

      const started = await deps.startSession({
        negotiate: async (offerSdp) => {
          if (!isCurrent(call)) throw new Error("Live Voice startup was cancelled");
          const result = await call.client.startLiveVoice({
            negotiation: { kind: "webrtc_sdp", offerSdp },
            ...(assistantId ? { assistantId } : {}),
            ...(voice ? { voice } : {}),
            ...ambientStartFields,
            ...(callSettings?.disabledPromptComponents?.length
              ? { disabledPromptComponents: callSettings.disabledPromptComponents }
              : {}),
            ...(callSettings?.defaultWorkspaceDirectory
              ? { defaultWorkspaceDirectory: callSettings.defaultWorkspaceDirectory }
              : {}),
            // The assistant record owns these; sending them would only invite drift.
            ...(!assistantId && callSettings?.customVoiceInstructions
              ? { customVoiceInstructions: callSettings.customVoiceInstructions }
              : {}),
            ...(!assistantId && callSettings?.backendModel
              ? { backendModel: callSettings.backendModel }
              : {}),
            ...(!assistantId && callSettings?.backendThinkingOptionId
              ? { backendThinkingOptionId: callSettings.backendThinkingOptionId }
              : {}),
          });
          // The daemon exists before the transport applies its answer. Retain
          // its id even if setRemoteDescription fails or this start was stopped.
          call.liveSessionId = result.liveSessionId;
          stopDaemon(call);
          return {
            liveSessionId: result.liveSessionId,
            answerSdp: result.negotiation.answerSdp,
          };
        },
        onAudioBlocked: () => {
          if (isCurrent(call)) patch({ isAudioBlocked: true });
        },
        onAudioResumed: () => {
          if (isCurrent(call)) patch({ isAudioBlocked: false });
        },
        onTerminal: (info) => {
          if (!isCurrent(call)) return;
          endCall(call, true);
          patch({
            phase: "error",
            liveSessionId: null,
            isAudioBlocked: false,
            error: { code: info.code, message: info.message },
          });
        },
      });

      if (!isCurrent(call)) {
        await closeSession(started);
        return;
      }
      call.session = started;
      call.liveSessionId = started.liveSessionId;
      patch({ liveSessionId: started.liveSessionId });
      const buffered = call.pendingUpdates;
      call.pendingUpdates = [];
      for (const message of buffered) applyUpdate(call, message);
      if (!isCurrent(call)) return;
      patch({ phase: "active", isMuted: false });
      if (isCurrent(call)) {
        beginAmbientAgentReports(deps, ambientStartFields, serverId, started.liveSessionId);
      }
    } catch (error) {
      if (!isCurrent(call)) return;
      endCall(call, true);
      failStart(serverId, toErrorInfo(error));
    } finally {
      call.starting = false;
      releaseResources(call);
    }
  }

  const runtime: LiveVoiceRuntime = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return snapshot;
    },
    async start(serverId) {
      if (snapshot.phase === "starting" || snapshot.phase === "active") {
        throw new LiveVoiceStartError({ code: "already_active", message: null });
      }
      if (snapshot.phase === "stopping") {
        throw new LiveVoiceStartError({ code: "stopping", message: null });
      }
      if (!deps.isSessionSupported) failStart(serverId, { code: "unsupported", message: null });
      let assistantId: string | null;
      try {
        assistantId = deps.assistant?.read(serverId) ?? null;
      } catch (error) {
        failStart(serverId, error instanceof LiveVoiceStartError ? error.info : toErrorInfo(error));
      }
      const pin = deps.pinConnection?.(serverId) ?? null;
      const client = resolveLiveVoiceClient(deps, serverId, pin);
      if (!client) {
        pin?.release();
        failStart(serverId, { code: "not_connected", message: null });
      }
      const token = deps.lease.acquire("liveVoice");
      if (!token) {
        pin?.release();
        const owner = deps.lease.current();
        failStart(serverId, {
          code: "mic_busy",
          message: null,
          ...(owner ? { owner } : {}),
        });
      }
      const call: LiveVoiceCall = {
        client,
        pin,
        assistantId,
        leaseToken: token,
        session: null,
        unsubscribe: null,
        pendingUpdates: [],
        liveSessionId: null,
        lastSequence: -1,
        starting: true,
        ended: false,
        stopRequested: false,
        stopPromise: null,
        closePromise: null,
      };
      currentCall = call;
      publish({ ...IDLE_SNAPSHOT, phase: "starting", serverId, assistantId });
      await startCall(call, serverId);
    },
    async stop() {
      const call = currentCall;
      if (call) endCall(call, true);
      publish({ ...IDLE_SNAPSHOT, serverId: snapshot.serverId, transcripts: snapshot.transcripts });
      await Promise.all([call?.stopPromise, call?.closePromise]);
    },
    setMuted,
    toggleMute() {
      setMuted(!snapshot.isMuted);
    },
    async resumeAudio() {
      await currentCall?.session?.resumeAudio();
    },
    dismiss() {
      if (snapshot.phase === "idle" || snapshot.phase === "error") publish(IDLE_SNAPSHOT);
    },
    isActiveForServer(serverId) {
      return (
        (snapshot.phase === "active" || snapshot.phase === "starting") &&
        snapshot.serverId === serverId
      );
    },
    handleConnectionLost(serverId) {
      if (!currentCall || snapshot.serverId !== serverId) return;
      const call = currentCall;
      const replacementPin = deps.pinConnection?.(serverId) ?? null;
      const replacement = replacementPin?.client ?? deps.getClient(serverId);
      if (replacement) {
        if (replacementPin) {
          releasePin(call);
          call.pin = replacementPin;
        }
        call.client = replacement;
      }
      endCall(call, true);
      publish({
        ...IDLE_SNAPSHOT,
        serverId,
        transcripts: snapshot.transcripts,
        closedCause: "owner_disconnected",
      });
    },
    async destroy() {
      await runtime.stop();
      listeners.clear();
    },
  };
  return runtime;
}
