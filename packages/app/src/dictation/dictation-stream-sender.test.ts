import { describe, expect, it, vi } from "vitest";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { DictationStreamSender } from "@/dictation/dictation-stream-sender";

interface FakeFinish {
  dictationId: string;
  finalSeq: number;
}
interface FakeStart {
  dictationId: string;
  format: string;
}
interface FakeChunk {
  dictationId: string;
  seq: number;
  audio: string;
  format: string;
}

interface FakeAck {
  type: "dictation_stream_ack";
  payload: {
    dictationId: string;
    ackSeq: number;
  };
}

type FakeRawMessageListener = (message: SessionOutboundMessage) => void;

class FakeDaemonClient {
  isConnected = true;
  autoAck = true;
  throwOnNextChunk = false;
  disconnectOnChunkError = false;
  starts: FakeStart[] = [];
  chunks: FakeChunk[] = [];
  finishes: FakeFinish[] = [];
  cancels: string[] = [];
  private readonly rawMessageListeners = new Set<FakeRawMessageListener>();

  async startDictationStream(dictationId: string, format: string): Promise<void> {
    this.starts.push({ dictationId, format });
  }

  sendDictationStreamChunk(dictationId: string, seq: number, audio: string, format: string): void {
    if (this.throwOnNextChunk) {
      this.throwOnNextChunk = false;
      if (this.disconnectOnChunkError) {
        this.isConnected = false;
      }
      throw new Error("WebSocket is closing");
    }
    this.chunks.push({ dictationId, seq, audio, format });
    if (this.autoAck) {
      this.emitAck(dictationId, seq);
    }
  }

  subscribeRawMessages(handler: FakeRawMessageListener): () => void {
    this.rawMessageListeners.add(handler);
    return () => this.rawMessageListeners.delete(handler);
  }

  setConnected(isConnected: boolean): void {
    this.isConnected = isConnected;
  }

  emitAck(dictationId: string, ackSeq: number): void {
    const message: FakeAck = {
      type: "dictation_stream_ack",
      payload: { dictationId, ackSeq },
    };
    for (const listener of this.rawMessageListeners) {
      listener(message);
    }
  }

  async finishDictationStream(
    dictationId: string,
    finalSeq: number,
  ): Promise<{ dictationId: string; text: string }> {
    this.finishes.push({ dictationId, finalSeq });
    return { dictationId, text: "ok" };
  }

  cancelDictationStream(dictationId: string): void {
    this.cancels.push(dictationId);
  }
}

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("DictationStreamSender", () => {
  it("enqueues segments and sends them after stream start", async () => {
    const client = new FakeDaemonClient();
    const ids = ["d1"];
    const sender = new DictationStreamSender({
      client,
      format: "audio/pcm;rate=16000;bits=16",
      createDictationId: () => ids.shift() ?? "dX",
    });

    sender.enqueueSegment("seg0");
    sender.enqueueSegment("seg1");

    await tick();

    expect(client.starts).toEqual([{ dictationId: "d1", format: "audio/pcm;rate=16000;bits=16" }]);
    expect(client.chunks).toEqual([
      { dictationId: "d1", seq: 0, audio: "seg0", format: "audio/pcm;rate=16000;bits=16" },
      { dictationId: "d1", seq: 1, audio: "seg1", format: "audio/pcm;rate=16000;bits=16" },
    ]);
  });

  it("restarts stream and resends from seq=0 on reconnect", async () => {
    const client = new FakeDaemonClient();
    const ids = ["d1", "d2"];
    const sender = new DictationStreamSender({
      client,
      format: "audio/pcm;rate=16000;bits=16",
      createDictationId: () => ids.shift() ?? "dX",
    });

    sender.enqueueSegment("seg0");
    sender.enqueueSegment("seg1");
    await tick();

    await sender.restartStream("reconnect");

    expect(client.starts.map((s) => s.dictationId)).toEqual(["d1", "d2"]);
    const d2Chunks = client.chunks.filter((c) => c.dictationId === "d2");
    expect(d2Chunks.map((c) => [c.seq, c.audio])).toEqual([
      [0, "seg0"],
      [1, "seg1"],
    ]);
  });

  it("finish flushes all queued segments and sends finish with finalSeq", async () => {
    const client = new FakeDaemonClient();
    const ids = ["d1"];
    const sender = new DictationStreamSender({
      client,
      format: "audio/pcm;rate=16000;bits=16",
      createDictationId: () => ids.shift() ?? "dX",
    });

    sender.enqueueSegment("seg0");
    sender.enqueueSegment("seg1");

    const finalSeq = sender.getFinalSeq();
    const result = await sender.finish(finalSeq);

    expect(result.text).toBe("ok");
    expect(client.chunks.map((c) => c.seq)).toEqual([0, 1]);
    expect(client.finishes).toEqual([{ dictationId: "d1", finalSeq: 1 }]);
  });

  it("keeps segments while disconnected and sends them after restart when reconnected", async () => {
    const client = new FakeDaemonClient();
    client.isConnected = false;
    const ids = ["d1"];
    const sender = new DictationStreamSender({
      client,
      format: "audio/pcm;rate=16000;bits=16",
      createDictationId: () => ids.shift() ?? "dX",
    });

    sender.enqueueSegment("seg0");
    sender.enqueueSegment("seg1");

    expect(client.starts).toHaveLength(0);
    expect(client.chunks).toHaveLength(0);

    client.isConnected = true;
    await sender.restartStream("reconnect");

    expect(client.chunks.map((c) => c.seq)).toEqual([0, 1]);
  });

  it("keeps capture safe and buffers later segments when a chunk send throws", async () => {
    const client = new FakeDaemonClient();
    const sender = new DictationStreamSender({
      client,
      format: "audio/pcm;rate=16000;bits=16",
      createDictationId: () => "d1",
    });

    sender.enqueueSegment("before-outage");
    await tick();

    client.throwOnNextChunk = true;
    client.disconnectOnChunkError = true;

    expect(() => sender.enqueueSegment("during-outage")).not.toThrow();
    expect(() => sender.enqueueSegment("after-outage")).not.toThrow();
    expect(sender.getSegmentCount()).toBe(3);
  });

  it("replays segments captured before, during, and after an outage from seq 0", async () => {
    const client = new FakeDaemonClient();
    const ids = ["d1", "d2"];
    const sender = new DictationStreamSender({
      client,
      format: "audio/pcm;rate=16000;bits=16",
      createDictationId: () => ids.shift() ?? "dX",
    });

    sender.enqueueSegment("before-outage");
    await tick();

    client.throwOnNextChunk = true;
    client.disconnectOnChunkError = true;
    expect(() => sender.enqueueSegment("during-outage")).not.toThrow();
    sender.enqueueSegment("after-outage");

    client.setConnected(true);
    await sender.restartStream("reconnect");

    const replay = client.chunks
      .filter((chunk) => chunk.dictationId === "d2")
      .map((chunk) => [chunk.seq, chunk.audio]);
    expect(replay).toEqual([
      [0, "before-outage"],
      [1, "during-outage"],
      [2, "after-outage"],
    ]);
  });

  it("fails finish after a transport transition without losing buffered audio", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeDaemonClient();
      client.setConnected(false);
      const ids = ["d1", "d2"];
      const sender = new DictationStreamSender({
        client,
        format: "audio/pcm;rate=16000;bits=16",
        createDictationId: () => ids.shift() ?? "dX",
      });

      for (let seq = 0; seq < 129; seq += 1) {
        sender.enqueueSegment(`segment-${seq}`);
      }

      client.setConnected(true);
      const finish = sender.finish(sender.getFinalSeq());
      const outcome = Promise.race([
        finish.then(
          () => "resolved" as const,
          () => "rejected" as const,
        ),
        new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 1)),
      ]);

      await tick();
      client.setConnected(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(outcome).resolves.toBe("rejected");
      expect(sender.getSegmentCount()).toBe(129);
      expect(sender.getFinalSeq()).toBe(128);

      client.setConnected(true);
      sender.resetStreamForReplay();
      await sender.restartStream("retry");
      await expect(sender.finish(128)).resolves.toEqual({ dictationId: "d2", text: "ok" });
      expect(client.chunks.filter((chunk) => chunk.dictationId === "d2")).toHaveLength(129);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for server delivery acknowledgement before finishing", async () => {
    const client = new FakeDaemonClient();
    client.autoAck = false;
    const sender = new DictationStreamSender({
      client,
      format: "audio/pcm;rate=16000;bits=16",
      createDictationId: () => "d1",
    });

    sender.enqueueSegment("seg0");
    sender.enqueueSegment("seg1");
    await tick();

    const finish = sender.finish(1);
    await tick();
    expect(client.finishes).toEqual([]);

    client.emitAck("d1", 1);
    await expect(finish).resolves.toEqual({ dictationId: "d1", text: "ok" });
  });

  it("does not replay long buffered native dictation in one synchronous burst", async () => {
    const client = new FakeDaemonClient();
    client.isConnected = false;
    const sender = new DictationStreamSender({
      client,
      format: "audio/pcm;rate=16000;bits=16",
      createDictationId: () => "d1",
    });

    for (let seq = 0; seq < 480; seq += 1) {
      sender.enqueueSegment(`native-frame-${seq}`);
    }

    client.isConnected = true;
    const finish = sender.finish(sender.getFinalSeq());

    await tick();

    expect(client.chunks.length).toBeLessThanOrEqual(128);
    await expect(finish).resolves.toEqual({
      dictationId: "d1",
      text: "ok",
    });
    expect(client.finishes).toEqual([{ dictationId: "d1", finalSeq: 479 }]);
  });
});
