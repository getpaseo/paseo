import { EventEmitter } from "node:events";

import {
  AudioTranscriptionConfigMode,
  GoogleGenAI,
  Modality,
  type LiveServerMessage,
} from "@google/genai";
import type { Logger } from "pino";
import { v4 } from "uuid";

import type { SpeechToTextProvider, StreamingTranscriptionSession } from "../../speech-provider.js";
import type { GeminiSttConfig } from "./config.js";

const PCM_SAMPLE_RATE = 16000;
const PCM_MIME_TYPE = `audio/pcm;rate=${PCM_SAMPLE_RATE}`;

interface GeminiLiveTranscriptionCallbacks {
  onPartial(text: string, language?: string): void;
  onFinal(text: string, language?: string): void;
  onError(error: unknown): void;
  onClose(reason: string): void;
}

export interface GeminiLiveTranscriptionConnection {
  startActivity(): void;
  sendAudio(pcm16: Buffer): void;
  endActivity(): void;
  close(): void;
}

export interface GeminiLiveTranscriptionApi {
  connect(
    config: GeminiSttConfig,
    callbacks: GeminiLiveTranscriptionCallbacks,
  ): Promise<GeminiLiveTranscriptionConnection>;
}

function transcriptionText(
  message: LiveServerMessage,
  kind: "partial" | "final",
): { text: string; language?: string } | undefined {
  const transcription =
    kind === "partial"
      ? message.serverContent?.interimInputTranscription
      : message.serverContent?.inputTranscription;
  if (typeof transcription?.text !== "string") {
    return undefined;
  }
  return {
    text: transcription.text,
    ...(transcription.languageCode ? { language: transcription.languageCode } : {}),
  };
}

function createGoogleLiveTranscriptionApi(apiKey: string): GeminiLiveTranscriptionApi {
  const client = new GoogleGenAI({ apiKey });

  return {
    async connect(config, callbacks) {
      const session = await client.live.connect({
        model: config.model,
        config: {
          responseModalities: [Modality.TEXT],
          inputAudioTranscription: {
            mode:
              config.mode === "smart"
                ? AudioTranscriptionConfigMode.SMART
                : AudioTranscriptionConfigMode.VERBATIM,
            ...(config.language ? { languageCodes: [config.language] } : {}),
          },
          realtimeInputConfig: {
            automaticActivityDetection: { disabled: true },
          },
        },
        callbacks: {
          onmessage(message) {
            const partial = transcriptionText(message, "partial");
            if (partial) {
              callbacks.onPartial(partial.text, partial.language);
            }
            const final = transcriptionText(message, "final");
            if (final) {
              callbacks.onFinal(final.text, final.language);
            }
          },
          onerror(event) {
            callbacks.onError(event.error ?? new Error(event.message));
          },
          onclose(event) {
            callbacks.onClose(event.reason);
          },
        },
      });

      return {
        startActivity() {
          session.sendRealtimeInput({ activityStart: {} });
        },
        sendAudio(pcm16) {
          session.sendRealtimeInput({
            audio: { data: pcm16.toString("base64"), mimeType: PCM_MIME_TYPE },
          });
        },
        endActivity() {
          session.sendRealtimeInput({ activityEnd: {} });
        },
        close() {
          session.close();
        },
      };
    },
  };
}

export class GeminiSTT implements SpeechToTextProvider {
  public readonly id = "gemini" as const;
  private readonly config: GeminiSttConfig;
  private readonly api: GeminiLiveTranscriptionApi;

  constructor(params: {
    apiKey: string;
    config: GeminiSttConfig;
    logger: Logger;
    api?: GeminiLiveTranscriptionApi;
  }) {
    this.config = params.config;
    this.api = params.api ?? createGoogleLiveTranscriptionApi(params.apiKey);
    params.logger
      .child({ provider: "gemini", component: "stt" })
      .info(
        { model: params.config.model, mode: params.config.mode },
        "Gemini Live STT initialized",
      );
  }

  public createSession(params: {
    logger: Logger;
    language?: string;
    prompt?: string;
  }): StreamingTranscriptionSession {
    const emitter = new EventEmitter();
    const logger = params.logger.child({ provider: "gemini", component: "stt-session" });
    const api = this.api;
    const config = this.config;
    const pendingSegmentIds: string[] = [];
    let connection: GeminiLiveTranscriptionConnection | null = null;
    let connected = false;
    let closing = false;
    let terminalErrorEmitted = false;
    let hasAudio = false;
    let currentSegmentId = v4();
    let previousSegmentId: string | null = null;

    function fail(error: unknown, message: string): void {
      if (closing || terminalErrorEmitted) {
        return;
      }
      terminalErrorEmitted = true;
      logger.error({ err: error }, message);
      emitter.emit("error", new Error("Gemini live transcription failed"));
    }

    function activeSegmentId(): string | undefined {
      return pendingSegmentIds[0] ?? (hasAudio ? currentSegmentId : undefined);
    }

    function finishCurrentSegment(): void {
      const segmentId = currentSegmentId;
      const committedAfter = previousSegmentId;
      currentSegmentId = v4();
      previousSegmentId = segmentId;
      emitter.emit("committed", { segmentId, previousSegmentId: committedAfter });

      if (!hasAudio) {
        emitter.emit("transcript", { segmentId, transcript: "", isFinal: true });
        return;
      }

      pendingSegmentIds.push(segmentId);
      hasAudio = false;
      connection?.endActivity();
    }

    return {
      requiredSampleRate: PCM_SAMPLE_RATE,
      async connect() {
        if (connected) {
          return;
        }
        closing = false;
        terminalErrorEmitted = false;
        try {
          connection = await api.connect(config, {
            onPartial(text, language) {
              const segmentId = activeSegmentId();
              if (segmentId) {
                emitter.emit("transcript", {
                  segmentId,
                  transcript: text,
                  isFinal: false,
                  ...(language ? { language } : {}),
                });
              }
            },
            onFinal(text, language) {
              const segmentId = pendingSegmentIds.shift();
              if (segmentId) {
                emitter.emit("transcript", {
                  segmentId,
                  transcript: text,
                  isFinal: true,
                  ...(language ? { language } : {}),
                });
              }
            },
            onError(error) {
              fail(error, "Gemini Live transcription connection failed");
            },
            onClose(reason) {
              connected = false;
              connection = null;
              if (!closing) {
                fail(new Error(reason || "Connection closed"), "Gemini Live transcription closed");
              }
            },
          });
          connected = true;
        } catch (error) {
          logger.error({ err: error }, "Failed to connect Gemini Live transcription");
          throw new Error("Gemini live transcription connection failed", { cause: error });
        }
      },
      appendPcm16(pcm16) {
        if (!connected || !connection) {
          emitter.emit("error", new Error("Gemini STT session not connected"));
          return;
        }
        try {
          if (!hasAudio) {
            connection.startActivity();
            hasAudio = true;
          }
          connection.sendAudio(pcm16);
        } catch (error) {
          fail(error, "Failed to send audio to Gemini Live transcription");
        }
      },
      commit() {
        if (!connected || !connection) {
          emitter.emit("error", new Error("Gemini STT session not connected"));
          return;
        }
        try {
          finishCurrentSegment();
        } catch (error) {
          fail(error, "Failed to commit Gemini Live transcription segment");
        }
      },
      clear() {
        if (!connected) {
          return;
        }
        // Streamed audio cannot be retracted. Keep the activity open so a silence tail
        // that produces no final transcript cannot desynchronize later segments.
        currentSegmentId = v4();
      },
      close() {
        closing = true;
        connected = false;
        hasAudio = false;
        pendingSegmentIds.length = 0;
        connection?.close();
        connection = null;
      },
      on(event: string, handler: (...args: never[]) => void) {
        emitter.on(event, handler as (...args: unknown[]) => void);
        return undefined;
      },
    };
  }
}
