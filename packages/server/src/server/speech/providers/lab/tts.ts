import { PassThrough } from "node:stream";
import type pino from "pino";
import { WebSocket } from "ws";
import type { SpeechStreamResult, TextToSpeechProvider } from "../../speech-provider.js";
import { LAB_TTS_SAMPLE_RATE } from "./config.js";

export interface LabTtsOptions {
  url: string;
  voice: string;
  connectTimeoutMs: number;
  /** Used when the lab is unreachable or fails before the first audio frame. */
  fallback: TextToSpeechProvider | null;
}

/**
 * Lab Kokoro TTS over WebSocket. Sends {"type":"speak"}, streams the 24 kHz int16 PCM frames
 * as they arrive, and ends on {"type":"done"}. Falls back to the stock provider when the lab
 * cannot deliver a first frame.
 */
export class LabTTS implements TextToSpeechProvider {
  private readonly logger: pino.Logger;

  constructor(
    private readonly options: LabTtsOptions,
    parentLogger: pino.Logger,
  ) {
    this.logger = parentLogger.child({ module: "speech", provider: "lab", component: "tts" });
  }

  async synthesizeSpeech(text: string): Promise<SpeechStreamResult> {
    if (!text || text.trim().length === 0) {
      throw new Error("Cannot synthesize empty text");
    }
    try {
      return await this.synthesizeFromLab(text);
    } catch (error) {
      if (!this.options.fallback) {
        throw new Error(
          `Lab TTS failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      this.logger.warn({ err: error }, "Lab TTS unavailable; using fallback provider");
      return this.options.fallback.synthesizeSpeech(text);
    }
  }

  private synthesizeFromLab(text: string): Promise<SpeechStreamResult> {
    return new Promise((resolve, reject) => {
      const stream = new PassThrough();
      const ws = new WebSocket(this.options.url, {
        handshakeTimeout: this.options.connectTimeoutMs,
      });
      let delivered = false;

      const fail = (error: Error) => {
        if (delivered) {
          stream.destroy(error);
        } else {
          reject(error);
        }
        ws.terminate();
      };

      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "speak", text, voice: this.options.voice }));
      });
      ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) {
          stream.write(Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]));
          if (!delivered) {
            delivered = true;
            resolve({ stream, format: `pcm;rate=${LAB_TTS_SAMPLE_RATE}` });
          }
          return;
        }
        let message: { type?: string; message?: string };
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (message.type === "error") {
          fail(new Error(message.message ?? "lab TTS error"));
        } else if (message.type === "done") {
          if (!delivered) {
            fail(new Error("lab TTS returned no audio"));
            return;
          }
          stream.end();
          ws.close();
        }
      });
      ws.on("error", (error) => fail(error));
      ws.on("close", () => {
        if (!delivered) {
          reject(new Error("lab TTS closed before audio"));
        } else if (!stream.writableEnded) {
          stream.destroy(new Error("lab TTS closed mid-stream"));
        }
      });
      stream.on("close", () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "cancel" }));
          ws.close();
        }
      });
    });
  }
}
