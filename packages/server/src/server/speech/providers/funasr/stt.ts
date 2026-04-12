import { EventEmitter } from "node:events";
import { v4 } from "uuid";
import type pino from "pino";
import type {
  SpeechToTextProvider,
  StreamingTranscriptionSession,
} from "../../speech-provider.js";

export interface FunASRSTTConfig {
  url: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30000;

export class FunASRSTT implements SpeechToTextProvider {
  public readonly id = "funasr";
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly logger: pino.Logger;

  constructor(config: FunASRSTTConfig, parentLogger: pino.Logger) {
    this.url = config.url;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = parentLogger.child({ module: "speech", provider: "funasr", component: "stt" });
    this.logger.info({ url: this.url }, "FunASR STT initialized");
  }

  public createSession(params: {
    logger: pino.Logger;
    language?: string;
    prompt?: string;
  }): StreamingTranscriptionSession {
    const emitter = new EventEmitter();
    const logger = params.logger.child({ provider: "funasr", component: "stt-session" });
    const requiredSampleRate = 16000;
    const url = this.url;
    const timeoutMs = this.timeoutMs;

    let connected = false;
    let segmentId = v4();
    let previousSegmentId: string | null = null;
    let pcm16: Buffer = Buffer.alloc(0);

    const convertPCMToWavBuffer = (pcmBuffer: Buffer): Buffer => {
      const headerSize = 44;
      const channels = 1;
      const bitsPerSample = 16;
      const sampleRate = requiredSampleRate;
      const wavBuffer = Buffer.alloc(headerSize + pcmBuffer.length);
      const byteRate = (sampleRate * channels * bitsPerSample) / 8;
      const blockAlign = (channels * bitsPerSample) / 8;

      wavBuffer.write("RIFF", 0);
      wavBuffer.writeUInt32LE(36 + pcmBuffer.length, 4);
      wavBuffer.write("WAVE", 8);
      wavBuffer.write("fmt ", 12);
      wavBuffer.writeUInt32LE(16, 16);
      wavBuffer.writeUInt16LE(1, 20);
      wavBuffer.writeUInt16LE(channels, 22);
      wavBuffer.writeUInt32LE(sampleRate, 24);
      wavBuffer.writeUInt32LE(byteRate, 28);
      wavBuffer.writeUInt16LE(blockAlign, 32);
      wavBuffer.writeUInt16LE(bitsPerSample, 34);
      wavBuffer.write("data", 36);
      wavBuffer.writeUInt32LE(pcmBuffer.length, 40);
      pcmBuffer.copy(wavBuffer, 44);

      return wavBuffer;
    };

    return {
      requiredSampleRate,
      async connect() {
        connected = true;
      },
      appendPcm16(chunk: Buffer) {
        if (!connected) {
          (emitter as any).emit("error", new Error("STT session not connected"));
          return;
        }
        pcm16 = pcm16.length === 0 ? chunk : Buffer.concat([pcm16, chunk]);
      },
      commit() {
        if (!connected) {
          (emitter as any).emit("error", new Error("STT session not connected"));
          return;
        }

        const committedId = segmentId;
        const prev = previousSegmentId;
        (emitter as any).emit("committed", { segmentId: committedId, previousSegmentId: prev });

        if (pcm16.length === 0) {
          (emitter as any).emit("transcript", {
            segmentId: committedId,
            transcript: "",
            isFinal: true,
            isLowConfidence: true,
          });
          previousSegmentId = committedId;
          segmentId = v4();
          return;
        }

        const audioBuffer = pcm16;
        pcm16 = Buffer.alloc(0);

        void (async () => {
          try {
            const wav = convertPCMToWavBuffer(audioBuffer);
            const formData = new FormData();
            const wavBytes = new Uint8Array(
              wav.buffer as ArrayBuffer,
              wav.byteOffset,
              wav.byteLength,
            );
            formData.append(
              "file",
              new Blob([wavBytes], { type: "audio/wav" }),
              "audio.wav",
            );

            const response = await fetch(`${url}/transcribe`, {
              method: "POST",
              body: formData,
              signal: AbortSignal.timeout(timeoutMs),
            });

            if (!response.ok) {
              throw new Error(
                `FunASR server returned HTTP ${response.status}: ${response.statusText}`,
              );
            }

            const result = (await response.json()) as { text: string };

            logger.debug({ text: result.text }, "FunASR transcription complete");

            (emitter as any).emit("transcript", {
              segmentId: committedId,
              transcript: result.text,
              isFinal: true,
            });
          } catch (err) {
            logger.error({ err }, "FunASR transcription error");
            (emitter as any).emit("error", err);
          } finally {
            previousSegmentId = committedId;
            segmentId = v4();
          }
        })();
      },
      clear() {
        pcm16 = Buffer.alloc(0);
        segmentId = v4();
      },
      close() {
        connected = false;
        pcm16 = Buffer.alloc(0);
      },
      on(event: any, handler: any) {
        emitter.on(event, handler);
        return undefined;
      },
    };
  }
}
