import type {
  VoiceAppContext,
  VoiceCallEvent,
  VoiceCallState,
  VoiceCallTransport,
  VoiceCallTransportOffer,
} from "@getpaseo/protocol/messages";
import type { DaemonServerInfo } from "@/stores/session-store";
import {
  acceptVoiceClientTransport,
  type PreparedVoiceClientTransport,
  type VoiceClientTransport,
  type VoiceClientTransportFactory,
  type VoiceTransportMediaState,
  type VoiceTransportSession,
} from "@/voice-chat/transport";

const KEEP_AWAKE_TAG = "paseo:voice";

export type VoiceRuntimePhase = "disabled" | "starting" | "listening" | "playing" | "stopping";

export interface VoiceRuntimeSnapshot {
  phase: VoiceRuntimePhase;
  isVoiceMode: boolean;
  isVoiceSwitching: boolean;
  isMuted: boolean;
  activeServerId: string | null;
  activeCallId: string | null;
  events: VoiceCallEvent[];
}

export interface VoiceRuntimeTelemetrySnapshot {
  volume: number;
  isSpeaking: boolean;
  segmentDuration: number;
}

export interface VoiceSessionAdapter extends VoiceTransportSession {
  serverId: string;
  startCall(
    context: VoiceAppContext,
    transports: VoiceCallTransportOffer[],
  ): Promise<{ callId: string; transport: VoiceCallTransport }>;
  stopCall(callId: string): Promise<void>;
  updateCallContext(callId: string, context: VoiceAppContext): Promise<void>;
}

export interface VoiceRuntimeDeps {
  transports: readonly VoiceClientTransportFactory[];
  getServerInfo(serverId: string): DaemonServerInfo | null;
  activateKeepAwake(tag: string): Promise<void>;
  deactivateKeepAwake(tag: string): Promise<void>;
}

interface RuntimeSession {
  adapter: VoiceSessionAdapter;
  connected: boolean;
}

interface ActiveRuntimeCall {
  serverId: string;
  callId: string;
  transport: VoiceClientTransport;
  media: VoiceTransportMediaState;
}

const INITIAL_SNAPSHOT: VoiceRuntimeSnapshot = {
  phase: "disabled",
  isVoiceMode: false,
  isVoiceSwitching: false,
  isMuted: false,
  activeServerId: null,
  activeCallId: null,
  events: [],
};

const INITIAL_TELEMETRY: VoiceRuntimeTelemetrySnapshot = {
  volume: 0,
  isSpeaking: false,
  segmentDuration: 0,
};

function snapshotsEqual(left: VoiceRuntimeSnapshot, right: VoiceRuntimeSnapshot): boolean {
  return (
    left.phase === right.phase &&
    left.isVoiceMode === right.isVoiceMode &&
    left.isVoiceSwitching === right.isVoiceSwitching &&
    left.isMuted === right.isMuted &&
    left.activeServerId === right.activeServerId &&
    left.activeCallId === right.activeCallId &&
    left.events === right.events
  );
}

function telemetryEqual(
  left: VoiceRuntimeTelemetrySnapshot,
  right: VoiceRuntimeTelemetrySnapshot,
): boolean {
  return (
    left.volume === right.volume &&
    left.isSpeaking === right.isSpeaking &&
    left.segmentDuration === right.segmentDuration
  );
}

export interface VoiceRuntime {
  subscribe(listener: () => void): () => void;
  getSnapshot(): VoiceRuntimeSnapshot;
  subscribeTelemetry(listener: () => void): () => void;
  getTelemetrySnapshot(): VoiceRuntimeTelemetrySnapshot;
  registerSession(adapter: VoiceSessionAdapter): () => void;
  updateSessionConnection(serverId: string, connected: boolean): void;
  handleTransportMessage(serverId: string, callId: string, data: unknown): void;
  handleCallState(serverId: string, callState: VoiceCallState): void;
  handleCallEvent(serverId: string, callId: string, event: VoiceCallEvent): void;
  startCall(serverId: string, context: VoiceAppContext): Promise<void>;
  stopVoice(): Promise<void>;
  updateCallContext(context: VoiceAppContext): Promise<void>;
  reportError(message: string): Promise<void>;
  dismissTranscript(): void;
  destroy(): Promise<void>;
  toggleMute(): void;
  isCallActiveOnServer(serverId: string): boolean;
}

export function createVoiceRuntime(deps: VoiceRuntimeDeps): VoiceRuntime {
  const listeners = new Set<() => void>();
  const telemetryListeners = new Set<() => void>();
  const sessions = new Map<string, RuntimeSession>();
  let snapshot = INITIAL_SNAPSHOT;
  let telemetry = INITIAL_TELEMETRY;
  let activeCall: ActiveRuntimeCall | null = null;
  let generation = 0;
  let speechStartedAt: number | null = null;
  let segmentTimer: ReturnType<typeof setInterval> | null = null;

  function emit(): void {
    for (const listener of listeners) listener();
  }

  function emitTelemetry(): void {
    for (const listener of telemetryListeners) listener();
  }

  function patchSnapshot(
    patch:
      | Partial<VoiceRuntimeSnapshot>
      | ((previous: VoiceRuntimeSnapshot) => VoiceRuntimeSnapshot),
  ): void {
    const next = typeof patch === "function" ? patch(snapshot) : { ...snapshot, ...patch };
    if (snapshotsEqual(next, snapshot)) return;
    snapshot = next;
    emit();
  }

  function patchTelemetry(patch: Partial<VoiceRuntimeTelemetrySnapshot>): void {
    const next = { ...telemetry, ...patch };
    if (telemetryEqual(next, telemetry)) return;
    telemetry = next;
    emitTelemetry();
  }

  function clearSegmentTimer(): void {
    if (!segmentTimer) return;
    clearInterval(segmentTimer);
    segmentTimer = null;
  }

  function publishSpeechState(isSpeaking: boolean): void {
    speechStartedAt = isSpeaking ? (speechStartedAt ?? Date.now()) : null;
    patchTelemetry({ isSpeaking, ...(isSpeaking ? {} : { segmentDuration: 0 }) });
    if (!isSpeaking) {
      clearSegmentTimer();
      return;
    }
    if (segmentTimer) return;
    segmentTimer = setInterval(() => {
      patchTelemetry({ segmentDuration: speechStartedAt ? Date.now() - speechStartedAt : 0 });
    }, 100);
  }

  function publishMedia(callGeneration: number, media: VoiceTransportMediaState): void {
    if (callGeneration !== generation || !activeCall) return;
    activeCall.media = media;
    patchTelemetry({ volume: media.volume });
    patchSnapshot({
      isMuted: media.isMuted,
      phase: media.output === "speaking" ? "playing" : "listening",
    });
  }

  async function stopLocal(call: ActiveRuntimeCall | null): Promise<void> {
    activeCall = null;
    clearSegmentTimer();
    speechStartedAt = null;
    await call?.transport.stop().catch(() => undefined);
    await deps.deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
    patchTelemetry({ ...INITIAL_TELEMETRY });
    patchSnapshot({ ...INITIAL_SNAPSHOT, events: snapshot.events });
  }

  async function prepareTransports(
    session: RuntimeSession,
  ): Promise<PreparedVoiceClientTransport[]> {
    if (deps.transports.length === 0) throw new Error("No voice transports are installed");
    return Promise.all(deps.transports.map((factory) => factory.prepare(session.adapter)));
  }

  const api: VoiceRuntime = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
    subscribeTelemetry(listener) {
      telemetryListeners.add(listener);
      return () => telemetryListeners.delete(listener);
    },
    getTelemetrySnapshot() {
      return telemetry;
    },
    registerSession(adapter) {
      sessions.set(adapter.serverId, { adapter, connected: true });
      return () => {
        sessions.delete(adapter.serverId);
        if (snapshot.activeServerId === adapter.serverId && snapshot.phase !== "disabled") {
          generation += 1;
          void stopLocal(activeCall);
        }
      };
    },
    updateSessionConnection(serverId, connected) {
      const session = sessions.get(serverId);
      if (!session) return;
      session.connected = connected;
      if (!connected && snapshot.activeServerId === serverId && snapshot.phase !== "disabled") {
        generation += 1;
        void stopLocal(activeCall);
      }
    },
    handleTransportMessage(serverId, callId, data) {
      if (activeCall?.serverId !== serverId || activeCall.callId !== callId) return;
      activeCall.transport.handleServerMessage(data);
    },
    handleCallState(serverId, callState) {
      const call = activeCall;
      if (!call || call.serverId !== serverId || call.callId !== callState.callId) return;
      call.transport.updateCallState(callState);
      publishSpeechState(callState.input === "speech_detected");
      if (callState.lifecycle === "ended" || callState.lifecycle === "failed") {
        if (callState.lifecycle === "failed" && callState.error) {
          const eventId = `call-terminal-${call.callId}`;
          const errorMessage = callState.error;
          patchSnapshot((previous) => {
            if (previous.events.some((event) => event.id === eventId)) return previous;
            return {
              ...previous,
              events: [...previous.events, { type: "error", id: eventId, message: errorMessage }],
            };
          });
        }
        generation += 1;
        void stopLocal(call);
      }
    },
    handleCallEvent(serverId, callId, event) {
      if (activeCall?.serverId !== serverId || activeCall.callId !== callId) return;
      patchSnapshot((previous) => {
        const index = previous.events.findIndex((candidate) => candidate.id === event.id);
        const events =
          index === -1 ? [...previous.events, event] : previous.events.with(index, event);
        return { ...previous, events };
      });
    },
    async startCall(serverId, context) {
      const session = sessions.get(serverId);
      if (!session) throw new Error(`Voice runtime is not ready for host ${serverId}`);
      if (!session.connected) throw new Error(`Host ${serverId} is not connected`);
      if (deps.getServerInfo(serverId)?.features?.voiceChat !== true) {
        throw new Error("Update the Paseo host to use voice chat.");
      }

      const callGeneration = ++generation;
      const previousCall = activeCall;
      const previousSession = previousCall ? sessions.get(previousCall.serverId) : null;
      activeCall = null;
      patchSnapshot({
        ...snapshot,
        isVoiceSwitching: true,
        phase: "starting",
        activeServerId: serverId,
        activeCallId: null,
        events: [],
      });
      if (previousCall) {
        await previousSession?.adapter.stopCall(previousCall.callId).catch(() => undefined);
        await previousCall.transport.stop().catch(() => undefined);
      }

      let prepared: PreparedVoiceClientTransport[] = [];
      let acceptedCallId: string | null = null;
      let transport: VoiceClientTransport | null = null;
      try {
        await deps.activateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
        prepared = await prepareTransports(session);
        const started = await session.adapter.startCall(
          context,
          prepared.map((candidate) => candidate.offer),
        );
        acceptedCallId = started.callId;
        if (generation !== callGeneration) {
          await Promise.all(prepared.map((candidate) => candidate.discard()));
          await session.adapter.stopCall(started.callId).catch(() => undefined);
          return;
        }
        patchSnapshot({ activeCallId: started.callId });
        transport = await acceptVoiceClientTransport({
          prepared,
          callId: started.callId,
          answer: started.transport,
          publish: (media) => publishMedia(callGeneration, media),
        });
        if (generation !== callGeneration) {
          await transport.stop();
          await session.adapter.stopCall(started.callId).catch(() => undefined);
          return;
        }
        const call: ActiveRuntimeCall = {
          serverId,
          callId: started.callId,
          transport,
          media: { isMuted: false, volume: 0, output: "idle" },
        };
        activeCall = call;
        await transport.start();
        if (generation !== callGeneration) {
          if (activeCall === call) activeCall = null;
          await transport.stop();
          await session.adapter.stopCall(started.callId).catch(() => undefined);
          return;
        }
        patchSnapshot({
          isVoiceMode: true,
          isVoiceSwitching: false,
          phase: "listening",
          isMuted: call.media.isMuted,
        });
      } catch (error) {
        await Promise.all(prepared.map((candidate) => candidate.discard().catch(() => undefined)));
        await transport?.stop().catch(() => undefined);
        if (acceptedCallId) await session.adapter.stopCall(acceptedCallId).catch(() => undefined);
        if (generation === callGeneration) await stopLocal(activeCall);
        throw error;
      }
    },
    async stopVoice() {
      const call = activeCall;
      if (!call && snapshot.phase === "disabled") return;
      const stopGeneration = ++generation;
      patchSnapshot({ isVoiceSwitching: true, phase: "stopping" });
      try {
        const session = call ? sessions.get(call.serverId) : null;
        if (call && session?.connected) await session.adapter.stopCall(call.callId);
      } finally {
        if (stopGeneration === generation) await stopLocal(call);
      }
    },
    async updateCallContext(context) {
      const call = activeCall;
      if (!call) return;
      const session = sessions.get(call.serverId);
      if (!session?.connected) return;
      await session.adapter.updateCallContext(call.callId, context);
    },
    async reportError(message) {
      const call = activeCall;
      if (!call) return;
      patchSnapshot((previous) => ({
        ...previous,
        events: [...previous.events, { type: "error", id: `media-error-${call.callId}`, message }],
      }));
      await api.stopVoice();
    },
    dismissTranscript() {
      patchSnapshot((previous) => ({ ...previous, events: [] }));
    },
    async destroy() {
      await api.stopVoice().catch(() => undefined);
      listeners.clear();
      telemetryListeners.clear();
      sessions.clear();
    },
    toggleMute() {
      activeCall?.transport.toggleMute();
    },
    isCallActiveOnServer(serverId) {
      return activeCall?.serverId === serverId && snapshot.isVoiceMode;
    },
  };

  return api;
}
