import { describe, expect, it } from "vitest";

import {
  TerminalStreamController,
  type TerminalStreamControllerClient,
  type TerminalStreamControllerStatus,
} from "./terminal-stream-controller";

interface TerminalSnapshot {
  rows: number;
  cols: number;
  grid: Array<Array<{ char: string }>>;
  scrollback: Array<Array<{ char: string }>>;
  cursor: { row: number; col: number };
}

function terminalCellText(cell: { char: string }): string {
  return cell.char;
}

function terminalRowText(row: Array<{ char: string }>): string {
  return row.map(terminalCellText).join("");
}

function terminalSnapshotText(state: TerminalSnapshot): string {
  return state.grid.map(terminalRowText).join("\n");
}

function terminalOutput(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

type TerminalStreamEvent =
  | { terminalId: string; type: "output"; data: Uint8Array }
  | { terminalId: string; type: "snapshot"; state: TerminalSnapshot }
  | { terminalId: string; type: "restore"; data: Uint8Array };

class FakeTerminalStreamClient implements TerminalStreamControllerClient {
  private readonly listeners = new Set<(event: TerminalStreamEvent) => void>();
  public subscribeCalls: Array<{ terminalId: string; options?: unknown }> = [];
  public unsubscribeCalls: string[] = [];
  public resizeCalls: Array<{ terminalId: string; rows: number; cols: number }> = [];
  public nextSubscribeResults: Array<{ terminalId: string; error?: string | null }> = [];

  async subscribeTerminal(terminalId: string, options?: unknown) {
    this.subscribeCalls.push({ terminalId, ...(options ? { options } : {}) });
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
  const outputs: Array<{ terminalId: string; data: Uint8Array }> = [];
  const restores: Array<{ terminalId: string; data: Uint8Array }> = [];
  const snapshots: Array<{ terminalId: string; text: string }> = [];
  const statuses: TerminalStreamControllerStatus[] = [];
  const controller = new TerminalStreamController({
    client,
    getPreferredSize: () => ({ rows: 24, cols: 80 }),
    onOutput: (output) => {
      outputs.push(output);
    },
    onRestore: (restore) => {
      restores.push(restore);
    },
    onSnapshot: ({ terminalId, state }) => {
      snapshots.push({
        terminalId,
        text: terminalSnapshotText(state),
      });
    },
    onStatusChange: (status) => {
      statuses.push(status);
    },
  });

  return { client, controller, outputs, restores, snapshots, statuses };
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
    const outputData = terminalOutput(" world");
    harness.client.emit({
      terminalId: "term-1",
      type: "output",
      data: outputData,
    });

    expect(harness.client.subscribeCalls).toEqual([{ terminalId: "term-1" }]);
    expect(harness.client.resizeCalls).toEqual([{ terminalId: "term-1", rows: 24, cols: 80 }]);
    expect(harness.snapshots).toEqual([{ terminalId: "term-1", text: "hello" }]);
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
      onRestore: (restore) => harness.restores.push(restore),
      onSnapshot: ({ terminalId, state }) => {
        harness.snapshots.push({
          terminalId,
          text: terminalSnapshotText(state),
        });
      },
    });

    controller.setTerminal({ terminalId: "term-1" });
    await flushAsyncWork();
    const restoreData = terminalOutput("restored");
    client.emit({
      terminalId: "term-1",
      type: "restore",
      data: restoreData,
    });
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
    expect(harness.restores[0]?.data).toBe(restoreData);
    expect(harness.restores).toEqual([{ terminalId: "term-1", data: terminalOutput("restored") }]);
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
