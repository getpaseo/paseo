import { EventEmitter } from "node:events";
import { v4 } from "uuid";
import WebSocket from "ws";
import type pino from "pino";
import type {
  SpeechToTextProvider,
  StreamingTranscriptionSession,
} from "../../speech-provider.js";

export interface FunASRSTTConfig {
  url: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60000;

export class FunASRSTT implements SpeechToTextProvider {
  public readonly id = "funasr";
  private readonly url: string;
  private readonly wsUrl: string;
  private readonly timeoutMs: number;
  private readonly logger: pino.Logger;

  constructor(config: FunASRSTTConfig, parentLogger: pino.Logger) {
    this.url = config.url.replace(/\/+$/, "");
    // Derive WebSocket URL from HTTP URL
    this.wsUrl = this.url.replace(/^http/, "ws");
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = parentLogger.child({ module: "speech", provider: "funasr", component: "stt" });
    this.logger.info({ url: this.url, wsUrl: this.wsUrl }, "FunASR STT initialized");
  }

  public createSession(params: {
    logger: pino.Logger;
    language?: string;
    prompt?: string;
  }): StreamingTranscriptionSession {
    const emitter = new EventEmitter();
    const logger = params.logger.child({ provider: "funasr", component: "stt-session" });
    const requiredSampleRate = 16000;
    const wsUrl = this.wsUrl;
    const timeoutMs = this.timeoutMs;

    let ws: WebSocket | null = null;
    let connected = false;
    let segmentId = v4();
    let previousSegmentId: string | null = null;
    // The segment ID that the next "final" response should be emitted on
    let pendingFinalSegmentId: string | null = null;

    return {
      requiredSampleRate,
      async connect() {
        return new Promise<void>((resolve, reject) => {
          const wsEndpoint = `${wsUrl}/ws/transcribe`;
          logger.debug({ wsEndpoint }, "Connecting to FunASR WebSocket");

          const socket = new WebSocket(wsEndpoint);
          let resolved = false;

          const connectTimeout = setTimeout(() => {
            if (!resolved) {
              resolved = true;
              socket.close();
              reject(new Error("FunASR WebSocket connection timeout"));
            }
          }, 10000);

          socket.on("open", () => {
            if (resolved) return;
            resolved = true;
            clearTimeout(connectTimeout);
            ws = socket;
            connected = true;
            logger.debug("FunASR WebSocket connected");
            resolve();
          });

          socket.on("message", (data) => {
            let parsed: { type: string; text?: string; error?: string };
            try {
              parsed = JSON.parse(data.toString());
            } catch {
              return;
            }

            if (parsed.type === "partial" && parsed.text !== undefined) {
              logger.debug({ text: parsed.text }, "FunASR partial transcript");
              // Use same segmentId as final — DictationStreamManager tracks by segment,
              // and final (isFinal:true) will replace partial (isFinal:false)
              (emitter as any).emit("transcript", {
                segmentId: pendingFinalSegmentId ?? segmentId,
                transcript: parsed.text,
                isFinal: false,
              });
            } else if (parsed.type === "final" && parsed.text !== undefined) {
              const finalId = pendingFinalSegmentId ?? segmentId;
              pendingFinalSegmentId = null;
              logger.debug({ text: parsed.text, segmentId: finalId }, "FunASR final transcript");
              (emitter as any).emit("transcript", {
                segmentId: finalId,
                transcript: parsed.text,
                isFinal: true,
              });
            } else if (parsed.type === "error") {
              (emitter as any).emit("error", new Error(parsed.error ?? "FunASR server error"));
            }
          });

          socket.on("error", (err) => {
            if (!resolved) {
              resolved = true;
              clearTimeout(connectTimeout);
              reject(err);
              return;
            }
            (emitter as any).emit("error", err);
          });

          socket.on("close", () => {
            connected = false;
            ws = null;
            if (!resolved) {
              resolved = true;
              clearTimeout(connectTimeout);
              reject(new Error("FunASR WebSocket closed before ready"));
            }
          });
        });
      },

      appendPcm16(chunk: Buffer) {
        if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
          (emitter as any).emit("error", new Error("FunASR STT session not connected"));
          return;
        }
        // Send raw PCM16 bytes directly over WebSocket
        ws.send(chunk);
      },

      commit() {
        if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
          (emitter as any).emit("error", new Error("FunASR STT session not connected"));
          return;
        }

        const committedId = segmentId;
        const prev = previousSegmentId;
        pendingFinalSegmentId = committedId;
        (emitter as any).emit("committed", { segmentId: committedId, previousSegmentId: prev });

        // Send finish signal — server will respond with final transcript
        ws.send(JSON.stringify({ type: "finish" }));

        // Set up timeout for final response
        const finalTimeout = setTimeout(() => {
          logger.warn("FunASR final transcript timeout");
          (emitter as any).emit("error", new Error("FunASR final transcript timeout"));
        }, timeoutMs);

        // Listen for the final event to clear timeout
        const onTranscript = (payload: { segmentId: string; isFinal: boolean }) => {
          if (payload.segmentId === committedId && payload.isFinal) {
            clearTimeout(finalTimeout);
            emitter.removeListener("transcript", onTranscript);
          }
        };
        emitter.on("transcript", onTranscript);

        previousSegmentId = committedId;
        segmentId = v4();
      },

      clear() {
        segmentId = v4();
      },

      close() {
        connected = false;
        if (ws) {
          try {
            ws.close();
          } catch {
            // no-op
          }
          ws = null;
        }
      },

      on(event: any, handler: any) {
        emitter.on(event, handler);
        return undefined;
      },
    };
  }
}
