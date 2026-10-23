import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type pino from "pino";
import { WebSocket } from "ws";
import type { SpeechToTextProvider, StreamingTranscriptionSession } from "../../speech-provider.js";
import { LAB_STT_SAMPLE_RATE } from "./config.js";

export interface LabSttOptions {
  url: string;
  connectTimeoutMs: number;
  /** Used when the lab cannot be reached at connect(). */
  fallback: SpeechToTextProvider | null;
}

/** Linear-interpolation resample of PCM16LE mono; only used on the fallback path. */
export function resamplePcm16(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate || pcm.length < 2) return pcm;
  const samples = Math.floor(pcm.length / 2);
  const input = new Int16Array(samples);
  for (let i = 0; i < samples; i++) input[i] = pcm.readInt16LE(i * 2);
  const outLength = Math.max(1, Math.round((samples * toRate) / fromRate));
  const out = Buffer.alloc(outLength * 2);
  for (let i = 0; i < outLength; i++) {
    const pos = (i * fromRate) / toRate;
    const lo = Math.min(Math.floor(pos), samples - 1);
    const hi = Math.min(lo + 1, samples - 1);
    const frac = pos - lo;
    out.writeInt16LE(Math.round(input[lo]! * (1 - frac) + input[hi]! * frac), i * 2);
  }
  return out;
}

/**
 * Lab faster-whisper STT over WebSocket: 16 kHz int16 PCM frames in, {"type":"end"} at commit,
 * partial/final transcripts out. If the lab is unreachable at connect(), the session delegates to
 * the fallback provider (audio is resampled to the rate the fallback requires).
 */
export class LabSTT implements SpeechToTextProvider {
  public readonly id = "lab" as const;

  constructor(
    private readonly options: LabSttOptions,
    _parentLogger: pino.Logger,
  ) {}

  createSession(params: {
    logger: pino.Logger;
    language?: string;
    prompt?: string;
  }): StreamingTranscriptionSession {
    const { options } = this;
    const logger = params.logger.child({ provider: "lab", component: "stt-session" });
    const emitter = new EventEmitter();
    let ws: WebSocket | null = null;
    let delegate: StreamingTranscriptionSession | null = null;
    let segmentId = randomUUID();
    let previousSegmentId: string | null = null;
    const queued: Buffer[] = [];
    let closed = false;
    // commit() before the socket is (re)connected: the "end" goes out right after the queued audio.
    let endPending = false;
    let pending: WebSocket | null = null;
    const aborted = new Error("lab STT connect aborted");
    const dropped = new WeakSet<WebSocket>();
    const abortPending = () => {
      if (pending) dropped.add(pending);
      pending?.terminate();
      pending = null;
    };

    const openLab = (): Promise<void> =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(options.url, { handshakeTimeout: options.connectTimeoutMs });
        pending = socket;
        let opened = false;
        socket.on("open", () => {
          if (pending === socket) pending = null;
          if (closed) {
            socket.terminate();
            reject(aborted);
            return;
          }
          opened = true;
          ws = socket;
          for (const chunk of queued.splice(0)) socket.send(chunk);
          if (endPending) {
            endPending = false;
            socket.send(JSON.stringify({ type: "end" }));
          }
          resolve();
        });
        socket.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
          if (isBinary || ws !== socket) return;
          let message: { type?: string; text?: string; message?: string };
          try {
            message = JSON.parse(data.toString());
          } catch {
            return;
          }
          if (message.type === "partial" || message.type === "final") {
            const isFinal = message.type === "final";
            emitter.emit("transcript", {
              segmentId,
              transcript: message.text ?? "",
              isFinal,
              language: params.language,
            });
            if (isFinal) {
              previousSegmentId = segmentId;
              segmentId = randomUUID();
            }
          } else if (message.type === "error") {
            emitter.emit("error", new Error(message.message ?? "lab STT error"));
          }
        });
        socket.on("error", (error) => {
          if (!opened) reject(error);
          else if (ws === socket) emitter.emit("error", error);
        });
        socket.on("close", () => {
          if (pending === socket) pending = null;
          if (!opened) {
            reject(dropped.has(socket) ? aborted : new Error("lab STT closed before open"));
          } else if (ws === socket) {
            ws = null;
            if (!closed) emitter.emit("error", new Error("lab STT connection lost"));
          }
        });
      });

    const startFallback = async (): Promise<void> => {
      if (!options.fallback) throw new Error("lab STT unavailable and no fallback configured");
      const session = options.fallback.createSession(params);
      session.on("committed", (p) => emitter.emit("committed", p));
      session.on("transcript", (p) => emitter.emit("transcript", p));
      session.on("error", (e) => emitter.emit("error", e));
      await session.connect();
      delegate = session;
      for (const chunk of queued.splice(0)) {
        session.appendPcm16(resamplePcm16(chunk, LAB_STT_SAMPLE_RATE, session.requiredSampleRate));
      }
    };

    return {
      requiredSampleRate: LAB_STT_SAMPLE_RATE,
      async connect() {
        try {
          await openLab();
        } catch (error) {
          if (closed) return;
          logger.warn({ err: error }, "Lab STT unavailable; using fallback provider");
          await startFallback();
        }
      },
      appendPcm16(chunk: Buffer) {
        if (delegate) {
          delegate.appendPcm16(
            resamplePcm16(chunk, LAB_STT_SAMPLE_RATE, delegate.requiredSampleRate),
          );
        } else if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(chunk);
        } else {
          queued.push(chunk);
        }
      },
      commit() {
        if (delegate) {
          delegate.commit();
          return;
        }
        emitter.emit("committed", { segmentId, previousSegmentId });
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "end" }));
        } else {
          endPending = true;
        }
      },
      clear() {
        queued.length = 0;
        endPending = false;
        if (delegate) {
          delegate.clear();
          return;
        }
        if (closed) return;
        // The lab buffer only resets after a final, so drop the socket and reopen it.
        const old = ws;
        ws = null;
        old?.terminate();
        abortPending();
        segmentId = randomUUID();
        void openLab().catch((error) => {
          if (!closed && error !== aborted) emitter.emit("error", error);
        });
      },
      close() {
        closed = true;
        endPending = false;
        queued.length = 0;
        delegate?.close();
        const old = ws;
        ws = null;
        old?.close();
        abortPending();
      },
      on(event: string, handler: (...args: never[]) => void) {
        emitter.on(event, handler as (...args: unknown[]) => void);
        return undefined;
      },
    };
  }
}
