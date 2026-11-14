import { expect, it } from "vitest";
import type { Socket } from "node:net";
import { createTerminalReplayController } from "./terminal-replay.js";
import type { FramedSocket } from "./terminal-worker-frames.js";

// A controller socket whose queued-write depth the test sets directly: a real socket only backs
// up past the limit after several megabytes of terminal output that nobody reads.
function createStalledController(writableLength: number) {
  const sent: unknown[] = [];
  let destroyed = false;
  const socket = {
    get writableLength() {
      return writableLength;
    },
    get destroyed() {
      return destroyed;
    },
    destroy() {
      destroyed = true;
      return this;
    },
  } as unknown as Socket;
  const framed: FramedSocket = {
    socket,
    send(message) {
      sent.push(message);
      return true;
    },
    sendAndWait: () => Promise.resolve(),
    close() {
      destroyed = true;
    },
  };
  return { framed, sent, destroyed: () => destroyed };
}

it("closes a controller that has not drained its socket and logs the depth", () => {
  const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const controller = createTerminalReplayController({
    getSession: () => undefined,
    flushOutput: () => {},
    log: (event, fields) => events.push({ event, fields }),
  });
  const stalled = createStalledController(5 * 1024 * 1024);
  controller.setConnection(stalled.framed);

  controller.send({
    type: "terminalMessage",
    terminalId: "terminal-1",
    message: { type: "output", data: "x" },
    replayPreamble: "",
  });

  expect(stalled.destroyed()).toBe(true);
  // Nothing reached a socket the worker already treats as gone.
  expect(stalled.sent).toEqual([]);
  expect(events).toEqual([
    {
      event: "controller-backpressure-close",
      fields: {
        writableLength: 5 * 1024 * 1024,
        limitBytes: 4 * 1024 * 1024,
        messageType: "terminalMessage",
        terminalId: "terminal-1",
        terminalMessageType: "output",
      },
    },
  ]);
});

it("keeps delivering to a controller that stays under the socket limit", () => {
  const events: string[] = [];
  const controller = createTerminalReplayController({
    getSession: () => undefined,
    flushOutput: () => {},
    log: (event) => events.push(event),
  });
  const healthy = createStalledController(1024);
  controller.setConnection(healthy.framed);

  controller.send({
    type: "terminalMessage",
    terminalId: "terminal-1",
    message: { type: "output", data: "x" },
    replayPreamble: "",
  });

  expect(healthy.destroyed()).toBe(false);
  expect(healthy.sent).toHaveLength(1);
  expect(events).toEqual([]);
});

it("replaces the previous controller without writing to it again", () => {
  const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const controller = createTerminalReplayController({
    getSession: () => undefined,
    flushOutput: () => {},
    log: (event, fields) => events.push({ event, fields }),
  });
  const first = createStalledController(0);
  const second = createStalledController(0);
  controller.setConnection(first.framed);
  controller.setConnection(second.framed);

  expect(first.destroyed()).toBe(true);
  expect(second.destroyed()).toBe(false);
  // Replacement is the worker process's own decision; the replay controller only obeys it.
  expect(events).toEqual([]);
});
