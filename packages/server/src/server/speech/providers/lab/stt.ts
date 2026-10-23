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
    // Latest lab open attempt; connect() follows it when clear() aborts the one it started with.
    let latest: Promise<void> | null = null;
    let connecting = false;
    let replayingCommit = false;
    // Audio of the current utterance already sent to the lab, and whether it was committed:
    // replayed to the fallback if the lab dies before its final.
    const utterance: Buffer[] = [];
    let commitSent = false;
    let failingOver = false;
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
          for (const chunk of queued.splice(0)) {
            socket.send(chunk);
            utterance.push(chunk);
          }
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
              utterance.length = 0;
              commitSent = false;
              previousSegmentId = segmentId;
              segmentId = randomUUID();
            }
          } else if (message.type === "error") {
            emitter.emit("error", new Error(message.message ?? "lab STT error"));
          }
        });
        socket.on("error", (error) => {
          if (!opened) reject(dropped.has(socket) ? aborted : error);
          else if (ws === socket && !options.fallback) emitter.emit("error", error);
        });
        socket.on("close", () => {
          if (pending === socket) pending = null;
          if (!opened) {
            reject(dropped.has(socket) ? aborted : new Error("lab STT closed before open"));
          } else if (ws === socket) {
            ws = null;
            if (!closed) failover(new Error("lab STT connection lost"));
          }
        });
      });

    // Established lab session died (or the clear() replacement failed): switch to the fallback
    // and replay the current utterance; with no fallback, surface the error.
    const runFailover = async (error: Error): Promise<void> => {
      failingOver = true;
      logger.warn({ err: error }, "Lab STT lost; switching to fallback provider");
      try {
        await startFallback();
      } catch (e) {
        if (!closed) emitter.emit("error", e instanceof Error ? e : new Error(String(e)));
      } finally {
        failingOver = false;
      }
    };
    const failover = (error: Error): void => {
      if (delegate || failingOver || closed) return;
      if (!options.fallback) {
        emitter.emit("error", error);
        return;
      }
      void runFailover(error);
    };

    const startFallback = async (): Promise<void> => {
      if (!options.fallback) throw new Error("lab STT unavailable and no fallback configured");
      const session = options.fallback.createSession(params);
      // The replayed commit was already announced under the lab segment id; keep that id.
      const idMap = new Map<string, string>();
      session.on("committed", (p) => {
        if (replayingCommit) idMap.set(p.segmentId, segmentId);
        else emitter.emit("committed", p);
      });
      session.on("transcript", (p) =>
        emitter.emit("transcript", { ...p, segmentId: idMap.get(p.segmentId) ?? p.segmentId }),
      );
      session.on("error", (e) => emitter.emit("error", e));
      await session.connect();
      delegate = session;
      for (const chunk of [...utterance.splice(0), ...queued.splice(0)]) {
        session.appendPcm16(resamplePcm16(chunk, LAB_STT_SAMPLE_RATE, session.requiredSampleRate));
      }
      if (endPending || commitSent) {
        // commit() already emitted "committed" before the lab failed; only replay the end.
        endPending = false;
        commitSent = false;
        replayingCommit = true;
        session.commit();
        replayingCommit = false;
      }
    };

    return {
      requiredSampleRate: LAB_STT_SAMPLE_RATE,
      async connect() {
        connecting = true;
        let attempt = (latest = openLab());
        for (;;) {
          try {
            await attempt;
            break;
          } catch (error) {
            if (closed) break;
            // clear() replaced this attempt: follow the new one, never start the fallback.
            if (error === aborted && latest && latest !== attempt) {
              attempt = latest;
              continue;
            }
            logger.warn({ err: error }, "Lab STT unavailable; using fallback provider");
            await startFallback();
            break;
          }
        }
        connecting = false;
      },
      appendPcm16(chunk: Buffer) {
        if (delegate) {
          delegate.appendPcm16(
            resamplePcm16(chunk, LAB_STT_SAMPLE_RATE, delegate.requiredSampleRate),
          );
        } else if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(chunk);
          utterance.push(chunk);
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
        commitSent = true;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "end" }));
        } else {
          endPending = true;
        }
      },
      clear() {
        queued.length = 0;
        utterance.length = 0;
        commitSent = false;
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
        const reopen = (latest = openLab());
        reopen.catch((error) => {
          if (!closed && !connecting && error !== aborted) failover(error);
        });
      },
      close() {
        closed = true;
        endPending = false;
        queued.length = 0;
        utterance.length = 0;
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
