import { resolveTerminalRestoreOptions } from "./terminal-restore-options";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";

import {
  TerminalStreamController,
  type TerminalStreamControllerClient,
  type TerminalStreamControllerStatus,
} from "./terminal-stream-controller";

function terminalOutput(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

type StreamEvent = import("@getpaseo/client").TerminalStreamEvent;
type TerminalStreamEvent = StreamEvent extends infer Event
  ? Event extends StreamEvent
    ? Omit<Event, "subscriptionId">
    : never
  : never;

class FakeTerminalStreamClient implements TerminalStreamControllerClient {
  private readonly updates = new Set<(message: SessionOutboundMessage) => void>();
  emitUpdate(message: SessionOutboundMessage): void {
    for (const receive of this.updates) receive(message);
  }
  private readonly listeners = new Set<(event: TerminalStreamEvent) => void>();
  public subscribeCalls: Array<{ terminalId: string; options?: unknown }> = [];
  public unsubscribeCalls: string[] = [];
  public resizeCalls: Array<{
    terminalId: string;
    rows: number;
    cols: number;
    intent?: "claim" | "update";
  }> = [];
  public nextSubscribeResults: Array<{ terminalId: string; error?: string | null }> = [];

  observeTerminal: TerminalStreamControllerClient["observeTerminal"] = (
    terminalId,
    receive,
    options,
  ) => {
    this.subscribeCalls.push({ terminalId, ...(options ? { options } : {}) });
    const result = this.nextSubscribeResults.shift();
    if (!result) throw new Error("Missing fake subscribe result");
    const subscriptionId = `terminal-${this.subscribeCalls.length}`;
    const listener = (event: TerminalStreamEvent) => {
      if (event.terminalId === terminalId) receive({ ...event, subscriptionId });
    };
    this.listeners.add(listener);
    const ready = result.error
      ? Promise.reject(new Error(result.error))
      : Promise.resolve({
          terminalId,
          subscriptionId,
          slot: this.subscribeCalls.length,
          error: null,
          requestId: subscriptionId,
        });
    let released = false;
    return {
      subscriptionId,
      ready,
      subscribe: (observer) => {
        this.updates.add(observer.update);
        return () => {
          this.updates.delete(observer.update);
        };
      },
      release: async () => {
        if (released) return;
        released = true;
        this.listeners.delete(listener);
        this.unsubscribeCalls.push(terminalId);
      },
    };
  };

  sendTerminalInput(
    terminalId: string,
    message: { type: "resize"; rows: number; cols: number; intent?: "claim" | "update" },
  ): void {
    this.resizeCalls.push({
      terminalId,
      rows: message.rows,
      cols: message.cols,
      ...(message.intent ? { intent: message.intent } : {}),
    });
  }

  emit(event: TerminalStreamEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function createHarness(input?: { client?: FakeTerminalStreamClient }) {
  const client = input?.client ?? new FakeTerminalStreamClient();
  const outputs: Array<{ terminalId: string; data: Uint8Array }> = [];
  const replays: import("@getpaseo/client").TerminalReplayEvent[] = [];
  const statuses: TerminalStreamControllerStatus[] = [];
  const exits: string[] = [];
  const controller = new TerminalStreamController({
    client,
    onReplay: ({ replay }) => replays.push(replay),
    onExit: (terminalId) => exits.push(terminalId),
    getPreferredSize: () => ({ rows: 24, cols: 80 }),
    onOutput: (output) => {
      outputs.push(output);
    },
    onStatusChange: (status) => {
      statuses.push(status);
    },
  });

  return { client, controller, outputs, replays, statuses, exits };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("terminal-stream-controller", () => {
  it("subscribes, resizes, and forwards replay/output events", async () => {
    const harness = createHarness();
    harness.client.nextSubscribeResults.push({ terminalId: "term-1", error: null });

    harness.controller.setTerminal({ terminalId: "term-1" });
    await flushAsyncWork();

    const replay: import("@getpaseo/client").TerminalReplayEvent[] = [
      { type: "begin", rows: 24, cols: 80, retainedHistoryLines: 400 },
      { type: "data", data: terminalOutput("hello") },
      { type: "end" },
    ];
    for (const event of replay)
      harness.client.emit({ terminalId: "term-1", type: "replay", replay: event });
    const outputData = terminalOutput(" world");
    harness.client.emit({
      terminalId: "term-1",
      type: "output",
      data: outputData,
    });

    expect(harness.client.subscribeCalls).toEqual([{ terminalId: "term-1" }]);
    expect(harness.client.resizeCalls).toEqual([
      { terminalId: "term-1", rows: 24, cols: 80, intent: "claim" },
    ]);
    expect(harness.replays).toEqual(replay);
    expect(harness.outputs[0]?.data).toBe(outputData);
    expect(harness.outputs).toEqual([{ terminalId: "term-1", data: terminalOutput(" world") }]);
    expect(harness.statuses.at(-1)).toEqual({
      terminalId: "term-1",
      isAttaching: false,
      error: null,
    });
  });

  it("surfaces subscribe failures without retrying", async () => {
    const harness = createHarness();
    harness.client.nextSubscribeResults.push({
      terminalId: "term-1",
      error: "network disconnected",
    });

    harness.controller.setTerminal({ terminalId: "term-1" });
    await flushAsyncWork();

    expect(harness.client.subscribeCalls).toEqual([{ terminalId: "term-1" }]);
    expect(harness.statuses.at(-1)).toEqual({
      terminalId: "term-1",
      isAttaching: false,
      error: "network disconnected",
    });
  });

  it("treats terminal exit as final and does not reconnect", async () => {
    const harness = createHarness();
    harness.client.nextSubscribeResults.push({ terminalId: "term-1", error: null });

    harness.controller.setTerminal({ terminalId: "term-1" });
    await flushAsyncWork();
    harness.controller.handleTerminalExit({ terminalId: "term-1" });
    await flushAsyncWork();

    expect(harness.client.subscribeCalls).toEqual([{ terminalId: "term-1" }]);
    expect(harness.statuses.at(-1)).toEqual({
      terminalId: "term-1",
      isAttaching: false,
      error: "Terminal exited",
    });
  });

  it("requests configured restore options and forwards restore output", async () => {
    const client = new FakeTerminalStreamClient();
    const harness = createHarness({ client });
    client.nextSubscribeResults.push({ terminalId: "term-1", error: null });
    const controller = new TerminalStreamController({
      client,
      getPreferredSize: () => ({ rows: 24, cols: 80 }),
      getRestoreOptions: () => ({
        mode: "visible-snapshot",
        scrollbackLines: 200,
        size: { rows: 24, cols: 80 },
      }),
      onOutput: (output) => harness.outputs.push(output),
      onReplay: ({ replay }) => harness.replays.push(replay),
    });

    controller.setTerminal({ terminalId: "term-1" });
    await flushAsyncWork();
    const restoreData = terminalOutput("restored");
    const replay: import("@getpaseo/client").TerminalReplayEvent[] = [
      { type: "begin" },
      { type: "data", data: restoreData },
      { type: "end" },
    ];
    for (const event of replay)
      client.emit({ terminalId: "term-1", type: "replay", replay: event });
    controller.dispose();

    expect(client.subscribeCalls).toEqual([
      {
        terminalId: "term-1",
        options: {
          restore: {
            mode: "visible-snapshot",
            scrollbackLines: 200,
            size: { rows: 24, cols: 80 },
          },
        },
      },
    ]);
    expect(client.resizeCalls).toEqual([
      { terminalId: "term-1", rows: 24, cols: 80, intent: "claim" },
    ]);
    expect(harness.replays).toEqual(replay);
    expect(harness.outputs).toEqual([]);
  });

  it("unsubscribes when switching terminals and on dispose", async () => {
    const harness = createHarness();
    harness.client.nextSubscribeResults.push({ terminalId: "term-1", error: null });
    harness.client.nextSubscribeResults.push({ terminalId: "term-2", error: null });

    harness.controller.setTerminal({ terminalId: "term-1" });
    await flushAsyncWork();
    harness.controller.setTerminal({ terminalId: "term-2" });
    await flushAsyncWork();
    harness.controller.dispose();

    expect(harness.client.unsubscribeCalls).toEqual(["term-1", "term-2"]);
    expect(harness.statuses.at(-1)).toEqual({
      terminalId: null,
      isAttaching: false,
      error: null,
    });
  });
});

it("reports observation failure without declaring the PTY exited, then allows reattach", async () => {
  const h = createHarness();
  h.client.nextSubscribeResults.push({ terminalId: "term-1", error: null });
  h.controller.setTerminal({ terminalId: "term-1" });
  await flushAsyncWork();
  h.client.emitUpdate({
    type: "terminal_stream_exit",
    payload: { terminalId: "term-1", subscriptionId: "terminal-1", error: "Snapshot read failed" },
  });
  expect(h.statuses.at(-1)).toEqual({
    terminalId: "term-1",
    isAttaching: false,
    error: "Snapshot read failed",
  });
  expect(h.exits).toEqual([]);
  expect(h.client.unsubscribeCalls).toEqual(["term-1"]);
  h.client.nextSubscribeResults.push({ terminalId: "term-1", error: null });
  h.controller.setTerminal({ terminalId: "term-1" });
  await flushAsyncWork();
  h.client.emit({ terminalId: "term-1", type: "output", data: terminalOutput("STILL ALIVE") });
  expect(h.outputs).toHaveLength(1);
  expect(h.statuses.at(-1)?.error).toBe(null);
  h.controller.dispose();
});

it("does not resize or attach on a JSON-era host and reports the required update", () => {
  const client = new FakeTerminalStreamClient();
  const statuses: TerminalStreamControllerStatus[] = [];
  const controller = new TerminalStreamController({
    client,
    getPreferredSize: () => ({ rows: 24, cols: 40 }),
    onOutput: () => {},
    getRestoreOptions: () =>
      resolveTerminalRestoreOptions({
        supportsTerminalRestoreModes: false,
        scrollbackLines: 10000,
        canClaimSize: true,
        size: { rows: 24, cols: 40 },
      }),
    onStatusChange: (status) => statuses.push(status),
  });
  controller.setTerminal({ terminalId: "old-host-terminal" });
  expect(client.subscribeCalls).toEqual([]);
  expect(client.resizeCalls).toEqual([]);
  expect(statuses.at(-1)).toMatchObject({
    isAttaching: false,
    error: "Update the host to view terminals.",
  });
});
