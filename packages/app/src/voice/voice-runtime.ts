import { Buffer } from "buffer";
import type { AgentStreamEventPayload, SessionOutboundMessage } from "@server/shared/messages";
import { resolveVoiceUnavailableMessage } from "@/utils/server-info-capabilities";
import type { DaemonServerInfo } from "@/stores/session-store";
import type { AudioEngine } from "@/voice/audio-engine-types";
import {
  THINKING_TONE_NATIVE_PCM_BASE64,
  THINKING_TONE_NATIVE_PCM_DURATION_MS,
} from "@/utils/thinking-tone.native-pcm";

const PCM_MIME_TYPE = "audio/pcm;rate=16000;bits=16";
const KEEP_AWAKE_TAG = "paseo:voice";
const THINKING_TONE_REPEAT_GAP_MS = 350;
const DISPLAY_VOLUME_PUBLISH_INTERVAL_MS = 120;
const DISPLAY_VOLUME_CHANGE_EPSILON = 0.02;
const DISPLAY_VOLUME_ATTACK = 0.35;
const DISPLAY_VOLUME_RELEASE = 0.18;

type TurnEventType = Extract<
  AgentStreamEventPayload["type"],
  "turn_started" | "turn_completed" | "turn_failed" | "turn_canceled"
>;

export type VoiceRuntimePhase =
  | "disabled"
  | "starting"
  | "listening"
  | "submitting"
  | "waiting"
  | "playing"
  | "stopping";

export interface VoiceRuntimeSnapshot {
  phase: VoiceRuntimePhase;
  isVoiceMode: boolean;
  isVoiceSwitching: boolean;
  isMuted: boolean;
  activeServerId: string | null;
  activeAgentId: string | null;
}

export interface VoiceRuntimeTelemetrySnapshot {
  volume: number;
  isSpeaking: boolean;
  segmentDuration: number;
}

export interface VoiceSessionAdapter {
  serverId: string;
  setVoiceMode(enabled: boolean, agentId?: string): Promise<void>;
  sendVoiceAudioChunk(audioData: string, mimeType: string): Promise<void>;
  audioPlayed(chunkId: string): Promise<void>;
  abortRequest(): Promise<void>;
  setAssistantAudioPlaying(isPlaying: boolean): void;
}

export interface VoiceRuntimeDeps {
  engine: AudioEngine;
  getServerInfo(serverId: string): DaemonServerInfo | null;
  activateKeepAwake(tag: string): Promise<void>;
  deactivateKeepAwake(tag: string): Promise<void>;
}

interface RuntimeSessionState {
  adapter: VoiceSessionAdapter;
  connected: boolean;
}

interface ContinuousVoiceUploader {
  reset(): void;
  pushPcmChunk(chunk: Uint8Array): void;
}

interface RuntimeState {
  snapshot: VoiceRuntimeSnapshot;
  telemetry: VoiceRuntimeTelemetrySnapshot;
  turnInProgress: boolean;
  serverSpeechDetected: boolean;
  transportReady: boolean;
  generation: number;
  segmentDurationTimer: ReturnType<typeof setInterval> | null;
  lastDisplayVolumePublishMs: number;
  serverSpeechStartedAt: number | null;
}

type AudioOutputPayload = Extract<SessionOutboundMessage, { type: "audio_output" }>["payload"];

type StreamingPlaybackChunk = {
  id: string;
  chunkIndex: number;
  source: { arrayBuffer(): Promise<ArrayBuffer>; size: number; type: string };
};

type StreamingPlaybackGroup = {
  groupId: string;
  isVoiceMode: boolean;
  shouldPlay: boolean;
  chunks: Map<number, StreamingPlaybackChunk>;
  nextChunkToPlay: number;
  finalChunkIndex: number | null;
  started: boolean;
  ackedChunkIds: Set<string>;
};

interface RuntimePlaybackState {
  groups: Map<string, StreamingPlaybackGroup>;
  orderedGroupIds: string[];
  activeGroupId: string | null;
  processing: boolean;
  generation: number;
}

interface CueState {
  active: boolean;
  token: number;
  timeout: ReturnType<typeof setTimeout> | null;
  playing: boolean;
}

const INITIAL_SNAPSHOT: VoiceRuntimeSnapshot = {
  phase: "disabled",
  isVoiceMode: false,
  isVoiceSwitching: false,
  isMuted: false,
  activeServerId: null,
  activeAgentId: null,
};

const INITIAL_TELEMETRY: VoiceRuntimeTelemetrySnapshot = {
  volume: 0,
  isSpeaking: false,
  segmentDuration: 0,
};

let nextVoiceRuntimeInstanceId = 1;

function snapshotsEqual(left: VoiceRuntimeSnapshot, right: VoiceRuntimeSnapshot): boolean {
  return (
    left.phase === right.phase &&
    left.isVoiceMode === right.isVoiceMode &&
    left.isVoiceSwitching === right.isVoiceSwitching &&
    left.isMuted === right.isMuted &&
    left.activeServerId === right.activeServerId &&
    left.activeAgentId === right.activeAgentId
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
  handleCapturePcm(chunk: Uint8Array): void;
  handleCaptureVolume(level: number): void;
  handleAudioOutput(serverId: string, payload: AudioOutputPayload): void;
  startVoice(serverId: string, agentId: string): Promise<void>;
  stopVoice(): Promise<void>;
  destroy(): Promise<void>;
  toggleMute(): void;
  isVoiceModeForAgent(serverId: string, agentId: string): boolean;
  shouldPlayVoiceAudio(serverId: string): boolean;
  onAssistantAudioStarted(serverId: string): void;
  onAssistantAudioFinished(serverId: string): void;
  onTranscriptionResult(serverId: string, text: string): void;
  onServerSpeechStateChanged(serverId: string, isSpeaking: boolean): void;
  onTurnEvent(serverId: string, agentId: string, eventType: TurnEventType): void;
}

export function createVoiceRuntime(deps: VoiceRuntimeDeps): VoiceRuntime {
  const instanceId = nextVoiceRuntimeInstanceId++;
  const listeners = new Set<() => void>();
  const telemetryListeners = new Set<() => void>();
  const sessions = new Map<string, RuntimeSessionState>();
  const state: RuntimeState = {
    snapshot: INITIAL_SNAPSHOT,
    telemetry: INITIAL_TELEMETRY,
    turnInProgress: false,
    serverSpeechDetected: false,
    transportReady: false,
    generation: 0,
    segmentDurationTimer: null,
    lastDisplayVolumePublishMs: 0,
    serverSpeechStartedAt: null,
  };
  const playback: RuntimePlaybackState = {
    groups: new Map(),
    orderedGroupIds: [],
    activeGroupId: null,
    processing: false,
    generation: 0,
  };
  const cue: CueState = {
    active: false,
    token: 0,
    timeout: null,
    playing: false,
  };
  const cuePcm16 = Uint8Array.from(Buffer.from(THINKING_TONE_NATIVE_PCM_BASE64, "base64"));
  const cueSource = {
    size: cuePcm16.byteLength,
    type: "audio/pcm;rate=16000;bits=16",
    async arrayBuffer() {
      return cuePcm16.buffer.slice(cuePcm16.byteOffset, cuePcm16.byteOffset + cuePcm16.byteLength);
    },
  };
  function emit(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  function emitTelemetry(): void {
    for (const listener of telemetryListeners) {
      listener();
    }
  }

  function patchSnapshot(
    patch:
      | Partial<VoiceRuntimeSnapshot>
      | ((previous: VoiceRuntimeSnapshot) => VoiceRuntimeSnapshot),
  ): void {
    const next =
      typeof patch === "function" ? patch(state.snapshot) : { ...state.snapshot, ...patch };
    if (snapshotsEqual(next, state.snapshot)) {
      return;
    }
    const previous = state.snapshot;
    state.snapshot = next;
    emit();
  }

  function patchTelemetry(
    patch:
      | Partial<VoiceRuntimeTelemetrySnapshot>
      | ((previous: VoiceRuntimeTelemetrySnapshot) => VoiceRuntimeTelemetrySnapshot),
  ): void {
    const next =
      typeof patch === "function" ? patch(state.telemetry) : { ...state.telemetry, ...patch };
    if (telemetryEqual(next, state.telemetry)) {
      return;
    }
    state.telemetry = next;
    emitTelemetry();
  }

  function getActiveSession(): RuntimeSessionState | null {
    if (!state.snapshot.activeServerId) {
      return null;
    }
    return sessions.get(state.snapshot.activeServerId) ?? null;
  }

  function decodeAudioChunk(base64: string): Uint8Array {
    return Buffer.from(base64, "base64");
  }

  function toPlaybackSource(
    bytes: Uint8Array,
    format: string,
  ): { arrayBuffer(): Promise<ArrayBuffer>; size: number; type: string } {
    const mimeType =
      format === "pcm"
        ? "audio/pcm;rate=24000;bits=16"
        : format === "mp3"
          ? "audio/mpeg"
          : `audio/${format}`;

    return {
      size: bytes.byteLength,
      type: mimeType,
      async arrayBuffer() {
        return Uint8Array.from(bytes).buffer;
      },
    };
  }

  function resetPlaybackState(): void {
    playback.generation += 1;
    playback.groups.clear();
    playback.orderedGroupIds = [];
    playback.activeGroupId = null;
    playback.processing = false;
  }

  function activateNextPlaybackGroup(): void {
    while (playback.orderedGroupIds.length > 0) {
      const groupId = playback.orderedGroupIds[0]!;
      if (playback.groups.has(groupId)) {
        playback.activeGroupId = groupId;
        return;
      }
      playback.orderedGroupIds.shift();
    }
    playback.activeGroupId = null;
  }

  async function acknowledgeChunk(chunkId: string): Promise<void> {
    const activeSession = getActiveSession();
    if (!activeSession) {
      return;
    }
    await activeSession.adapter.audioPlayed(chunkId);
  }

  async function processPlaybackQueue(serverId: string): Promise<void> {
    if (playback.processing) {
      return;
    }

    playback.processing = true;
    const generation = playback.generation;
    try {
      while (playback.activeGroupId) {
        if (generation !== playback.generation) {
          return;
        }

        const group = playback.groups.get(playback.activeGroupId);
        if (!group) {
          activateNextPlaybackGroup();
          continue;
        }

        const nextChunk = group.chunks.get(group.nextChunkToPlay);
        if (!nextChunk) {
          if (group.finalChunkIndex !== null && group.nextChunkToPlay > group.finalChunkIndex) {
            playback.groups.delete(group.groupId);
            if (playback.orderedGroupIds[0] === group.groupId) {
              playback.orderedGroupIds.shift();
            } else {
              playback.orderedGroupIds = playback.orderedGroupIds.filter(
                (value) => value !== group.groupId,
              );
            }
            if (group.started && group.isVoiceMode) {
              api.onAssistantAudioFinished(serverId);
            }
            activateNextPlaybackGroup();
            continue;
          }
          return;
        }

        group.chunks.delete(group.nextChunkToPlay);

        if (group.shouldPlay && !group.started && group.isVoiceMode) {
          group.started = true;
          api.onAssistantAudioStarted(serverId);
        }

        try {
          if (group.shouldPlay) {
            await deps.engine.play(nextChunk.source);
          }
        } catch (error) {
          if (generation !== playback.generation) {
            return;
          }
          console.error(`[VoiceRuntime] play error chunk=${group.nextChunkToPlay}:`, error);
        }

        if (generation !== playback.generation) {
          return;
        }

        if (!group.ackedChunkIds.has(nextChunk.id)) {
          group.ackedChunkIds.add(nextChunk.id);
          void acknowledgeChunk(nextChunk.id).catch((error) => {
            console.warn("[VoiceRuntime] Failed to confirm audio playback:", error);
          });
        }

        group.nextChunkToPlay += 1;
      }
    } finally {
      if (generation === playback.generation) {
        playback.processing = false;
      }
    }
  }

  function clearSegmentDurationTimer(): void {
    if (state.segmentDurationTimer) {
      clearInterval(state.segmentDurationTimer);
      state.segmentDurationTimer = null;
    }
  }

  function reconcileSegmentDurationTimer(): void {
    if (!state.serverSpeechDetected) {
      clearSegmentDurationTimer();
      patchTelemetry((prev) => ({ ...prev, segmentDuration: 0 }));
      return;
    }

    if (state.segmentDurationTimer) {
      return;
    }

    state.segmentDurationTimer = setInterval(() => {
      const startedAt = state.serverSpeechStartedAt;
      patchTelemetry((prev) => ({
        ...prev,
        segmentDuration: startedAt ? Date.now() - startedAt : 0,
      }));
    }, 100);
  }

  function canPlayCue(): boolean {
    return (
      state.snapshot.isVoiceMode &&
      state.snapshot.phase === "waiting" &&
      !state.telemetry.isSpeaking
    );
  }

  function stopCue(): void {
    const hadActive = cue.active || cue.timeout !== null || cue.playing;
    cue.active = false;
    cue.token += 1;
    if (cue.timeout) {
      clearTimeout(cue.timeout);
      cue.timeout = null;
    }
    cue.playing = false;
    if (hadActive) {
      deps.engine.stop();
      deps.engine.clearQueue();
    }
  }

  function resetCaptureTelemetry(): void {
    clearSegmentDurationTimer();
    state.serverSpeechStartedAt = null;
    patchTelemetry({ ...INITIAL_TELEMETRY });
  }

  function reconcileCue(): void {
    if (!canPlayCue()) {
      stopCue();
      return;
    }
    if (cue.active) {
      return;
    }
    cue.active = true;
    cue.token += 1;
    const token = cue.token;

    const playNext = () => {
      if (!cue.active || cue.token !== token) {
        return;
      }
      cue.playing = true;
      void deps.engine
        .play(cueSource)
        .catch((error) => {
          if (cue.token !== token) {
            return;
          }
          console.warn(`[VoiceRuntime#${instanceId}] Cue playback failed:`, error);
        })
        .finally(() => {
          cue.playing = false;
          if (!cue.active || cue.token !== token) {
            return;
          }
          cue.timeout = setTimeout(
            playNext,
            THINKING_TONE_NATIVE_PCM_DURATION_MS + THINKING_TONE_REPEAT_GAP_MS,
          );
        });
    };

    playNext();
  }

  const uploader: ContinuousVoiceUploader = {
    reset() {},
    pushPcmChunk(chunk) {
      const activeSession = getActiveSession();
      if (
        !activeSession ||
        !state.transportReady ||
        !state.snapshot.isVoiceMode ||
        chunk.byteLength === 0
      ) {
        return;
      }

      const base64 = Buffer.from(chunk).toString("base64");

      void activeSession.adapter.sendVoiceAudioChunk(base64, PCM_MIME_TYPE).catch((error) => {
        console.error(`[VoiceRuntime#${instanceId}] Failed to send audio chunk:`, error);
      });
    },
  };

  function resetToDisabledState(): void {
    state.transportReady = false;
    state.turnInProgress = false;
    state.serverSpeechDetected = false;
    state.lastDisplayVolumePublishMs = 0;
    uploader.reset();
    resetCaptureTelemetry();
    patchSnapshot({ ...INITIAL_SNAPSHOT });
  }

  function publishDisplayVolume(level: number, nowMs: number): void {
    const previousVolume = state.telemetry.volume;
    const smoothing = level >= previousVolume ? DISPLAY_VOLUME_ATTACK : DISPLAY_VOLUME_RELEASE;
    const nextVolume = Math.max(
      0,
      Math.min(1, previousVolume + (level - previousVolume) * smoothing),
    );
    const enoughTimeElapsed =
      nowMs - state.lastDisplayVolumePublishMs >= DISPLAY_VOLUME_PUBLISH_INTERVAL_MS;
    const enoughChange = Math.abs(nextVolume - previousVolume) >= DISPLAY_VOLUME_CHANGE_EPSILON;

    if (!enoughTimeElapsed && !enoughChange) {
      return;
    }

    state.lastDisplayVolumePublishMs = nowMs;
    patchTelemetry((prev) => ({
      ...prev,
      volume: Number(nextVolume.toFixed(3)),
    }));
  }

  async function performLocalStop(): Promise<void> {
    stopCue();
    uploader.reset();
    resetPlaybackState();
    deps.engine.stop();
    deps.engine.clearQueue();
    await deps.engine.stopCapture().catch(() => undefined);
    await deps.deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
    getActiveSession()?.adapter.setAssistantAudioPlaying(false);
    resetToDisabledState();
  }

  async function resyncVoiceMode(serverId: string): Promise<void> {
    if (
      !state.snapshot.isVoiceMode ||
      state.snapshot.activeServerId !== serverId ||
      !state.snapshot.activeAgentId
    ) {
      return;
    }

    const activeSession = getActiveSession();
    if (!activeSession || !activeSession.connected) {
      return;
    }

    patchSnapshot((prev) => ({ ...prev, isVoiceSwitching: true }));
    try {
      await activeSession.adapter.setVoiceMode(true, state.snapshot.activeAgentId);
      state.transportReady = true;
    } finally {
      patchSnapshot((prev) => ({ ...prev, isVoiceSwitching: false }));
    }
  }

  const api: VoiceRuntime = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot() {
      return state.snapshot;
    },

    subscribeTelemetry(listener) {
      telemetryListeners.add(listener);
      return () => {
        telemetryListeners.delete(listener);
      };
    },

    getTelemetrySnapshot() {
      return state.telemetry;
    },

    registerSession(adapter) {
      sessions.set(adapter.serverId, {
        adapter,
        connected: true,
      });

      return () => {
        const activeServerId = state.snapshot.activeServerId;
        sessions.delete(adapter.serverId);
        if (activeServerId === adapter.serverId) {
          void performLocalStop();
        }
      };
    },

    updateSessionConnection(serverId, connected) {
      const session = sessions.get(serverId);
      if (!session) {
        return;
      }
      session.connected = connected;
      if (state.snapshot.activeServerId !== serverId) {
        return;
      }
      if (!connected) {
        state.transportReady = false;
        return;
      }
      void resyncVoiceMode(serverId);
    },

    handleCapturePcm(chunk) {
      if (!state.snapshot.isVoiceMode || state.snapshot.isMuted) {
        return;
      }
      uploader.pushPcmChunk(chunk);
    },

    handleCaptureVolume(level) {
      const nowMs = Date.now();
      const displayLevel = state.snapshot.isMuted ? 0 : level;
      publishDisplayVolume(displayLevel, nowMs);
      if (!state.snapshot.isVoiceMode || state.snapshot.isMuted) {
        patchTelemetry((prev) => ({
          ...prev,
          isSpeaking: false,
          segmentDuration: 0,
        }));
        return;
      }

      patchTelemetry((prev) => ({
        ...prev,
        isSpeaking: state.serverSpeechDetected,
      }));
      reconcileSegmentDurationTimer();
      reconcileCue();
    },

    handleAudioOutput(serverId, payload) {
      if (
        serverId !== state.snapshot.activeServerId ||
        !state.snapshot.isVoiceMode ||
        !payload.isVoiceMode
      ) {
        return;
      }

      const groupId = payload.groupId ?? payload.id;
      const chunkIndex = payload.chunkIndex ?? 0;
      const decoded = decodeAudioChunk(payload.audio);

      let group = playback.groups.get(groupId);
      if (!group) {
        group = {
          groupId,
          isVoiceMode: payload.isVoiceMode,
          shouldPlay: api.shouldPlayVoiceAudio(serverId),
          chunks: new Map(),
          nextChunkToPlay: 0,
          finalChunkIndex: null,
          started: false,
          ackedChunkIds: new Set(),
        };
        playback.groups.set(groupId, group);
        playback.orderedGroupIds.push(groupId);
        if (!playback.activeGroupId) {
          playback.activeGroupId = groupId;
        }
      }

      group.chunks.set(chunkIndex, {
        id: payload.id,
        chunkIndex,
        source: toPlaybackSource(decoded, payload.format),
      });
      if (payload.isLastChunk) {
        group.finalChunkIndex = chunkIndex;
      }

      void processPlaybackQueue(serverId);
    },

    async startVoice(serverId, agentId) {
      const session = sessions.get(serverId);
      if (!session) {
        throw new Error(`Voice runtime is not ready for host ${serverId}`);
      }
      if (!session.connected) {
        throw new Error(`Host ${serverId} is not connected`);
      }

      const serverInfo = deps.getServerInfo(serverId);
      const unavailableMessage = resolveVoiceUnavailableMessage({
        serverInfo,
        mode: "voice",
      });
      if (unavailableMessage) {
        throw new Error(unavailableMessage);
      }

      const previousServerId = state.snapshot.activeServerId;
      const previousAgentId = state.snapshot.activeAgentId;
      const generation = state.generation + 1;
      state.generation = generation;
      state.transportReady = false;
      patchSnapshot((prev) => ({
        ...prev,
        isVoiceSwitching: true,
        phase: "starting",
        activeServerId: serverId,
        activeAgentId: agentId,
      }));

      try {
        if (
          state.snapshot.isVoiceMode &&
          previousServerId &&
          (previousServerId !== serverId || previousAgentId !== agentId)
        ) {
          const previousSession = sessions.get(previousServerId);
          if (previousSession) {
            previousSession.adapter.setAssistantAudioPlaying(false);
            await previousSession.adapter.setVoiceMode(false);
          }
        }

        await deps.activateKeepAwake(KEEP_AWAKE_TAG).catch((error) => {
          console.warn("[VoiceRuntime] Failed to activate keep-awake:", error);
        });

        await deps.engine.initialize();
        await session.adapter.setVoiceMode(true, agentId);
        await deps.engine.startCapture();
        if (state.generation !== generation) {
          return;
        }

        state.transportReady = true;
        state.turnInProgress = false;
        uploader.reset();
        resetCaptureTelemetry();
        patchSnapshot((prev) => ({
          ...prev,
          isVoiceMode: true,
          isVoiceSwitching: false,
          phase: "listening",
          isMuted: deps.engine.isMuted(),
        }));
      } catch (error) {
        await performLocalStop();
        throw error;
      }
    },

    async stopVoice() {
      const activeSession = getActiveSession();
      const generation = state.generation + 1;
      state.generation = generation;
      patchSnapshot((prev) => ({
        ...prev,
        isVoiceSwitching: true,
        phase: "stopping",
      }));

      try {
        stopCue();
        uploader.reset();
        state.transportReady = false;
        resetPlaybackState();
        deps.engine.stop();
        deps.engine.clearQueue();
        activeSession?.adapter.setAssistantAudioPlaying(false);
        if (activeSession) {
          await activeSession.adapter.setVoiceMode(false);
        }
        await deps.engine.stopCapture();
        await deps.deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
      } finally {
        if (state.generation === generation) {
          resetToDisabledState();
        }
      }
    },

    async destroy() {
      await this.stopVoice().catch(() => undefined);
      await deps.engine.destroy();
      listeners.clear();
      telemetryListeners.clear();
      sessions.clear();
    },

    toggleMute() {
      const nextMuted = deps.engine.toggleMute();
      if (nextMuted) {
        uploader.reset();
        resetCaptureTelemetry();
        patchSnapshot((prev) => ({
          ...prev,
          isMuted: true,
        }));
        reconcileCue();
        return;
      }

      patchSnapshot((prev) => ({ ...prev, isMuted: false }));
    },

    isVoiceModeForAgent(serverId, agentId) {
      return (
        state.snapshot.isVoiceMode &&
        state.snapshot.activeServerId === serverId &&
        state.snapshot.activeAgentId === agentId
      );
    },

    shouldPlayVoiceAudio(serverId) {
      return (
        state.snapshot.isVoiceMode &&
        state.snapshot.activeServerId === serverId &&
        state.snapshot.phase !== "stopping" &&
        state.snapshot.phase !== "disabled"
      );
    },

    onAssistantAudioStarted(serverId) {
      if (!state.snapshot.isVoiceMode || state.snapshot.activeServerId !== serverId) {
        return;
      }
      stopCue();
      getActiveSession()?.adapter.setAssistantAudioPlaying(true);
      patchSnapshot((prev) => ({ ...prev, phase: "playing" }));
    },

    onAssistantAudioFinished(serverId) {
      if (state.snapshot.activeServerId !== serverId) {
        return;
      }

      getActiveSession()?.adapter.setAssistantAudioPlaying(false);
      if (!state.snapshot.isVoiceMode) {
        return;
      }

      if (state.turnInProgress) {
        patchSnapshot((prev) => ({ ...prev, phase: "waiting" }));
        reconcileCue();
        return;
      }

      patchSnapshot((prev) => ({ ...prev, phase: "listening" }));
      reconcileCue();
    },

    onTranscriptionResult(serverId, text) {
      if (serverId !== state.snapshot.activeServerId || !state.snapshot.isVoiceMode) {
        return;
      }

      if (text.trim()) {
        state.turnInProgress = true;
        patchSnapshot((prev) => ({ ...prev, phase: "waiting" }));
        reconcileCue();
        return;
      }

      state.turnInProgress = false;
      patchSnapshot((prev) => ({ ...prev, phase: "listening" }));
      stopCue();
    },

    onServerSpeechStateChanged(serverId, isSpeaking) {
      if (serverId !== state.snapshot.activeServerId || !state.snapshot.isVoiceMode) {
        return;
      }

      state.serverSpeechDetected = isSpeaking;
      state.serverSpeechStartedAt = isSpeaking ? (state.serverSpeechStartedAt ?? Date.now()) : null;
      if (isSpeaking) {
        const shouldInterruptPlayback =
          state.snapshot.phase === "playing" || playback.groups.size > 0;
        const hadCue = cue.active || cue.timeout !== null || cue.playing;
        resetPlaybackState();
        stopCue();
        if (shouldInterruptPlayback && !hadCue) {
          deps.engine.stop();
          deps.engine.clearQueue();
        }
        getActiveSession()?.adapter.setAssistantAudioPlaying(false);
      }
      patchTelemetry((prev) => ({
        ...prev,
        isSpeaking,
      }));
      reconcileSegmentDurationTimer();
      reconcileCue();
    },

    onTurnEvent(serverId, agentId, eventType) {
      if (
        !state.snapshot.isVoiceMode ||
        state.snapshot.activeServerId !== serverId ||
        state.snapshot.activeAgentId !== agentId
      ) {
        return;
      }

      if (eventType === "turn_started") {
        state.turnInProgress = true;
        if (state.snapshot.phase !== "playing") {
          patchSnapshot((prev) => ({ ...prev, phase: "waiting" }));
          reconcileCue();
        }
        return;
      }

      state.turnInProgress = false;
      if (state.snapshot.phase !== "playing") {
        patchSnapshot((prev) => ({ ...prev, phase: "listening" }));
      }
      stopCue();
    },
  };

  return api;
}
