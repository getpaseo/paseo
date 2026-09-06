import type { Logger } from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import {
  DictationStreamManager,
  type DictationStreamOutboundMessage,
} from "../../dictation/dictation-stream-manager.js";
import type { SpeechToTextProvider } from "../../speech/speech-provider.js";
import type { Resolvable } from "../../speech/provider-resolver.js";
import type { SpeechReadinessSnapshot } from "../../speech/speech-runtime.js";

function resolveUnavailableSpeech(readiness: SpeechReadinessSnapshot | undefined) {
  if (!readiness) return null;
  if (!readiness.voiceFeature.available) return readiness.voiceFeature;
  if (!readiness.dictation.enabled || !readiness.dictation.available) {
    return readiness.dictation;
  }
  return null;
}

export interface DictationSession {
  start(message: Extract<SessionInboundMessage, { type: "dictation_stream_start" }>): Promise<void>;
  append(input: {
    dictationId: string;
    seq: number;
    audioBase64: string;
    format: string;
  }): Promise<void>;
  finish(dictationId: string, finalSeq: number): Promise<void>;
  cancel(dictationId: string): void;
  close(): Promise<void>;
}

export function createDictationSession(options: {
  logger: Logger;
  sessionId: string;
  emit(message: SessionOutboundMessage): void;
  stt: Resolvable<SpeechToTextProvider | null>;
  language?: string;
  finalTimeoutMs?: number;
  getSpeechReadiness?: () => SpeechReadinessSnapshot;
}): DictationSession {
  const manager = new DictationStreamManager({
    logger: options.logger,
    sessionId: options.sessionId,
    emit(message: DictationStreamOutboundMessage) {
      options.emit(message as SessionOutboundMessage);
    },
    stt: options.stt,
    language: options.language,
    finalTimeoutMs: options.finalTimeoutMs,
  });

  return {
    async start(message) {
      const readiness = options.getSpeechReadiness?.();
      const unavailable = resolveUnavailableSpeech(readiness);
      if (unavailable) {
        options.emit({
          type: "dictation_stream_error",
          payload: {
            dictationId: message.dictationId,
            error: unavailable.message,
            retryable: unavailable.retryable,
            reasonCode: unavailable.reasonCode,
            missingModelIds: [...unavailable.missingModelIds],
          },
        });
        return;
      }
      await manager.handleStart(message.dictationId, message.format);
    },
    append: (input) => manager.handleChunk(input),
    finish: (dictationId, finalSeq) => manager.handleFinish(dictationId, finalSeq),
    cancel: (dictationId) => manager.handleCancel(dictationId),
    async close() {
      manager.cleanupAll();
    },
  };
}
