import { generateMessageId } from "@/types/stream";
import type { DaemonClientV2 } from "@server/client/daemon-client-v2";

export type DictationStreamSenderParams = {
  client: DaemonClientV2 | null;
  format: string;
  createDictationId?: () => string;
};

type DictationFinishResult = { dictationId: string; text: string };

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
  private client: DaemonClientV2 | null;
  private readonly format: string;
  private readonly createDictationId: () => string;

  private dictationId: string | null = null;
  private sendSeq = 0;
  private segments: string[] = [];
  private streamReady = false;

  private startGeneration = 0;
  private startPromise: Promise<void> | null = null;

  constructor(params: DictationStreamSenderParams) {
    this.client = params.client;
    this.format = params.format;
    this.createDictationId = params.createDictationId ?? generateMessageId;
  }

  setClient(client: DaemonClientV2 | null): void {
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
    this.dictationId = null;
    this.sendSeq = 0;
    this.segments = [];
    this.streamReady = false;
    this.startPromise = null;
    this.startGeneration += 1;
  }

  resetStreamForReplay(): void {
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
      void this.restartStream("enqueue");
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
    while (this.sendSeq < this.segments.length) {
      const seq = this.sendSeq;
      const audio = this.segments[seq]!;
      client.sendDictationStreamChunk(dictationId, seq, audio, this.format);
      this.sendSeq = seq + 1;
      sent += 1;
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
    })().catch((error) => {
      // If starting failed, keep the segments for retry but clear the stream so finish can error cleanly.
      if (this.startGeneration === generation && this.dictationId === dictationId) {
        this.dictationId = null;
        this.streamReady = false;
      }
      throw error;
    }).finally(() => {
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
      throw new Error("Daemon client unavailable");
    }
    if (!client.isConnected) {
      throw new Error("Daemon client is disconnected");
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
}
