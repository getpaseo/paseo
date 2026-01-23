import { describe, expect, it } from "vitest";

import { DictationStreamSender } from "@/dictation/dictation-stream-sender";

type FakeFinish = { dictationId: string; finalSeq: number };
type FakeStart = { dictationId: string; format: string };
type FakeChunk = { dictationId: string; seq: number; audio: string; format: string };

class FakeDaemonClient {
  isConnected = true;
  starts: FakeStart[] = [];
  chunks: FakeChunk[] = [];
  finishes: FakeFinish[] = [];
  cancels: string[] = [];

  async startDictationStream(dictationId: string, format: string): Promise<void> {
    this.starts.push({ dictationId, format });
  }

  sendDictationStreamChunk(dictationId: string, seq: number, audio: string, format: string): void {
    this.chunks.push({ dictationId, seq, audio, format });
  }

  async finishDictationStream(dictationId: string, finalSeq: number): Promise<{ dictationId: string; text: string }> {
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
      client: client as any,
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
      client: client as any,
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
      client: client as any,
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
      client: client as any,
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
});

