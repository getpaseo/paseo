import { Buffer } from "buffer";
import { z } from "zod";
import type { VoiceCallState } from "@getpaseo/protocol/messages";
import type { AudioEngine } from "@/voice/audio-engine-types";
import type {
  PreparedVoiceClientTransport,
  VoiceClientTransport,
  VoiceClientTransportFactory,
  VoiceTransportMediaState,
  VoiceTransportSession,
} from "@/voice-chat/transport";

const PCM_MIME_TYPE = "audio/pcm;rate=16000;bits=16";
const DISPLAY_VOLUME_PUBLISH_INTERVAL_MS = 120;
const DISPLAY_VOLUME_CHANGE_EPSILON = 0.02;
const DISPLAY_VOLUME_ATTACK = 0.35;
const DISPLAY_VOLUME_RELEASE = 0.18;

const DaemonAudioServerMessageSchema = z.object({
  type: z.literal("audio"),
  outputId: z.string(),
  audio: z.string(),
  format: z.string(),
  groupId: z.string().optional(),
  chunkIndex: z.number().int().nonnegative().optional(),
  isLastChunk: z.boolean().optional(),
});

interface PlaybackSource {
  arrayBuffer(): Promise<ArrayBuffer>;
  size: number;
  type: string;
}

interface PlaybackChunk {
  id: string;
  source: PlaybackSource;
}

interface PlaybackGroup {
  groupId: string;
  chunks: Map<number, PlaybackChunk>;
  nextChunkToPlay: number;
  finalChunkIndex: number | null;
  started: boolean;
  acknowledged: Set<string>;
}

interface PlaybackState {
  groups: Map<string, PlaybackGroup>;
  orderedGroupIds: string[];
  activeGroupId: string | null;
  processing: boolean;
  generation: number;
}

export interface DaemonAudioTransportFactory extends VoiceClientTransportFactory {
  handleCapturePcm(chunk: Uint8Array): void;
  handleCaptureVolume(level: number): void;
}

export function createDaemonAudioTransportFactory(input: {
  engine: AudioEngine;
  onError(error: unknown): void;
}): DaemonAudioTransportFactory {
  let active: DaemonAudioTransport | null = null;

  return {
    async prepare(session) {
      return createPreparedDaemonAudioTransport({
        engine: input.engine,
        onError: input.onError,
        session,
        activate(transport) {
          active = transport;
        },
        deactivate(transport) {
          if (active === transport) active = null;
        },
      });
    },
    handleCapturePcm(chunk) {
      active?.handleCapturePcm(chunk);
    },
    handleCaptureVolume(level) {
      active?.handleCaptureVolume(level);
    },
  };
}

function createPreparedDaemonAudioTransport(input: {
  engine: AudioEngine;
  onError(error: unknown): void;
  session: VoiceTransportSession;
  activate(transport: DaemonAudioTransport): void;
  deactivate(transport: DaemonAudioTransport): void;
}): PreparedVoiceClientTransport {
  return {
    offer: { kind: "daemon-audio" },
    accepts(answer) {
      return answer.kind === "daemon-audio";
    },
    async accept({ callId, answer, publish }) {
      if (answer.kind !== "daemon-audio") {
        throw new Error(`Daemon audio cannot accept '${answer.kind}'`);
      }
      const transport = new DaemonAudioTransport({
        callId,
        engine: input.engine,
        onError: input.onError,
        session: input.session,
        publish,
        deactivate: input.deactivate,
      });
      input.activate(transport);
      return transport;
    },
    async discard() {},
  };
}

class DaemonAudioTransport implements VoiceClientTransport {
  private readonly callId: string;
  private readonly engine: AudioEngine;
  private readonly onError: (error: unknown) => void;
  private readonly session: VoiceTransportSession;
  private readonly publish: (state: VoiceTransportMediaState) => void;
  private readonly deactivate: (transport: DaemonAudioTransport) => void;
  private media: VoiceTransportMediaState = { isMuted: false, volume: 0, output: "idle" };
  private playback: PlaybackState = {
    groups: new Map(),
    orderedGroupIds: [],
    activeGroupId: null,
    processing: false,
    generation: 0,
  };
  private started = false;
  private stopped = false;
  private lastVolumePublishMs = 0;

  constructor(input: {
    callId: string;
    engine: AudioEngine;
    onError(error: unknown): void;
    session: VoiceTransportSession;
    publish(state: VoiceTransportMediaState): void;
    deactivate(transport: DaemonAudioTransport): void;
  }) {
    this.callId = input.callId;
    this.engine = input.engine;
    this.onError = input.onError;
    this.session = input.session;
    this.publish = input.publish;
    this.deactivate = input.deactivate;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.engine.initialize();
    await this.engine.startCapture();
    this.started = true;
    this.patchMedia({ isMuted: this.engine.isMuted() });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.resetPlayback();
    this.engine.stop();
    this.engine.clearQueue();
    this.session.setAssistantAudioPlaying(false);
    await this.engine.stopCapture().catch(() => undefined);
    this.deactivate(this);
    this.patchMedia({ volume: 0, output: "idle" });
  }

  handleCapturePcm(chunk: Uint8Array): void {
    if (!this.started || this.stopped || this.media.isMuted || chunk.byteLength === 0) return;
    this.session.sendTransportMessage(this.callId, {
      type: "append",
      audio: Buffer.from(chunk).toString("base64"),
      format: PCM_MIME_TYPE,
    });
  }

  handleCaptureVolume(level: number): void {
    const now = Date.now();
    const displayed = this.media.isMuted ? 0 : level;
    const smoothing =
      displayed >= this.media.volume ? DISPLAY_VOLUME_ATTACK : DISPLAY_VOLUME_RELEASE;
    const next = Math.max(
      0,
      Math.min(1, this.media.volume + (displayed - this.media.volume) * smoothing),
    );
    const enoughTime = now - this.lastVolumePublishMs >= DISPLAY_VOLUME_PUBLISH_INTERVAL_MS;
    const enoughChange = Math.abs(next - this.media.volume) >= DISPLAY_VOLUME_CHANGE_EPSILON;
    if (!enoughTime && !enoughChange) return;
    this.lastVolumePublishMs = now;
    this.patchMedia({ volume: Number(next.toFixed(3)) });
  }

  handleServerMessage(data: unknown): void {
    if (this.stopped) return;
    const parsed = DaemonAudioServerMessageSchema.safeParse(data);
    if (!parsed.success) return;
    const payload = parsed.data;
    const groupId = payload.groupId ?? payload.outputId;
    const chunkIndex = payload.chunkIndex ?? 0;
    let group = this.playback.groups.get(groupId);
    if (!group) {
      group = {
        groupId,
        chunks: new Map(),
        nextChunkToPlay: 0,
        finalChunkIndex: null,
        started: false,
        acknowledged: new Set(),
      };
      this.playback.groups.set(groupId, group);
      this.playback.orderedGroupIds.push(groupId);
      this.playback.activeGroupId ??= groupId;
    }
    group.chunks.set(chunkIndex, {
      id: payload.outputId,
      source: toPlaybackSource(Buffer.from(payload.audio, "base64"), payload.format),
    });
    if (payload.isLastChunk) group.finalChunkIndex = chunkIndex;
    void this.processPlayback();
  }

  updateCallState(state: VoiceCallState): void {
    if (state.callId !== this.callId || state.input !== "speech_detected") return;
    const hadPlayback = this.playback.groups.size > 0;
    this.resetPlayback();
    if (hadPlayback) {
      this.engine.stop();
      this.engine.clearQueue();
      this.session.setAssistantAudioPlaying(false);
      this.patchMedia({ output: "idle" });
    }
  }

  toggleMute(): void {
    const isMuted = this.engine.toggleMute();
    this.patchMedia({ isMuted, ...(isMuted ? { volume: 0 } : {}) });
  }

  private patchMedia(patch: Partial<VoiceTransportMediaState>): void {
    this.media = { ...this.media, ...patch };
    this.publish(this.media);
  }

  private resetPlayback(): void {
    this.playback.generation += 1;
    this.playback.groups.clear();
    this.playback.orderedGroupIds = [];
    this.playback.activeGroupId = null;
    this.playback.processing = false;
  }

  private activateNextGroup(): void {
    while (this.playback.orderedGroupIds.length > 0) {
      const groupId = this.playback.orderedGroupIds[0];
      if (this.playback.groups.has(groupId)) {
        this.playback.activeGroupId = groupId;
        return;
      }
      this.playback.orderedGroupIds.shift();
    }
    this.playback.activeGroupId = null;
  }

  private retireGroup(group: PlaybackGroup): void {
    this.playback.groups.delete(group.groupId);
    this.playback.orderedGroupIds = this.playback.orderedGroupIds.filter(
      (groupId) => groupId !== group.groupId,
    );
    if (group.started && this.playback.groups.size === 0) {
      this.session.setAssistantAudioPlaying(false);
      this.patchMedia({ output: "idle" });
    }
  }

  private async processPlayback(): Promise<void> {
    if (this.playback.processing) return;
    this.playback.processing = true;
    const generation = this.playback.generation;
    try {
      while (this.playback.activeGroupId && generation === this.playback.generation) {
        const group = this.playback.groups.get(this.playback.activeGroupId);
        if (!group) {
          this.activateNextGroup();
          continue;
        }
        const chunk = group.chunks.get(group.nextChunkToPlay);
        if (!chunk) {
          const complete =
            group.finalChunkIndex !== null && group.nextChunkToPlay > group.finalChunkIndex;
          if (!complete) return;
          this.retireGroup(group);
          this.activateNextGroup();
          continue;
        }
        group.chunks.delete(group.nextChunkToPlay);
        if (!group.started) {
          group.started = true;
          this.session.setAssistantAudioPlaying(true);
          this.patchMedia({ output: "speaking" });
        }
        try {
          await this.engine.play(chunk.source);
        } catch (error) {
          if (generation !== this.playback.generation) return;
          this.onError(error);
          return;
        }
        if (generation !== this.playback.generation) return;
        if (!group.acknowledged.has(chunk.id)) {
          group.acknowledged.add(chunk.id);
          this.session.sendTransportMessage(this.callId, {
            type: "played",
            outputId: chunk.id,
          });
        }
        group.nextChunkToPlay += 1;
      }
    } finally {
      if (generation === this.playback.generation) this.playback.processing = false;
    }
  }
}

function toPlaybackSource(bytes: Uint8Array, format: string): PlaybackSource {
  const type = resolveMimeType(format);
  return {
    size: bytes.byteLength,
    type,
    async arrayBuffer() {
      return Uint8Array.from(bytes).buffer;
    },
  };
}

function resolveMimeType(format: string): string {
  if (format === "pcm") return "audio/pcm;rate=24000;bits=16";
  if (format === "mp3") return "audio/mpeg";
  return `audio/${format}`;
}
