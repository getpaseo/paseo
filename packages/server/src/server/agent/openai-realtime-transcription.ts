import type pino from "pino";
import WebSocket from "ws";
import { EventEmitter } from "node:events";

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
            turn_detection: null;
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

  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private closing = false;

  constructor(params: {
    apiKey: string;
    logger: pino.Logger;
    transcriptionModel: string;
    language?: string;
  }) {
    super();
    this.apiKey = params.apiKey;
    this.logger = params.logger.child({ provider: "openai", component: "realtime-transcription" });
    this.transcriptionModel = params.transcriptionModel;
    this.language = params.language;
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
                },
                // We commit periodically ourselves; no server-side VAD for dictation.
                turn_detection: null,
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

        if (event.type === "conversation.item.input_audio_transcription.completed") {
          this.emit("transcript", { itemId: event.item_id, transcript: event.transcript });
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
