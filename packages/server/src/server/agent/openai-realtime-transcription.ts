import type pino from "pino";
import WebSocket from "ws";
import { EventEmitter } from "node:events";

type OpenAITurnDetection =
  | null
  | {
      type: "server_vad";
      create_response?: boolean;
      threshold?: number;
      prefix_padding_ms?: number;
      silence_duration_ms?: number;
    }
  | {
      type: "semantic_vad";
      create_response?: boolean;
      eagerness?: "low" | "medium" | "high";
    };

type OpenAIClientEvent =
  | {
      type: "session.update";
      session: {
        type: "transcription";
        audio: {
          input: {
            format: { type: "audio/pcm"; rate: 24000 };
            transcription: {
              model: string;
              language?: string;
              prompt?: string;
            };
            turn_detection: OpenAITurnDetection;
          };
        };
      };
    }
  | { type: "input_audio_buffer.append"; audio: string }
  | { type: "input_audio_buffer.commit" }
  | { type: "input_audio_buffer.clear" };

type OpenAIServerEvent =
  | { type: "session.created" | "session.updated" }
  | {
      type: "input_audio_buffer.committed";
      item_id: string;
      previous_item_id: string | null;
    }
  | { type: "input_audio_buffer.speech_started" }
  | { type: "input_audio_buffer.speech_stopped" }
  | {
      type: "conversation.item.input_audio_transcription.delta";
      item_id: string;
      delta: string;
    }
  | {
      type: "conversation.item.input_audio_transcription.completed";
      item_id: string;
      transcript: string;
    }
  | { type: "error"; error?: { message?: string } };

export class OpenAIRealtimeTranscriptionSession extends EventEmitter {
  private readonly apiKey: string;
  private readonly logger: pino.Logger;
  private readonly transcriptionModel: string;
  private readonly language?: string;
  private readonly prompt?: string;
  private readonly turnDetection: OpenAITurnDetection;

  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private closing = false;
  private partialByItemId = new Map<string, string>();

  constructor(params: {
    apiKey: string;
    logger: pino.Logger;
    transcriptionModel: string;
    language?: string;
    prompt?: string;
    turnDetection?: OpenAITurnDetection;
  }) {
    super();
    this.apiKey = params.apiKey;
    this.logger = params.logger.child({ provider: "openai", component: "realtime-transcription" });
    this.transcriptionModel = params.transcriptionModel;
    this.language = params.language;
    this.prompt = params.prompt;
    this.turnDetection = params.turnDetection ?? null;
  }

  public async connect(): Promise<void> {
    if (this.ready) {
      return this.ready;
    }

    this.closing = false;
    this.ready = new Promise<void>((resolve, reject) => {
      const url = "wss://api.openai.com/v1/realtime?intent=transcription";
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });
      this.ws = ws;

      let resolved = false;

      const fail = (error: Error) => {
        if (resolved) {
          this.emit("error", error);
          return;
        }
        resolved = true;
        reject(error);
      };

      ws.on("open", () => {
        this.logger.debug("OpenAI realtime transcription websocket connected");
        const update: OpenAIClientEvent = {
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                transcription: {
                  model: this.transcriptionModel,
                  ...(this.language ? { language: this.language } : {}),
                  ...(this.prompt ? { prompt: this.prompt } : {}),
                },
                turn_detection: this.turnDetection,
              },
            },
          },
        };
        ws.send(JSON.stringify(update));
      });

      ws.on("message", (data) => {
        const text = typeof data === "string" ? data : data.toString("utf-8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }

        const event = parsed as OpenAIServerEvent;
        if (
          event.type === "session.created" ||
          event.type === "session.updated"
        ) {
          if (!resolved) {
            resolved = true;
            resolve();
          }
          return;
        }

        if (event.type === "input_audio_buffer.committed") {
          this.emit("committed", {
            itemId: event.item_id,
            previousItemId: event.previous_item_id,
          });
          return;
        }

        if (event.type === "input_audio_buffer.speech_started") {
          this.emit("speech_started");
          return;
        }

        if (event.type === "input_audio_buffer.speech_stopped") {
          this.emit("speech_stopped");
          return;
        }

        if (event.type === "conversation.item.input_audio_transcription.delta") {
          const replaceDelta = this.transcriptionModel === "whisper-1";
          const prev = this.partialByItemId.get(event.item_id) ?? "";
          const next = replaceDelta ? event.delta : prev + event.delta;
          this.partialByItemId.set(event.item_id, next);
          this.emit("transcript", { itemId: event.item_id, transcript: next, isFinal: false });
          return;
        }

        if (event.type === "conversation.item.input_audio_transcription.completed") {
          this.partialByItemId.set(event.item_id, event.transcript);
          this.emit("transcript", { itemId: event.item_id, transcript: event.transcript, isFinal: true });
          return;
        }

        if (event.type === "error") {
          const message = event.error?.message ?? "OpenAI realtime error";
          fail(new Error(message));
        }
      });

      ws.on("error", (err) => {
        fail(err instanceof Error ? err : new Error(String(err)));
      });

      ws.on("close", () => {
        this.logger.debug("OpenAI realtime websocket closed");
        if (this.closing) {
          return;
        }
        if (!resolved) {
          fail(new Error("OpenAI realtime websocket closed before ready"));
          return;
        }
        fail(new Error("OpenAI realtime websocket closed"));
      });
    });

    return this.ready;
  }

  public appendPcm16Base64(base64Audio: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("OpenAI realtime websocket not connected");
    }
    const event: OpenAIClientEvent = { type: "input_audio_buffer.append", audio: base64Audio };
    this.ws.send(JSON.stringify(event));
  }

  public commit(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("OpenAI realtime websocket not connected");
    }
    const event: OpenAIClientEvent = { type: "input_audio_buffer.commit" };
    this.ws.send(JSON.stringify(event));
  }

  public clear(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const event: OpenAIClientEvent = { type: "input_audio_buffer.clear" };
    this.ws.send(JSON.stringify(event));
  }

  public close(): void {
    try {
      this.closing = true;
      this.ws?.close();
    } catch {
      // no-op
    } finally {
      this.ws = null;
      this.ready = null;
    }
  }
}
