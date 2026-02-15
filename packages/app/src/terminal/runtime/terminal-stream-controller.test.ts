import { describe, expect, it } from "vitest";

import {
  TerminalStreamController,
  type TerminalStreamControllerAttachPayload,
  type TerminalStreamControllerChunk,
  type TerminalStreamControllerClient,
  type TerminalStreamControllerStatus,
} from "./terminal-stream-controller";

type FakeStreamSubscriber = (chunk: TerminalStreamControllerChunk) => void;

class FakeTerminalStreamClient implements TerminalStreamControllerClient {
  private readonly streamSubscribers = new Map<number, Set<FakeStreamSubscriber>>();
  public attachCalls: Array<{
    terminalId: string;
    options?: {
      resumeOffset?: number;
      rows?: number;
      cols?: number;
    };
  }> = [];
  public detachCalls: number[] = [];
  public nextAttachResponses: TerminalStreamControllerAttachPayload[] = [];

  async attachTerminalStream(
    terminalId: string,
    options?: {
      resumeOffset?: number;
      rows?: number;
      cols?: number;
    }
  ): Promise<TerminalStreamControllerAttachPayload> {
    this.attachCalls.push({ terminalId, options });
    const response = this.nextAttachResponses.shift();
    if (!response) {
      throw new Error("Missing fake attach response");
    }
    return response;
  }

  async detachTerminalStream(streamId: number): Promise<void> {
    this.detachCalls.push(streamId);
  }

  onTerminalStreamData(
    streamId: number,
    handler: (chunk: TerminalStreamControllerChunk) => void
  ): () => void {
    const subscribers = this.streamSubscribers.get(streamId) ?? new Set();
    subscribers.add(handler);
    this.streamSubscribers.set(streamId, subscribers);
    return () => {
      const current = this.streamSubscribers.get(streamId);
      current?.delete(handler);
      if (current && current.size === 0) {
        this.streamSubscribers.delete(streamId);
      }
    };
  }

  emitChunk(input: {
    streamId: number;
    endOffset: number;
    data: string;
  }): void {
    const subscribers = this.streamSubscribers.get(input.streamId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }
    const chunk: TerminalStreamControllerChunk = {
      endOffset: input.endOffset,
      data: new TextEncoder().encode(input.data),
    };
    for (const subscriber of subscribers) {
      subscriber(chunk);
    }
  }
}

function createControllerHarness(input?: {
  client?: FakeTerminalStreamClient;
}): {
  client: FakeTerminalStreamClient;
  chunks: Array<{ terminalId: string; text: string }>;
  statuses: TerminalStreamControllerStatus[];
  resets: string[];
  controller: TerminalStreamController;
} {
  const client = input?.client ?? new FakeTerminalStreamClient();
  const chunks: Array<{ terminalId: string; text: string }> = [];
  const statuses: TerminalStreamControllerStatus[] = [];
  const resets: string[] = [];

  const controller = new TerminalStreamController({
    client,
    getPreferredSize: () => ({ rows: 24, cols: 80 }),
    onChunk: (chunk) => {
      chunks.push(chunk);
    },
    onStatusChange: (status) => {
      statuses.push(status);
    },
    onReset: ({ terminalId }) => {
      resets.push(terminalId);
    },
    waitForDelay: async () => {},
  });

  return {
    client,
    chunks,
    statuses,
    resets,
    controller,
  };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setTimeout(() => resolve(), 0);
  });
  await Promise.resolve();
}

describe("terminal-stream-controller", () => {
  it("streams burst chunks in order without dropping intermediate chunks", async () => {
    const harness = createControllerHarness();
    harness.client.nextAttachResponses.push({
      streamId: 7,
      currentOffset: 0,
      reset: false,
      error: null,
    });

    harness.controller.setTerminal({ terminalId: "term-1" });
    await flushAsyncWork();

    harness.client.emitChunk({
      streamId: 7,
      endOffset: 1,
      data: "a",
    });
    harness.client.emitChunk({
      streamId: 7,
      endOffset: 2,
      data: "b",
    });
    harness.client.emitChunk({
      streamId: 7,
      endOffset: 3,
      data: "c",
    });

    expect(harness.chunks).toEqual([
      { terminalId: "term-1", text: "a" },
      { terminalId: "term-1", text: "b" },
      { terminalId: "term-1", text: "c" },
    ]);
  });

  it("retries retryable attach failures and then attaches", async () => {
    const harness = createControllerHarness();
    harness.client.nextAttachResponses.push({
      streamId: null,
      currentOffset: 0,
      reset: false,
      error: "network disconnected",
    });
    harness.client.nextAttachResponses.push({
      streamId: 9,
      currentOffset: 5,
      reset: false,
      error: null,
    });

    harness.controller.setTerminal({ terminalId: "term-1" });
    await flushAsyncWork();

    expect(harness.client.attachCalls.length).toBe(2);
    expect(harness.client.attachCalls[1]?.options).toEqual({
      rows: 24,
      cols: 80,
    });
    expect(harness.controller.getActiveStreamId()).toBe(9);
    expect(harness.statuses.at(-1)).toEqual({
      terminalId: "term-1",
      streamId: 9,
      isAttaching: false,
      error: null,
    });
  });

  it("handles stream exit by reconnecting on the same terminal", async () => {
    const harness = createControllerHarness();
    harness.client.nextAttachResponses.push({
      streamId: 3,
      currentOffset: 0,
      reset: false,
      error: null,
    });
    harness.client.nextAttachResponses.push({
      streamId: 4,
      currentOffset: 2,
      reset: false,
      error: null,
    });

    harness.controller.setTerminal({ terminalId: "term-1" });
    await flushAsyncWork();

    harness.client.emitChunk({
      streamId: 3,
      endOffset: 2,
      data: "hi",
    });
    harness.controller.handleStreamExit({
      terminalId: "term-1",
      streamId: 3,
    });
    await flushAsyncWork();

    expect(harness.client.attachCalls.length).toBe(2);
    expect(harness.client.attachCalls[1]?.options).toEqual({
      resumeOffset: 2,
      rows: 24,
      cols: 80,
    });
    expect(harness.controller.getActiveStreamId()).toBe(4);
    expect(harness.statuses.at(-1)).toEqual({
      terminalId: "term-1",
      streamId: 4,
      isAttaching: false,
      error: null,
    });
  });

  it("emits reset callback when attach indicates output reset", async () => {
    const harness = createControllerHarness();
    harness.client.nextAttachResponses.push({
      streamId: 12,
      currentOffset: 0,
      reset: true,
      error: null,
    });

    harness.controller.setTerminal({ terminalId: "term-reset" });
    await flushAsyncWork();

    expect(harness.resets).toEqual(["term-reset"]);
    expect(harness.controller.getActiveStreamId()).toBe(12);
  });
});
