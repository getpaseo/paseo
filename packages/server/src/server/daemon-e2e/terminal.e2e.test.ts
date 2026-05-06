import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { WebSocket } from "ws";
import { DaemonClient } from "../../client/daemon-client.js";
import {
  WSOutboundMessageSchema,
  type TerminalState,
  type WSOutboundMessage,
} from "../../shared/messages.js";
import {
  decodeTerminalSnapshotPayload,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  TerminalStreamOpcode,
  type TerminalStreamFrame,
} from "../../shared/terminal-stream-protocol.js";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

type RawSessionEnvelope = Extract<WSOutboundMessage, { type: "session" }>;

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-terminal-e2e-"));
}

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function extractStateText(state: Pick<TerminalState, "grid" | "scrollback">): string {
  return [...state.scrollback, ...state.grid]
    .map((row) =>
      row
        .map((cell) => cell.char)
        .join("")
        .trimEnd(),
    )
    .filter((line) => line.length > 0)
    .join("\n");
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 25,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

async function waitForTerminalSnapshot(
  client: DaemonClient,
  terminalId: string,
  predicate: (state: TerminalState) => boolean,
  timeout = 10000,
): Promise<TerminalState> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timeout waiting for terminal snapshot (${timeout}ms)`));
    }, timeout);

    const unsubscribe = client.onTerminalStreamEvent((event) => {
      if (event.terminalId !== terminalId || event.type !== "snapshot") {
        return;
      }
      if (!predicate(event.state)) {
        return;
      }
      clearTimeout(timeoutHandle);
      unsubscribe();
      resolve(event.state);
    });
  });
}

async function waitForTerminalOutput(
  client: DaemonClient,
  terminalId: string,
  predicate: (text: string) => boolean,
  timeout = 10000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timeout waiting for terminal output (${timeout}ms)`));
    }, timeout);

    const unsubscribe = client.onTerminalStreamEvent((event) => {
      if (event.terminalId !== terminalId || event.type !== "output") {
        return;
      }
      const text = new TextDecoder().decode(event.data);
      if (!predicate(text)) {
        return;
      }
      clearTimeout(timeoutHandle);
      unsubscribe();
      resolve(text);
    });
  });
}

async function connectClient(port: number, clientId: string): Promise<DaemonClient> {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId,
    logger: createLogger(),
    reconnect: { enabled: false },
  });
  await client.connect();
  return client;
}

function toWsBuffer(raw: WebSocket.RawData): Buffer | null {
  if (Buffer.isBuffer(raw)) {
    return raw;
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part))));
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw);
  }
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  return null;
}

async function connectRawWebSocket(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  const helloReady = waitForRawSessionMessage(
    ws,
    (message) =>
      message.message.type === "status" && message.message.payload.status === "server_info",
    10000,
  );

  ws.send(
    JSON.stringify({
      type: "hello",
      clientId: `terminal-raw-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      clientType: "cli",
      protocolVersion: 1,
    }),
  );

  await helloReady;
  return ws;
}

async function closeWebSocket(ws: WebSocket, timeout = 5000): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve) => {
    let pendingResolve: (() => void) | null = resolve;
    const timeoutHandle = setTimeout(() => {
      ws.terminate();
    }, timeout);
    const cleanup = () => {
      if (!pendingResolve) return;
      const fn = pendingResolve;
      pendingResolve = null;
      clearTimeout(timeoutHandle);
      ws.off("close", onClose);
      fn();
    };
    const onClose = () => {
      cleanup();
    };
    ws.on("close", onClose);
    ws.close();
  });
}

async function waitForRawSessionMessage(
  ws: WebSocket,
  predicate: (message: RawSessionEnvelope) => boolean,
  timeout = 10000,
): Promise<RawSessionEnvelope> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for raw websocket message (${timeout}ms)`));
    }, timeout);

    const onMessage = (raw: WebSocket.RawData) => {
      const buffer = toWsBuffer(raw);
      const text = typeof raw === "string" ? raw : buffer?.toString("utf8");
      if (!text) {
        return;
      }
      try {
        const parsedResult = WSOutboundMessageSchema.safeParse(JSON.parse(text));
        if (!parsedResult.success || parsedResult.data.type !== "session") {
          return;
        }
        const parsed = parsedResult.data;
        if (!predicate(parsed)) {
          return;
        }
        cleanup();
        resolve(parsed);
      } catch {
        // ignore binary terminal frames
      }
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };

    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

async function waitForRawBinaryFrame(
  ws: WebSocket,
  predicate: (frame: TerminalStreamFrame) => boolean,
  timeout = 10000,
): Promise<TerminalStreamFrame> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for terminal frame (${timeout}ms)`));
    }, timeout);

    const onMessage = (raw: WebSocket.RawData) => {
      const buffer = toWsBuffer(raw);
      if (!buffer) {
        return;
      }
      const frame = decodeTerminalStreamFrame(new Uint8Array(buffer));
      if (!frame || !predicate(frame)) {
        return;
      }
      cleanup();
      resolve(frame);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };

    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

async function waitForNoRawBinaryFrame(ws: WebSocket, timeout = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      cleanup();
      resolve();
    }, timeout);

    const onMessage = (raw: WebSocket.RawData) => {
      const buffer = toWsBuffer(raw);
      if (!buffer) {
        return;
      }
      const frame = decodeTerminalStreamFrame(new Uint8Array(buffer));
      if (!frame) {
        cleanup();
        reject(new Error("Received malformed terminal frame"));
        return;
      }
      cleanup();
      reject(new Error(`Unexpected terminal frame with opcode ${frame.opcode}`));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };

    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

async function collectRawBinaryFrames(
  ws: WebSocket,
  predicate: (frames: TerminalStreamFrame[]) => boolean,
  timeout = 10000,
): Promise<TerminalStreamFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: TerminalStreamFrame[] = [];
    const timeoutHandle = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out collecting terminal frames (${timeout}ms)`));
    }, timeout);

    const onMessage = (raw: WebSocket.RawData) => {
      const buffer = toWsBuffer(raw);
      if (!buffer) {
        return;
      }
      const frame = decodeTerminalStreamFrame(new Uint8Array(buffer));
      if (!frame) {
        cleanup();
        reject(new Error("Received malformed terminal frame"));
        return;
      }
      frames.push(frame);
      if (!predicate(frames)) {
        return;
      }
      cleanup();
      resolve(frames);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };

    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

function getFrameText(frame: TerminalStreamFrame): string {
  if (frame.opcode === TerminalStreamOpcode.Output) {
    return new TextDecoder().decode(frame.payload);
  }
  if (frame.opcode === TerminalStreamOpcode.Snapshot) {
    const state = decodeTerminalSnapshotPayload(frame.payload);
    if (!state) {
      return "";
    }
    return extractStateText(state);
  }
  return "";
}

interface TimedTerminalOutputFrame {
  receivedAtMs: number;
  payloadBytes: number;
  text: string;
}

interface TerminalOutputCapture {
  frames: TimedTerminalOutputFrame[];
  snapshotCount: number;
  stop: () => void;
}

interface TerminalOutputCadenceSummary {
  frameCount: number;
  maxGapMs: number;
  p95GapMs: number;
  lastOutputAfterStopMs: number;
  payloadBytes: number[];
}

interface TerminalRepeatCadenceMeasurement {
  enterSummary: TerminalOutputCadenceSummary;
  keySummary: TerminalOutputCadenceSummary;
  snapshotCount: number;
}

function startTerminalOutputCapture(ws: WebSocket, slot: number): TerminalOutputCapture {
  const decoder = new TextDecoder();
  const frames: TimedTerminalOutputFrame[] = [];
  let snapshotCount = 0;

  const onMessage = (raw: WebSocket.RawData, isBinary: boolean) => {
    if (!isBinary) {
      return;
    }
    const buffer = toWsBuffer(raw);
    if (!buffer) {
      return;
    }
    const frame = decodeTerminalStreamFrame(new Uint8Array(buffer));
    if (!frame || frame.slot !== slot) {
      return;
    }
    if (frame.opcode === TerminalStreamOpcode.Snapshot) {
      snapshotCount += 1;
      return;
    }
    if (frame.opcode !== TerminalStreamOpcode.Output || frame.payload.byteLength === 0) return;
    frames.push({
      receivedAtMs: performance.now(),
      payloadBytes: frame.payload.byteLength,
      text: decoder.decode(frame.payload),
    });
  };

  ws.on("message", onMessage);
  return {
    frames,
    get snapshotCount() {
      return snapshotCount;
    },
    stop: () => {
      ws.off("message", onMessage);
    },
  };
}

function sendRawTerminalInput(ws: WebSocket, slot: number, data: string): void {
  ws.send(
    encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Input,
      slot,
      payload: data,
    }),
  );
}

async function repeatRawTerminalInput(input: {
  ws: WebSocket;
  slot: number;
  data: string;
  count: number;
  intervalMs: number;
}): Promise<{
  stoppedAtMs: number;
}> {
  for (let index = 0; index < input.count; index += 1) {
    sendRawTerminalInput(input.ws, input.slot, input.data);
    await new Promise((resolve) => setTimeout(resolve, input.intervalMs));
  }
  return {
    stoppedAtMs: performance.now(),
  };
}

async function waitForTerminalOutputQuiet(
  capture: TerminalOutputCapture,
  quietMs: number,
  timeoutMs: number,
): Promise<void> {
  let lastCount = capture.frames.length;
  let quietStartedAtMs = performance.now();
  const startedAtMs = quietStartedAtMs;

  while (performance.now() - startedAtMs < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (capture.frames.length !== lastCount) {
      lastCount = capture.frames.length;
      quietStartedAtMs = performance.now();
      continue;
    }
    if (performance.now() - quietStartedAtMs >= quietMs) {
      return;
    }
  }
}

function summarizeTerminalOutputCadence(input: {
  frames: TimedTerminalOutputFrame[];
  stoppedAtMs: number;
}): TerminalOutputCadenceSummary {
  const gaps = input.frames
    .slice(1)
    .map((frame, index) => frame.receivedAtMs - input.frames[index].receivedAtMs)
    .sort((a, b) => a - b);
  const p95Index =
    gaps.length === 0 ? -1 : Math.min(gaps.length - 1, Math.ceil(gaps.length * 0.95) - 1);
  const lastFrame = input.frames.at(-1);

  return {
    frameCount: input.frames.length,
    maxGapMs: gaps.at(-1) ?? 0,
    p95GapMs: p95Index === -1 ? 0 : gaps[p95Index],
    lastOutputAfterStopMs: lastFrame ? lastFrame.receivedAtMs - input.stoppedAtMs : 0,
    payloadBytes: input.frames.map((frame) => frame.payloadBytes),
  };
}

function getTerminalOutputCadenceFailures(
  label: string,
  summary: TerminalOutputCadenceSummary,
  limits: {
    minFrames: number;
    maxP95GapMs: number;
    maxLastOutputAfterStopMs: number;
  },
): string[] {
  const failures: string[] = [];
  if (summary.frameCount < limits.minFrames) {
    failures.push(`${label}: frameCount ${summary.frameCount} < ${limits.minFrames}`);
  }
  if (summary.p95GapMs >= limits.maxP95GapMs) {
    failures.push(`${label}: p95GapMs ${summary.p95GapMs.toFixed(1)} >= ${limits.maxP95GapMs}`);
  }
  if (summary.lastOutputAfterStopMs >= limits.maxLastOutputAfterStopMs) {
    failures.push(
      `${label}: lastOutputAfterStopMs ${summary.lastOutputAfterStopMs.toFixed(1)} >= ${limits.maxLastOutputAfterStopMs}`,
    );
  }
  return failures;
}

function expectTerminalOutputCadences(input: {
  enterSummary: TerminalOutputCadenceSummary;
  keySummary: TerminalOutputCadenceSummary;
  snapshotCount: number;
}): void {
  const failures = [
    ...getTerminalOutputCadenceFailures("enter-repeat", input.enterSummary, {
      minFrames: 20,
      maxP95GapMs: 120,
      maxLastOutputAfterStopMs: Number.POSITIVE_INFINITY,
    }),
    ...getTerminalOutputCadenceFailures("key-repeat-after-enter-repeat", input.keySummary, {
      minFrames: 40,
      maxP95GapMs: 60,
      maxLastOutputAfterStopMs: 150,
    }),
  ];
  if (input.snapshotCount > 0) {
    failures.push(`unexpected live snapshot count ${input.snapshotCount} > 0`);
  }
  if (failures.length === 0) {
    return;
  }
  throw new Error(
    `terminal output cadence failed: ${failures.join("; ")}\n${JSON.stringify(input)}`,
  );
}

async function measureRepeatCadenceForTerminal(input: {
  cwd: string;
  name: string;
  options?: { command?: string; args?: string[] };
  setupInput?: string;
}): Promise<TerminalRepeatCadenceMeasurement> {
  const created = await ctx.client.createTerminal(input.cwd, input.name, undefined, input.options);
  const terminalId = created.terminal!.id;
  const ws = await connectRawWebSocket(ctx.daemon.port);

  try {
    const slot = await subscribeRawTerminal(ws, terminalId, `sub-repeat-cadence-${input.name}`);
    await waitForRawBinaryFrame(
      ws,
      (frame) => frame.slot === slot && frame.opcode === TerminalStreamOpcode.Snapshot,
      10000,
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (input.setupInput) {
      sendRawTerminalInput(ws, slot, input.setupInput);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const enterCapture = startTerminalOutputCapture(ws, slot);
    const enterRepeat = await repeatRawTerminalInput({
      ws,
      slot,
      data: "\r",
      count: 120,
      intervalMs: 15,
    });
    await waitForTerminalOutputQuiet(enterCapture, 700, 10000);
    enterCapture.stop();
    const enterSummary = summarizeTerminalOutputCadence({
      frames: enterCapture.frames,
      stoppedAtMs: enterRepeat.stoppedAtMs,
    });

    await new Promise((resolve) => setTimeout(resolve, 500));

    const keyCapture = startTerminalOutputCapture(ws, slot);
    const keyRepeat = await repeatRawTerminalInput({
      ws,
      slot,
      data: "k",
      count: 80,
      intervalMs: 15,
    });
    await waitForTerminalOutputQuiet(keyCapture, 250, 3000);
    keyCapture.stop();
    const keySummary = summarizeTerminalOutputCadence({
      frames: keyCapture.frames,
      stoppedAtMs: keyRepeat.stoppedAtMs,
    });

    return {
      enterSummary,
      keySummary,
      snapshotCount: enterCapture.snapshotCount + keyCapture.snapshotCount,
    };
  } finally {
    await closeWebSocket(ws);
  }
}

async function expectRepeatCadenceForTerminal(input: {
  cwd: string;
  name: string;
  options?: { command?: string; args?: string[] };
  setupInput?: string;
}): Promise<void> {
  const measurement = await measureRepeatCadenceForTerminal(input);
  expectTerminalOutputCadences(measurement);
}

async function subscribeRawTerminal(
  ws: WebSocket,
  terminalId: string,
  requestId: string,
): Promise<number> {
  const ready = waitForRawSessionMessage(
    ws,
    (message) =>
      message.message.type === "subscribe_terminal_response" &&
      message.message.payload.requestId === requestId,
    10000,
  );

  ws.send(
    JSON.stringify({
      type: "session",
      message: {
        type: "subscribe_terminal_request",
        terminalId,
        requestId,
      },
    }),
  );

  const message = await ready;
  if (message.message.type !== "subscribe_terminal_response") {
    throw new Error("Expected subscribe_terminal_response");
  }
  if (message.message.payload.error !== null) {
    throw new Error(
      `Expected successful subscribe_terminal_response: ${message.message.payload.error}`,
    );
  }
  expect(message.message.payload).not.toHaveProperty("state");
  return message.message.payload.slot;
}

let ctx: DaemonTestContext;
let tempDirs: string[];

beforeEach(async () => {
  ctx = await createDaemonTestContext();
  tempDirs = [];
});

afterEach(async () => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  await ctx.cleanup();
}, 60000);

test("lists terminals for a directory", async () => {
  const cwd = tmpCwd();

  const list = await ctx.client.listTerminals(cwd);

  expect(list.cwd).toBe(cwd);
  expect(list.terminals).toEqual([]);

  rmSync(cwd, { recursive: true, force: true });
}, 30000);

test("client connects and receives a snapshot of the current terminal state", async () => {
  const cwd = tmpCwd();
  const created = await ctx.client.createTerminal(cwd);
  const terminalId = created.terminal!.id;

  ctx.client.sendTerminalInput(terminalId, {
    type: "input",
    data: "printf 'hello\\n'\r",
  });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const snapshotPromise = waitForTerminalSnapshot(ctx.client, terminalId, (state) =>
    extractStateText(state).includes("hello"),
  );
  await ctx.client.subscribeTerminal(terminalId);
  const snapshot = await snapshotPromise;

  expect(extractStateText(snapshot)).toContain("hello");

  rmSync(cwd, { recursive: true, force: true });
}, 30000);

test("propagates debounced terminal titles through list responses and snapshots", async () => {
  const cwd = tmpCwd();
  const created = await ctx.client.createTerminal(cwd, undefined, undefined, {
    command: "/bin/sh",
    args: ["-lc", "printf '\\033]0;Build Output\\007'; sleep 2"],
  });
  const terminalId = created.terminal!.id;

  let listedTitle: string | undefined;
  const start = Date.now();
  while (Date.now() - start < 10000) {
    const list = await ctx.client.listTerminals(cwd);
    listedTitle = list.terminals.find((terminal) => terminal.id === terminalId)?.title;
    if (listedTitle === "Build Output") {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(listedTitle).toBe("Build Output");

  const snapshotPromise = waitForTerminalSnapshot(
    ctx.client,
    terminalId,
    (state) => state.title === "Build Output",
  );
  await ctx.client.subscribeTerminal(terminalId);
  const snapshot = await snapshotPromise;

  expect(snapshot.title).toBe("Build Output");

  rmSync(cwd, { recursive: true, force: true });
}, 30000);

test("subscribe response is sent before the initial snapshot frame", async () => {
  const cwd = tmpCwd();
  const created = await ctx.client.createTerminal(cwd);
  const terminalId = created.terminal!.id;
  const ws = await connectRawWebSocket(ctx.daemon.port);

  try {
    ctx.client.sendTerminalInput(terminalId, {
      type: "input",
      data: "printf 'hello-ordering\\n'\r",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const observed = await new Promise<Array<"response" | "snapshot">>((resolve, reject) => {
      const events: Array<"response" | "snapshot"> = [];
      const timeoutHandle = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for subscribe response and snapshot"));
      }, 10000);

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        ws.off("message", onMessage);
        ws.off("error", onError);
      };

      const maybeResolve = () => {
        if (!events.includes("response") || !events.includes("snapshot")) {
          return;
        }
        cleanup();
        resolve(events);
      };

      const onMessage = (raw: WebSocket.RawData) => {
        const buffer = toWsBuffer(raw);
        const text = typeof raw === "string" ? raw : buffer?.toString("utf8");
        if (text) {
          try {
            const parsedResult = WSOutboundMessageSchema.safeParse(JSON.parse(text));
            if (
              parsedResult.success &&
              parsedResult.data.type === "session" &&
              parsedResult.data.message.type === "subscribe_terminal_response" &&
              parsedResult.data.message.payload.requestId === "sub-ordering"
            ) {
              events.push("response");
              maybeResolve();
              return;
            }
          } catch {
            // ignore non-session text frames
          }
        }

        if (!buffer) {
          return;
        }
        const frame = decodeTerminalStreamFrame(new Uint8Array(buffer));
        if (frame?.opcode !== TerminalStreamOpcode.Snapshot) {
          return;
        }
        const state = decodeTerminalSnapshotPayload(frame.payload);
        if (!state || !extractStateText(state).includes("hello-ordering")) {
          return;
        }
        events.push("snapshot");
        maybeResolve();
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      ws.on("message", onMessage);
      ws.on("error", onError);
      ws.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "subscribe_terminal_request",
            terminalId,
            requestId: "sub-ordering",
          },
        }),
      );
    });

    expect(observed).toEqual(["response", "snapshot"]);
  } finally {
    await closeWebSocket(ws);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30000);

test("client sends input and receives output as raw bytes", async () => {
  const cwd = tmpCwd();
  const created = await ctx.client.createTerminal(cwd);
  const terminalId = created.terminal!.id;

  const outputPromise = waitForTerminalOutput(ctx.client, terminalId, (text) =>
    text.includes("binary-stream"),
  );
  await ctx.client.subscribeTerminal(terminalId);
  ctx.client.sendTerminalInput(terminalId, {
    type: "input",
    data: "echo binary-stream\r",
  });

  expect(await outputPromise).toContain("binary-stream");

  rmSync(cwd, { recursive: true, force: true });
}, 30000);

test("default zsh terminal does not eagerly flush full state during repeat bursts", async () => {
  await expectRepeatCadenceForTerminal({
    cwd: process.cwd(),
    name: "default-zsh-repeat-cadence",
  });
}, 30000);

test("one client can stream two terminals concurrently", async () => {
  const cwd = tmpCwd();
  const firstCreated = await ctx.client.createTerminal(cwd, "first");
  const secondCreated = await ctx.client.createTerminal(cwd, "second");
  const firstTerminalId = firstCreated.terminal!.id;
  const secondTerminalId = secondCreated.terminal!.id;

  const firstSubscribe = await ctx.client.subscribeTerminal(firstTerminalId);
  const secondSubscribe = await ctx.client.subscribeTerminal(secondTerminalId);

  expect(firstSubscribe.error).toBeNull();
  expect(secondSubscribe.error).toBeNull();
  expect(firstSubscribe.slot).not.toBe(secondSubscribe.slot);

  const firstOutput = waitForTerminalOutput(ctx.client, firstTerminalId, (text) =>
    text.includes("from-first"),
  );
  const secondOutput = waitForTerminalOutput(ctx.client, secondTerminalId, (text) =>
    text.includes("from-second"),
  );

  ctx.client.sendTerminalInput(firstTerminalId, {
    type: "input",
    data: "echo from-first\r",
  });
  ctx.client.sendTerminalInput(secondTerminalId, {
    type: "input",
    data: "echo from-second\r",
  });

  expect(await firstOutput).toContain("from-first");
  expect(await secondOutput).toContain("from-second");

  rmSync(cwd, { recursive: true, force: true });
}, 30000);

test("disconnect and reconnect both receive the current snapshot", async () => {
  const cwd = tmpCwd();
  const created = await ctx.client.createTerminal(cwd);
  const terminalId = created.terminal!.id;

  await ctx.client.subscribeTerminal(terminalId);
  ctx.client.unsubscribeTerminal(terminalId);

  ctx.client.sendTerminalInput(terminalId, {
    type: "input",
    data: "echo while-detached\r",
  });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const snapshotPromise = waitForTerminalSnapshot(ctx.client, terminalId, (state) =>
    extractStateText(state).includes("while-detached"),
  );
  await ctx.client.subscribeTerminal(terminalId);

  expect(extractStateText(await snapshotPromise)).toContain("while-detached");

  rmSync(cwd, { recursive: true, force: true });
}, 30000);

test("fast output to a slow websocket client falls back to a snapshot", async () => {
  const cwd = tmpCwd();
  const created = await ctx.client.createTerminal(cwd);
  const terminalId = created.terminal!.id;
  const ws = await connectRawWebSocket(ctx.daemon.port);

  await subscribeRawTerminal(ws, terminalId, "sub-raw");
  await waitForRawBinaryFrame(ws, (frame) => frame.opcode === TerminalStreamOpcode.Snapshot, 10000);

  const rawSocket = (ws as WebSocket & { _socket?: { pause: () => void; resume: () => void } })
    ._socket;
  expect(rawSocket).toBeDefined();

  rawSocket!.pause();
  ctx.client.sendTerminalInput(terminalId, {
    type: "input",
    data: `node -e 'process.stdout.write("A".repeat(${8 * 1024 * 1024}))'\r`,
  });

  await new Promise((resolve) => setTimeout(resolve, 750));
  rawSocket!.resume();

  const catchUpFrame = await waitForRawBinaryFrame(
    ws,
    (frame) => frame.opcode === TerminalStreamOpcode.Snapshot,
    15000,
  );
  expect(catchUpFrame.opcode).toBe(TerminalStreamOpcode.Snapshot);

  await closeWebSocket(ws);
  rmSync(cwd, { recursive: true, force: true });
}, 40000);

test("multiple clients on the same terminal each receive output independently", async () => {
  const cwd = tmpCwd();
  const created = await ctx.client.createTerminal(cwd);
  const terminalId = created.terminal!.id;
  const secondClient = await connectClient(
    ctx.daemon.port,
    `terminal-secondary-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  try {
    const firstOutput = waitForTerminalOutput(ctx.client, terminalId, (text) =>
      text.includes("fanout"),
    );
    const secondOutput = waitForTerminalOutput(secondClient, terminalId, (text) =>
      text.includes("fanout"),
    );

    await ctx.client.subscribeTerminal(terminalId);
    await secondClient.subscribeTerminal(terminalId);
    ctx.client.sendTerminalInput(terminalId, {
      type: "input",
      data: "echo fanout\r",
    });

    expect(await firstOutput).toContain("fanout");
    expect(await secondOutput).toContain("fanout");
  } finally {
    await secondClient.close();
  }

  rmSync(cwd, { recursive: true, force: true });
}, 30000);

test("resize updates server dimensions without sending a live snapshot", async () => {
  const cwd = tmpCwd();
  const created = await ctx.client.createTerminal(cwd);
  const terminalId = created.terminal!.id;
  await ctx.client.subscribeTerminal(terminalId);
  ctx.client.sendTerminalInput(terminalId, {
    type: "resize",
    rows: 10,
    cols: 40,
  });

  await new Promise((resolve) => setTimeout(resolve, 300));

  const state = ctx.daemon.daemon.terminalManager?.getTerminal(terminalId)?.getState();
  expect(state?.rows).toBe(10);
  expect(state?.cols).toBe(40);

  rmSync(cwd, { recursive: true, force: true });
}, 30000);

test("resize does not stall streamed output for an attached client", async () => {
  const cwd = tmpCwd();
  const created = await ctx.client.createTerminal(cwd);
  const terminalId = created.terminal!.id;
  const secondClient = await connectClient(
    ctx.daemon.port,
    `terminal-resize-stream-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  try {
    await ctx.client.subscribeTerminal(terminalId);
    await secondClient.subscribeTerminal(terminalId);

    secondClient.sendTerminalInput(terminalId, {
      type: "resize",
      rows: 12,
      cols: 40,
    });

    const firstOutput = waitForTerminalOutput(ctx.client, terminalId, (text) =>
      text.includes("after-resize-stream"),
    );
    const secondOutput = waitForTerminalOutput(secondClient, terminalId, (text) =>
      text.includes("after-resize-stream"),
    );

    secondClient.sendTerminalInput(terminalId, {
      type: "input",
      data: "printf 'after-resize-stream\\n'\r",
    });

    expect(await firstOutput).toContain("after-resize-stream");
    expect(await secondOutput).toContain("after-resize-stream");
  } finally {
    await secondClient.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30000);

test("terminal exits notify the client", async () => {
  const cwd = tmpCwd();
  const created = await ctx.client.createTerminal(cwd);
  const terminalId = created.terminal!.id;

  let sawExit = false;
  const unsubscribe = ctx.client.on("terminal_stream_exit", (message) => {
    if (message.type !== "terminal_stream_exit") {
      return;
    }
    if (message.payload.terminalId === terminalId) {
      sawExit = true;
    }
  });

  await ctx.client.subscribeTerminal(terminalId);
  const kill = await ctx.client.killTerminal(terminalId);
  expect(kill.success).toBe(true);

  await waitForCondition(() => sawExit, 10000);
  unsubscribe();

  rmSync(cwd, { recursive: true, force: true });
}, 30000);

test("websocket terminate then new connection gets snapshot with all prior output", async () => {
  const cwd = tmpCwd();
  const created = await ctx.client.createTerminal(cwd);
  const terminalId = created.terminal!.id;
  const firstSocket = await connectRawWebSocket(ctx.daemon.port);

  try {
    await subscribeRawTerminal(firstSocket, terminalId, "sub-drop-a");
    const initialSnapshot = await waitForRawBinaryFrame(
      firstSocket,
      (frame) => frame.opcode === TerminalStreamOpcode.Snapshot,
      10000,
    );
    expect(initialSnapshot.opcode).toBe(TerminalStreamOpcode.Snapshot);

    ctx.client.sendTerminalInput(terminalId, {
      type: "input",
      data: "printf 'before-drop\\n'\r",
    });
    const beforeDropFrame = await waitForRawBinaryFrame(
      firstSocket,
      (frame) => getFrameText(frame).includes("before-drop"),
      10000,
    );
    expect(getFrameText(beforeDropFrame)).toContain("before-drop");

    await new Promise<void>((resolve) => {
      firstSocket.once("close", () => resolve());
      firstSocket.terminate();
    });

    const secondClient = await connectClient(
      ctx.daemon.port,
      `terminal-drop-input-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    try {
      secondClient.sendTerminalInput(terminalId, {
        type: "input",
        data: "printf 'while-dead\\n'\r",
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      await secondClient.close();
    }

    const secondSocket = await connectRawWebSocket(ctx.daemon.port);
    try {
      await subscribeRawTerminal(secondSocket, terminalId, "sub-drop-b");
      const reconnectFrame = await waitForRawBinaryFrame(secondSocket, () => true, 10000);
      expect(reconnectFrame.opcode).toBe(TerminalStreamOpcode.Snapshot);

      const state = decodeTerminalSnapshotPayload(reconnectFrame.payload);
      expect(state).not.toBeNull();
      expect(extractStateText(state!)).toContain("before-drop");
      expect(extractStateText(state!)).toContain("while-dead");
    } finally {
      await closeWebSocket(secondSocket);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30000);

test("two clients can both send input and each sees its own output", async () => {
  const cwd = tmpCwd();
  const created = await ctx.client.createTerminal(cwd);
  const terminalId = created.terminal!.id;
  const secondClient = await connectClient(
    ctx.daemon.port,
    `terminal-input-dual-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  try {
    await ctx.client.subscribeTerminal(terminalId);
    await secondClient.subscribeTerminal(terminalId);

    const firstOwnOutput = waitForTerminalOutput(ctx.client, terminalId, (text) =>
      text.includes("from-a"),
    );
    const secondOwnOutput = waitForTerminalOutput(secondClient, terminalId, (text) =>
      text.includes("from-b"),
    );

    ctx.client.sendTerminalInput(terminalId, {
      type: "input",
      data: "echo from-a\r",
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    secondClient.sendTerminalInput(terminalId, {
      type: "input",
      data: "echo from-b\r",
    });

    expect(await firstOwnOutput).toContain("from-a");
    expect(await secondOwnOutput).toContain("from-b");
  } finally {
    await secondClient.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30000);

test("snapshot fidelity through websocket decode preserves dimensions and visible text", async () => {
  const cwd = tmpCwd();
  const created = await ctx.client.createTerminal(cwd, "Snapshot Fidelity");
  const terminalId = created.terminal!.id;

  ctx.client.sendTerminalInput(terminalId, {
    type: "input",
    data: "printf 'line1\\nline2\\nline3\\n'\r",
  });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const ws = await connectRawWebSocket(ctx.daemon.port);
  try {
    await subscribeRawTerminal(ws, terminalId, "sub-fidelity");
    const snapshotFrame = await waitForRawBinaryFrame(
      ws,
      (frame) => frame.opcode === TerminalStreamOpcode.Snapshot,
      10000,
    );

    const state = decodeTerminalSnapshotPayload(snapshotFrame.payload);
    expect(state).not.toBeNull();
    expect(state).toMatchObject({
      rows: 24,
      cols: 80,
      cursor: expect.any(Object),
      grid: expect.any(Array),
      scrollback: expect.any(Array),
    });
    expect(extractStateText(state!)).toContain("line1");
    expect(extractStateText(state!)).toContain("line2");
    expect(extractStateText(state!)).toContain("line3");
  } finally {
    await closeWebSocket(ws);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30000);

test("terminal exit prevents resubscribe and sends no frames after exit", async () => {
  const cwd = tmpCwd();
  const created = await ctx.client.createTerminal(cwd);
  const terminalId = created.terminal!.id;
  const ws = await connectRawWebSocket(ctx.daemon.port);

  try {
    await subscribeRawTerminal(ws, terminalId, "sub-exit");
    await waitForRawBinaryFrame(
      ws,
      (frame) => frame.opcode === TerminalStreamOpcode.Snapshot,
      10000,
    );

    const exitMessagePromise = waitForRawSessionMessage(
      ws,
      (message) =>
        message.message.type === "terminal_stream_exit" &&
        message.message.payload.terminalId === terminalId,
      10000,
    );
    const kill = await ctx.client.killTerminal(terminalId);
    expect(kill.success).toBe(true);
    const exitMessage = await exitMessagePromise;
    expect(exitMessage.message.type).toBe("terminal_stream_exit");

    const subscribeResult = await ctx.client.subscribeTerminal(terminalId);
    expect(subscribeResult.error).toBe("Terminal not found");
    await waitForNoRawBinaryFrame(ws, 750);
  } finally {
    await closeWebSocket(ws);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30000);

test("empty input frame does not crash the server", async () => {
  const cwd = tmpCwd();
  const created = await ctx.client.createTerminal(cwd);
  const terminalId = created.terminal!.id;
  const ws = await connectRawWebSocket(ctx.daemon.port);

  try {
    const slot = await subscribeRawTerminal(ws, terminalId, "sub-empty-input");
    await waitForRawBinaryFrame(
      ws,
      (frame) => frame.opcode === TerminalStreamOpcode.Snapshot,
      10000,
    );

    ws.send(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Input,
        slot,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ctx.client.sendTerminalInput(terminalId, {
      type: "input",
      data: "echo alive\r",
    });
    const aliveFrame = await waitForRawBinaryFrame(
      ws,
      (frame) => getFrameText(frame).includes("alive"),
      10000,
    );
    expect(getFrameText(aliveFrame)).toContain("alive");
  } finally {
    await closeWebSocket(ws);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30000);

test("1MB output burst keeps frames decodable and terminal usable afterward", async () => {
  const cwd = tmpCwd();
  const created = await ctx.client.createTerminal(cwd);
  const terminalId = created.terminal!.id;
  const ws = await connectRawWebSocket(ctx.daemon.port);

  try {
    await subscribeRawTerminal(ws, terminalId, "sub-large-output");
    await waitForRawBinaryFrame(
      ws,
      (frame) => frame.opcode === TerminalStreamOpcode.Snapshot,
      10000,
    );

    ctx.client.sendTerminalInput(terminalId, {
      type: "input",
      data: `node -e "process.stdout.write('X'.repeat(${1024 * 1024}))"\r`,
    });

    const frames = await collectRawBinaryFrames(
      ws,
      (collectedFrames) => {
        const outputBytes = collectedFrames
          .filter((frame) => frame.opcode === TerminalStreamOpcode.Output)
          .reduce((sum, frame) => sum + frame.payload.byteLength, 0);
        return (
          outputBytes >= 1024 * 1024 ||
          collectedFrames.some((frame) => frame.opcode === TerminalStreamOpcode.Snapshot)
        );
      },
      20000,
    );

    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(
        frame.opcode === TerminalStreamOpcode.Output ||
          frame.opcode === TerminalStreamOpcode.Snapshot,
      ).toBe(true);
    }

    ctx.client.sendTerminalInput(terminalId, {
      type: "input",
      data: "echo after-burst\r",
    });
    const postBurstFrame = await waitForRawBinaryFrame(
      ws,
      (frame) => getFrameText(frame).includes("after-burst"),
      10000,
    );
    expect(getFrameText(postBurstFrame)).toContain("after-burst");
  } finally {
    await closeWebSocket(ws);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 40000);

describe("capture", () => {
  test("captures visible terminal output as plain text", async () => {
    const cwd = tmpCwd();
    tempDirs.push(cwd);
    const created = await ctx.client.createTerminal(cwd);
    const terminalId = created.terminal!.id;

    await ctx.client.subscribeTerminal(terminalId);
    ctx.client.sendTerminalInput(terminalId, {
      type: "input",
      data: "echo hello world\r",
    });
    await waitForTerminalOutput(
      ctx.client,
      terminalId,
      (text) => text.includes("hello world"),
      15000,
    );

    const capture = await ctx.client.captureTerminal(terminalId);

    expect(capture.lines.join("\n")).toContain("hello world");
    expect(capture.totalLines).toBeGreaterThan(0);
  }, 15000);

  test("captures with start/end line range", async () => {
    const cwd = tmpCwd();
    tempDirs.push(cwd);
    const created = await ctx.client.createTerminal(cwd);
    const terminalId = created.terminal!.id;

    await ctx.client.subscribeTerminal(terminalId);
    ctx.client.sendTerminalInput(terminalId, {
      type: "input",
      data: "echo line1\r",
    });
    await waitForTerminalOutput(ctx.client, terminalId, (text) => text.includes("line1"), 15000);
    ctx.client.sendTerminalInput(terminalId, {
      type: "input",
      data: "echo line2\r",
    });
    await waitForTerminalOutput(ctx.client, terminalId, (text) => text.includes("line2"), 15000);
    ctx.client.sendTerminalInput(terminalId, {
      type: "input",
      data: "echo line3\r",
    });
    await waitForTerminalOutput(ctx.client, terminalId, (text) => text.includes("line3"), 15000);

    const fullCapture = await ctx.client.captureTerminal(terminalId);
    const rangedCapture = await ctx.client.captureTerminal(terminalId, {
      start: 0,
      end: 2,
    });

    expect(rangedCapture.lines).toHaveLength(3);
    expect(rangedCapture.totalLines).toBe(fullCapture.totalLines);
  }, 15000);

  test("supports negative line indices", async () => {
    const cwd = tmpCwd();
    tempDirs.push(cwd);
    const created = await ctx.client.createTerminal(cwd);
    const terminalId = created.terminal!.id;

    await ctx.client.subscribeTerminal(terminalId);
    ctx.client.sendTerminalInput(terminalId, {
      type: "input",
      data: "echo alpha\r",
    });
    await waitForTerminalOutput(ctx.client, terminalId, (text) => text.includes("alpha"), 15000);
    ctx.client.sendTerminalInput(terminalId, {
      type: "input",
      data: "echo beta\r",
    });
    await waitForTerminalOutput(ctx.client, terminalId, (text) => text.includes("beta"), 15000);
    ctx.client.sendTerminalInput(terminalId, {
      type: "input",
      data: "echo gamma\r",
    });
    await waitForTerminalOutput(ctx.client, terminalId, (text) => text.includes("gamma"), 15000);

    const capture = await ctx.client.captureTerminal(terminalId, {
      start: -3,
    });

    expect(capture.lines).toHaveLength(3);
  }, 15000);

  test("strips ANSI by default", async () => {
    const cwd = tmpCwd();
    tempDirs.push(cwd);
    const created = await ctx.client.createTerminal(cwd);
    const terminalId = created.terminal!.id;

    await ctx.client.subscribeTerminal(terminalId);
    ctx.client.sendTerminalInput(terminalId, {
      type: "input",
      data: "printf '\\033[31mred text\\033[0m\\n'\r",
    });
    await waitForTerminalOutput(ctx.client, terminalId, (text) => text.includes("red text"), 15000);

    const capture = await ctx.client.captureTerminal(terminalId);
    const capturedText = capture.lines.join("\n");

    expect(capturedText).toContain("red text");
    expect(capturedText).not.toContain("\u001b[31m");
  }, 15000);

  test("returns empty for non-existent terminal", async () => {
    const capture = await ctx.client.captureTerminal("terminal-does-not-exist");

    expect(capture.lines).toEqual([]);
    expect(capture.totalLines).toBe(0);
  });
});

describe("list terminals across directories", () => {
  test("lists terminals from all directories when cwd is omitted", async () => {
    const cwd1 = tmpCwd();
    const cwd2 = tmpCwd();
    tempDirs.push(cwd1, cwd2);

    const firstCreated = await ctx.client.createTerminal(cwd1, "first-terminal");
    const secondCreated = await ctx.client.createTerminal(cwd2, "second-terminal");

    const list = await ctx.client.listTerminals();

    expect(list).not.toHaveProperty("cwd");
    expect(list.terminals).toEqual(
      expect.arrayContaining([
        {
          id: firstCreated.terminal!.id,
          name: "first-terminal",
        },
        {
          id: secondCreated.terminal!.id,
          name: "second-terminal",
        },
      ]),
    );
  });

  test("lists terminals for specific directory when cwd is provided", async () => {
    const cwd1 = tmpCwd();
    const cwd2 = tmpCwd();
    tempDirs.push(cwd1, cwd2);

    const firstCreated = await ctx.client.createTerminal(cwd1, "cwd-one-terminal");
    await ctx.client.createTerminal(cwd2, "cwd-two-terminal");

    const list = await ctx.client.listTerminals(cwd1);

    expect(list.cwd).toBe(cwd1);
    expect(list.terminals).toEqual([
      {
        id: firstCreated.terminal!.id,
        name: "cwd-one-terminal",
      },
    ]);
  });
});
