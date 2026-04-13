import { describe, expect, it } from "vitest";

import {
  TerminalStreamController,
  type TerminalStreamControllerClient,
  type TerminalStreamControllerStatus,
} from "./terminal-stream-controller";

type TerminalSnapshot = {
  rows: number;
  cols: number;
  grid: Array<Array<{ char: string }>>;
  scrollback: Array<Array<{ char: string }>>;
  cursor: { row: number; col: number };
};

type TerminalStreamEvent =
  | { terminalId: string; type: "output"; data: Uint8Array }
  | { terminalId: string; type: "snapshot"; state: TerminalSnapshot };

class FakeTerminalStreamClient implements TerminalStreamControllerClient {
  private readonly listeners = new Set<(event: TerminalStreamEvent) => void>();
  public subscribeCalls: string[] = [];
  public unsubscribeCalls: string[] = [];
  public resizeCalls: Array<{ terminalId: string; rows: number; cols: number }> = [];
  public nextSubscribeResults: Array<{ terminalId: string; error?: string | null }> = [];

  async subscribeTerminal(terminalId: string) {
    this.subscribeCalls.push(terminalId);
    const result = this.nextSubscribeResults.shift();
    if (!result) {
      throw new Error("Missing fake subscribe result");
    }
    return result;
  }

  unsubscribeTerminal(terminalId: string): void {
    this.unsubscribeCalls.push(terminalId);
  }

  sendTerminalInput(
    terminalId: string,
    message: { type: "resize"; rows: number; cols: number },
  ): void {
    this.resizeCalls.push({ terminalId, rows: message.rows, cols: message.cols });
  }

  onTerminalStreamEvent(handler: (event: TerminalStreamEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  emit(event: TerminalStreamEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function createHarness(input?: { client?: FakeTerminalStreamClient }) {
  const client = input?.client ?? new FakeTerminalStreamClient();
  const outputs: Array<{ terminalId: string; text: string }> = [];
  const snapshots: Array<{ terminalId: string; text: string }> = [];
  const statuses: TerminalStreamControllerStatus[] = [];
  const controller = new TerminalStreamController({
    client,
    getPreferredSize: () => ({ rows: 24, cols: 80 }),
    onOutput: (output) => {
      outputs.push(output);
    },
    onSnapshot: ({ terminalId, state }) => {
      snapshots.push({
        terminalId,
        text: state.grid.map((row) => row.map((cell) => cell.char).join("")).join("\n"),
      });
    },
    onStatusChange: (status) => {
      statuses.push(status);
    },
  });

  return { client, controller, outputs, snapshots, statuses };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("terminal-stream-controller", () => {
  it("subscribes, resizes, and forwards snapshot/output events", async () => {
    const harness = createHarness();
    harness.client.nextSubscribeResults.push({ terminalId: "term-1", error: null });

    harness.controller.setTerminal({ terminalId: "term-1" });
    await flushAsyncWork();

    harness.client.emit({
      terminalId: "term-1",
      type: "snapshot",
      state: {
        rows: 1,
        cols: 5,
        grid: [[{ char: "h" }, { char: "e" }, { char: "l" }, { char: "l" }, { char: "o" }]],
        scrollback: [],
        cursor: { row: 0, col: 5 },
      },
    });
    harness.client.emit({
      terminalId: "term-1",
      type: "output",
      data: new TextEncoder().encode(" world"),
    });

    expect(harness.client.subscribeCalls).toEqual(["term-1"]);
    expect(harness.client.resizeCalls).toEqual([{ terminalId: "term-1", rows: 24, cols: 80 }]);
    expect(harness.snapshots).toEqual([{ terminalId: "term-1", text: "hello" }]);
    expect(harness.outputs).toEqual([{ terminalId: "term-1", text: " world" }]);
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

    expect(harness.client.subscribeCalls).toEqual(["term-1"]);
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

    expect(harness.client.subscribeCalls).toEqual(["term-1"]);
    expect(harness.statuses.at(-1)).toEqual({
      terminalId: "term-1",
      isAttaching: false,
      error: "Terminal exited",
    });
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
