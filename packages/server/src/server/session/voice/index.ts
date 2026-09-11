import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { OwnedOperation, SessionDelivery } from "../owned-subscriptions/index.js";
import { VoiceSession, type VoiceSessionOptions } from "./voice-session.js";

type VoiceMessage = Extract<
  SessionInboundMessage,
  {
    type:
      | "voice_audio_chunk"
      | "abort_request"
      | "audio_played"
      | "set_voice_mode"
      | "dictation_stream_start"
      | "dictation_stream_chunk"
      | "dictation_stream_finish"
      | "dictation_stream_cancel";
  }
>;

interface ActiveVoiceSource {
  voice: VoiceSession;
  owner: OwnedOperation;
  pending: Set<Promise<void>>;
  closing: boolean;
}

/** Audio conversations belong to their requesting socket, including bootstrap and finalization. */
export class VoiceSessions {
  private readonly sources = new Map<object, ActiveVoiceSource>();

  constructor(
    private readonly options: VoiceSessionOptions,
    private readonly delivery: SessionDelivery,
    private readonly demandChanged: () => void,
  ) {}

  get hasDemand(): boolean {
    return [...this.sources.values()].some((source) => !source.closing);
  }

  isActiveForAgent(agentId: string): boolean {
    return [...this.sources.values()].some(
      (source) => !source.closing && source.voice.isActiveForAgent(agentId),
    );
  }

  handleMessage(message: VoiceMessage): Promise<void> {
    const source = this.delivery.currentSource;
    if (!source) throw new Error("Voice request has no source");
    const existing = this.sources.get(source);
    if (existing?.closing) return existing.owner.release().then(() => this.handleMessage(message));
    const active = existing ?? this.startSource(source);
    const pending = Promise.resolve().then(() => {
      return active.closing ? undefined : this.dispatch(active.voice, message);
    });
    active.pending.add(pending);
    const finished = () => {
      active.pending.delete(pending);
      this.releaseIdle(active);
      return undefined;
    };
    void pending.then(finished, finished);
    return pending;
  }

  private startSource(source: object): ActiveVoiceSource {
    const owner = this.delivery.operation(isVoiceOutput, async () => {
      active.closing = true;
      this.demandChanged();
      // Cancel input immediately; restore agent configuration after bootstrap has settled.
      try {
        active.voice.cancel();
      } finally {
        await Promise.allSettled(active.pending);
        await active.voice.cleanup();
      }
      if (this.sources.get(source) === active) this.sources.delete(source);
    });
    const active: ActiveVoiceSource = {
      owner,
      pending: new Set(),
      closing: false,
      voice: new VoiceSession({
        ...this.options,
        host: { ...this.options.host, emit: (message) => owner.emit(message) },
        onIdle: () => this.releaseIdle(active),
      }),
    };
    this.sources.set(source, active);
    this.demandChanged();
    return active;
  }

  private releaseIdle(source: ActiveVoiceSource): void {
    if (source.closing || source.pending.size > 0 || source.voice.hasDemand) return;
    void source.owner
      .release()
      .catch((error) =>
        this.options.logger.error({ err: error }, "Failed to release voice source"),
      );
  }

  private async dispatch(voice: VoiceSession, message: VoiceMessage): Promise<void> {
    switch (message.type) {
      case "voice_audio_chunk":
        return voice.handleAudioChunk(message);
      case "abort_request":
        return voice.handleAbort();
      case "audio_played":
        return voice.handleAudioPlayed(message.id);
      case "set_voice_mode":
        return voice.handleSetVoiceMode(message.enabled, message.agentId, message.requestId);
      case "dictation_stream_start":
        return voice.handleDictationStreamStart(message);
      case "dictation_stream_chunk":
        return voice.handleDictationChunk({
          dictationId: message.dictationId,
          seq: message.seq,
          audioBase64: message.audio,
          format: message.format,
        });
      case "dictation_stream_finish":
        return voice.handleDictationFinish(message.dictationId, message.finalSeq);
      case "dictation_stream_cancel":
        return voice.handleDictationCancel(message.dictationId);
    }
  }
}

function isVoiceOutput(message: SessionOutboundMessage): boolean {
  switch (message.type) {
    case "audio_output":
    case "transcription_result":
    case "voice_input_state":
    case "set_voice_mode_response":
    case "dictation_stream_ack":
    case "dictation_stream_partial":
    case "dictation_stream_final":
    case "dictation_stream_error":
    case "dictation_stream_finish_accepted":
    case "activity_log":
      return true;
    default:
      return false;
  }
}
