import { generateMessageId } from "@/types/stream";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { i18n } from "@/i18n/i18next";

const MAX_CHUNKS_PER_FLUSH_TURN = 128;

const waitForNextFlushTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export interface DictationStreamSenderParams {
  client: DaemonClient | null;
  format: string;
  createDictationId?: () => string;
}

interface DictationFinishResult {
  dictationId: string;
  text: string;
}

/**
 * Small, non-React state machine for dictation streaming.
 *
 * Responsibilities:
 * - Maintain an ordered buffer of base64 PCM segments
 * - Start/restart a dictation stream (dictationId)
 * - Send missing segments (seq) when connected
 * - Finish/cancel the stream
 *
 * This class intentionally keeps sending synchronous (no internal async mutex),
 * so enqueues can't "miss" a flush due to in-flight await/coalescing bugs.
 */
export class DictationStreamSender {
  private client: DaemonClient | null;
  private readonly format: string;
  private readonly createDictationId: () => string;

  private dictationId: string | null = null;
  private sendSeq = 0;
  private segments: string[] = [];
  private streamReady = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private drainWaiters: Array<() => void> = [];

  private startGeneration = 0;
  private startPromise: Promise<void> | null = null;

  constructor(params: DictationStreamSenderParams) {
    this.client = params.client;
    this.format = params.format;
    this.createDictationId = params.createDictationId ?? generateMessageId;
  }

  setClient(client: DaemonClient | null): void {
    this.client = client;
  }

  getDictationId(): string | null {
    return this.dictationId;
  }

  getSegmentCount(): number {
    return this.segments.length;
  }

  getFinalSeq(): number {
    return this.segments.length - 1;
  }

  hasSegments(): boolean {
    return this.segments.length > 0;
  }

  clearAll(): void {
    this.clearScheduledFlush();
    this.dictationId = null;
    this.sendSeq = 0;
    this.segments = [];
    this.streamReady = false;
    this.startPromise = null;
    this.startGeneration += 1;
  }

  resetStreamForReplay(): void {
    this.clearScheduledFlush();
    this.dictationId = null;
    this.sendSeq = 0;
    this.streamReady = false;
    this.startPromise = null;
    this.startGeneration += 1;
  }

  enqueueSegment(base64Pcm: string): void {
    this.segments.push(base64Pcm);

    const client = this.client;
    if (!client?.isConnected) {
      return;
    }

    if (!this.dictationId) {
      if (!this.startPromise) {
        void this.restartStream("enqueue").catch((error) => {
          console.error("[DictationStreamSender] Failed to start stream from enqueue", error);
        });
      }
      return;
    }

    this.flush();
  }

  flush(): number {
    const client = this.client;
    const dictationId = this.dictationId;
    if (!client?.isConnected || !dictationId || !this.streamReady) {
      return 0;
    }

    let sent = 0;
    while (this.sendSeq < this.segments.length && sent < MAX_CHUNKS_PER_FLUSH_TURN) {
      const seq = this.sendSeq;
      const audio = this.segments[seq];
      client.sendDictationStreamChunk(dictationId, seq, audio, this.format);
      this.sendSeq = seq + 1;
      sent += 1;
    }
    if (this.hasPendingSegments()) {
      this.scheduleFlush();
    } else {
      this.resolveDrainWaiters();
    }
    return sent;
  }

  async restartStream(reason: string): Promise<void> {
    const client = this.client;
    if (!client?.isConnected) {
      return;
    }

    this.startGeneration += 1;
    const generation = this.startGeneration;

    const dictationId = this.createDictationId();
    this.dictationId = dictationId;
    this.sendSeq = 0;
    this.streamReady = false;

    const start = (async () => {
      await client.startDictationStream(dictationId, this.format);
      if (this.startGeneration !== generation) {
        return;
      }
      if (this.dictationId !== dictationId) {
        return;
      }
      this.streamReady = true;
      this.flush();
    })()
      .catch((error) => {
        // If starting failed, keep the segments for retry but clear the stream so finish can error cleanly.
        if (this.startGeneration === generation && this.dictationId === dictationId) {
          this.dictationId = null;
          this.streamReady = false;
        }
        throw error;
      })
      .finally(() => {
        if (this.startPromise === start) {
          this.startPromise = null;
        }
      });

    this.startPromise = start;
    await start;
    void reason;
  }

  async finish(finalSeq: number): Promise<DictationFinishResult> {
    const client = this.client;
    if (!client) {
      throw new Error(i18n.t("common.errors.daemonClientUnavailable"));
    }
    if (!client.isConnected) {
      throw new Error(i18n.t("common.errors.daemonClientDisconnected"));
    }

    if (!this.dictationId) {
      await this.restartStream("finalize");
    }
    if (this.startPromise) {
      await this.startPromise;
    }

    const dictationId = this.dictationId;
    if (!dictationId || !this.streamReady) {
      throw new Error("Failed to start dictation stream");
    }

    this.flush();
    await this.waitForFlushDrain();
    return client.finishDictationStream(dictationId, finalSeq);
  }

  cancel(): void {
    const client = this.client;
    const dictationId = this.dictationId;
    if (client?.isConnected && dictationId) {
      client.cancelDictationStream(dictationId);
    }
    this.resetStreamForReplay();
  }

  private hasPendingSegments(): boolean {
    return this.sendSeq < this.segments.length;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 0);
  }

  private clearScheduledFlush(): void {
    if (!this.flushTimer) {
      return;
    }
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private async waitForFlushDrain(): Promise<void> {
    while (this.hasPendingSegments()) {
      const client = this.client;
      if (!client?.isConnected || !this.dictationId || !this.streamReady) {
        throw new Error("Failed to flush dictation stream");
      }
      await new Promise<void>((resolve) => {
        this.drainWaiters.push(resolve);
      });
      await waitForNextFlushTurn();
    }
  }

  private resolveDrainWaiters(): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }
}
