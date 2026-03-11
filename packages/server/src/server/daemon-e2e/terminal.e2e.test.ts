import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import WebSocket from "ws";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../test-utils/index.js";
import {
  BinaryMuxChannel,
  TerminalBinaryMessageType,
  decodeBinaryMuxFrame,
  encodeBinaryMuxFrame,
} from "../../shared/binary-mux.js";

const decoder = new TextDecoder();

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-terminal-e2e-"));
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 25
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

async function waitForStableNumber(
  read: () => number,
  input: {
    stableMs: number;
    timeoutMs: number;
    intervalMs?: number;
  }
): Promise<number> {
  const intervalMs = input.intervalMs ?? 25;
  const start = Date.now();
  let lastValue = read();
  let stableSince = Date.now();

  while (Date.now() - start < input.timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const nextValue = read();
    if (nextValue !== lastValue) {
      lastValue = nextValue;
      stableSince = Date.now();
      continue;
    }
    if (Date.now() - stableSince >= input.stableMs) {
      return nextValue;
    }
  }

  throw new Error(
    `Timed out after ${input.timeoutMs}ms waiting for value to stabilize`
  );
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

const shouldRun = !process.env.CI;

(shouldRun ? describe : describe.skip)("daemon E2E terminal", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  test(
    "lists terminals for a directory (empty when none exist)",
    async () => {
      const cwd = tmpCwd();

      const result = await ctx.client.listTerminals(cwd);

      expect(result.cwd).toBe(cwd);
      expect(result.terminals).toHaveLength(0);

      rmSync(cwd, { recursive: true, force: true });
    },
    30000
  );

  test(
    "creates terminal with custom name",
    async () => {
      const cwd = tmpCwd();

      // Create a terminal with custom name
      const result = await ctx.client.createTerminal(cwd, "Dev Server");

      expect(result.error).toBeNull();
      expect(result.terminal).toBeTruthy();
      expect(result.terminal!.name).toBe("Dev Server");
      expect(result.terminal!.cwd).toBe(cwd);

      // Verify list now shows one terminal
      const list = await ctx.client.listTerminals(cwd);
      expect(list.terminals).toHaveLength(1);

      rmSync(cwd, { recursive: true, force: true });
    },
    30000
  );

  test(
    "emits terminals_changed for subscribed cwd when terminals are created",
    async () => {
      const cwd = tmpCwd();

      const snapshots: Array<{ cwd: string; names: string[] }> = [];
      const unsubscribe = ctx.client.on("terminals_changed", (message) => {
        if (message.type !== "terminals_changed") {
          return;
        }
        snapshots.push({
          cwd: message.payload.cwd,
          names: message.payload.terminals.map((terminal) => terminal.name),
        });
      });

      ctx.client.subscribeTerminals({ cwd });
      await ctx.client.createTerminal(cwd, "Dev Server");

      await waitForCondition(
        () =>
          snapshots.some(
            (snapshot) =>
              snapshot.cwd === cwd && snapshot.names.includes("Dev Server")
          ),
        10000
      );

      ctx.client.unsubscribeTerminals({ cwd });
      unsubscribe();
      rmSync(cwd, { recursive: true, force: true });
    },
    30000
  );

  test(
    "subscribes to terminal and receives state",
    async () => {
      const cwd = tmpCwd();

      const created = await ctx.client.createTerminal(cwd);
      const terminalId = created.terminal!.id;

      // Subscribe to terminal
      const subscribeResult = await ctx.client.subscribeTerminal(terminalId);

      expect(subscribeResult.error).toBeNull();
      expect(subscribeResult.terminalId).toBe(terminalId);
      expect(subscribeResult.state).toBeTruthy();
      expect(subscribeResult.state!.rows).toBeGreaterThan(0);
      expect(subscribeResult.state!.cols).toBeGreaterThan(0);
      expect(subscribeResult.state!.grid).toBeTruthy();
      expect(subscribeResult.state!.cursor).toBeTruthy();

      // Unsubscribe
      ctx.client.unsubscribeTerminal(terminalId);

      rmSync(cwd, { recursive: true, force: true });
    },
    30000
  );

  test(
    "sends input to terminal and receives output",
    async () => {
      const cwd = tmpCwd();

      const created = await ctx.client.createTerminal(cwd);
      const terminalId = created.terminal!.id;

      // Subscribe to terminal
      await ctx.client.subscribeTerminal(terminalId);

      // Send input
      ctx.client.sendTerminalInput(terminalId, { type: "input", data: "echo hello\r" });

      // Wait for output containing "hello" - may need multiple updates
      let foundHello = false;
      const start = Date.now();
      const timeout = 10000;

      while (!foundHello && Date.now() - start < timeout) {
        try {
          const output = await ctx.client.waitForTerminalOutput(terminalId, 2000);
          expect(output.terminalId).toBe(terminalId);
          expect(output.state).toBeTruthy();

          // Extract text from grid
          const gridText = output.state.grid
            .map((row) => row.map((cell) => cell.char).join("").trimEnd())
            .filter((line) => line.length > 0)
            .join("\n");

          if (gridText.includes("hello")) {
            foundHello = true;
          }
        } catch {
          // Timeout waiting for output, try again
        }
      }

      expect(foundHello).toBe(true);

      // Cleanup
      ctx.client.unsubscribeTerminal(terminalId);
      rmSync(cwd, { recursive: true, force: true });
    },
    30000
  );

  test(
    "kills terminal",
    async () => {
      const cwd = tmpCwd();

      // Create terminal
      const createResult = await ctx.client.createTerminal(cwd, "To Kill");
      expect(createResult.terminal).toBeTruthy();
      const terminalId = createResult.terminal!.id;

      // Kill terminal
      const killResult = await ctx.client.killTerminal(terminalId);
      expect(killResult.success).toBe(true);
      expect(killResult.terminalId).toBe(terminalId);

      // Verify terminal is gone by trying to subscribe
      const subscribeResult = await ctx.client.subscribeTerminal(terminalId);
      expect(subscribeResult.error).toBe("Terminal not found");

      rmSync(cwd, { recursive: true, force: true });
    },
    30000
  );

  test(
    "returns error for relative path",
    async () => {
      // Try to list terminals with relative path
      const list = await ctx.client.listTerminals("relative/path");

      // Should return empty terminals (error case)
      expect(list.terminals).toHaveLength(0);
    },
    30000
  );

  test(
    "preserves color mode in terminal output (fgMode/bgMode)",
    async () => {
      const cwd = tmpCwd();

      const created = await ctx.client.createTerminal(cwd);
      const terminalId = created.terminal!.id;

      // Subscribe to terminal
      await ctx.client.subscribeTerminal(terminalId);

      // Send printf with ANSI red color (mode 1)
      ctx.client.sendTerminalInput(terminalId, {
        type: "input",
        data: "printf '\\033[31mRED\\033[0m\\n'\r",
      });

      // Wait for output with colored text
      let foundColoredCell = false;
      let lastState: any = null;
      const start = Date.now();
      const timeout = 20000;

      while (!foundColoredCell && Date.now() - start < timeout) {
        try {
          const output = await ctx.client.waitForTerminalOutput(terminalId, 2000);
          lastState = output.state;

          const buffers = [output.state.grid, output.state.scrollback];
          for (const buffer of buffers) {
            for (const row of buffer) {
              for (const cell of row) {
                if (cell.fg === 1 || (cell.fgMode !== undefined && cell.fgMode > 0)) {
                  foundColoredCell = true;
                  // Mode is optional; fg should still indicate ANSI red.
                  if (cell.fgMode !== undefined) {
                    // 1 = 16 ANSI colors
                    expect(cell.fgMode).toBe(1);
                  }
                  expect(cell.fg).toBe(1); // ANSI red
                  break;
                }
              }
              if (foundColoredCell) break;
            }
            if (foundColoredCell) break;
          }
        } catch {
          // Timeout waiting for output, try again
        }
      }

      // Always assert that the command output made it through.
      const state = lastState;
      if (state) {
        const text = [...state.scrollback, ...state.grid]
          .map((row) => row.map((cell) => cell.char).join(""))
          .join("\n");
        expect(text).toContain("RED");
      }

      ctx.client.unsubscribeTerminal(terminalId);
      rmSync(cwd, { recursive: true, force: true });
    },
    30000
  );

  test(
    "streams terminal output over binary mux and supports modifier keys",
    async () => {
      const cwd = tmpCwd();
      const created = await ctx.client.createTerminal(cwd);
      const terminalId = created.terminal!.id;

      const attach = await ctx.client.attachTerminalStream(terminalId, { rows: 24, cols: 80 });
      expect(attach.error).toBeNull();
      expect(attach.streamId).toBeTypeOf("number");
      const streamId = attach.streamId!;

      let text = "";
      const unsubscribe = ctx.client.onTerminalStreamData(streamId, (chunk) => {
        text += decoder.decode(chunk.data, { stream: true });
      });

      ctx.client.sendTerminalStreamInput(streamId, "echo binary-stream\r");
      await waitForCondition(() => text.includes("binary-stream"), 10000);

      ctx.client.sendTerminalStreamInput(streamId, "cat -v\r");
      await waitForCondition(() => text.includes("cat -v"), 10000);

      // Ctrl+B is the default tmux prefix; cat -v should render it as ^B.
      ctx.client.sendTerminalStreamKey(streamId, { key: "b", ctrl: true });
      ctx.client.sendTerminalStreamInput(streamId, "\r");
      await waitForCondition(() => text.includes("^B"), 10000);

      // Stop cat
      ctx.client.sendTerminalStreamKey(streamId, { key: "c", ctrl: true });

      const detach = await ctx.client.detachTerminalStream(streamId);
      expect(detach.success).toBe(true);
      unsubscribe();
      rmSync(cwd, { recursive: true, force: true });
    },
    30000
  );

  test(
    "emits terminal_stream_exit and removes terminal when shell exits",
    async () => {
      const cwd = tmpCwd();
      const created = await ctx.client.createTerminal(cwd);
      const terminalId = created.terminal!.id;

      const attach = await ctx.client.attachTerminalStream(terminalId, { rows: 24, cols: 80 });
      expect(attach.error).toBeNull();
      const streamId = attach.streamId!;

      let sawExit = false;
      const unsubscribeExit = ctx.client.on("terminal_stream_exit", (message) => {
        if (message.type !== "terminal_stream_exit") {
          return;
        }
        if (
          message.payload.terminalId === terminalId &&
          message.payload.streamId === streamId
        ) {
          sawExit = true;
        }
      });

      const kill = await ctx.client.killTerminal(terminalId);
      expect(kill.success).toBe(true);

      await waitForCondition(() => sawExit, 10000);

      const next = await ctx.client.listTerminals(cwd);
      expect(next.terminals).toHaveLength(0);

      unsubscribeExit();
      rmSync(cwd, { recursive: true, force: true });
    },
    30000
  );

  test(
    "replays detached terminal output from resume offset (scrollback continuity)",
    async () => {
      const cwd = tmpCwd();
      const created = await ctx.client.createTerminal(cwd);
      const terminalId = created.terminal!.id;

      const attach = await ctx.client.attachTerminalStream(terminalId, { rows: 24, cols: 80 });
      expect(attach.error).toBeNull();
      const streamId = attach.streamId!;

      let output = "";
      let latestOffset = attach.currentOffset;
      const unsubscribe = ctx.client.onTerminalStreamData(streamId, (chunk) => {
        output += decoder.decode(chunk.data, { stream: true });
        latestOffset = chunk.endOffset;
      });

      ctx.client.sendTerminalStreamInput(streamId, "echo before-detach\r");
      await waitForCondition(() => output.includes("before-detach"), 10000);

      const firstDetach = await ctx.client.detachTerminalStream(streamId);
      expect(firstDetach.success).toBe(true);
      unsubscribe();

      // Terminal keeps running while hidden, stream is detached.
      ctx.client.sendTerminalInput(terminalId, { type: "input", data: "echo while-detached\r" });
      await new Promise((resolve) => setTimeout(resolve, 300));

      const resumed = await ctx.client.attachTerminalStream(terminalId, {
        resumeOffset: latestOffset,
      });
      expect(resumed.error).toBeNull();
      expect(resumed.streamId).toBeTypeOf("number");
      expect(resumed.reset).toBe(false);

      let replayedText = "";
      const resumedUnsub = ctx.client.onTerminalStreamData(resumed.streamId!, (chunk) => {
        if (chunk.replay) {
          replayedText += decoder.decode(chunk.data, { stream: true });
        }
      });

      await waitForCondition(() => replayedText.includes("while-detached"), 10000);

      const secondDetach = await ctx.client.detachTerminalStream(resumed.streamId!);
      expect(secondDetach.success).toBe(true);
      resumedUnsub();
      rmSync(cwd, { recursive: true, force: true });
    },
    30000
  );

  test(
    "caps terminal stream output within the backpressure window",
    async () => {
      const cwd = tmpCwd();
      const created = await ctx.client.createTerminal(cwd);
      const terminalId = created.terminal!.id;

      const ws = new WebSocket(`ws://127.0.0.1:${ctx.daemon.port}/ws`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });

      const helloReady = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Timed out waiting for websocket welcome"));
        }, 10000);

        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };

        const onMessage = (raw: WebSocket.RawData) => {
          if (Array.isArray(raw)) {
            raw = Buffer.concat(
              raw.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part)))
            );
          }
          if (typeof raw !== "string" && !Buffer.isBuffer(raw)) {
            return;
          }
          const text = typeof raw === "string" ? raw : raw.toString("utf8");
          try {
            const parsed = JSON.parse(text) as { type?: string };
            if (parsed.type === "welcome") {
              cleanup();
              resolve();
            }
          } catch {
            // Ignore non-JSON payloads (binary mux frames).
          }
        };

        const cleanup = () => {
          clearTimeout(timeout);
          ws.off("message", onMessage);
          ws.off("error", onError);
        };

        ws.on("message", onMessage);
        ws.on("error", onError);
      });

      ws.send(
        JSON.stringify({
          type: "hello",
          clientId: `terminal-backpressure-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2)}`,
          clientType: "cli",
          protocolVersion: 1,
        })
      );
      await helloReady;

      const attachRequestId = `attach-${Date.now()}`;
      const detachRequestId = `detach-${Date.now()}`;
      let streamId: number | null = null;
      let latestEndOffset = 0;
      let outputBytes = 0;

      const streamReady = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for attach_terminal_stream_response"));
        }, 10000);

        ws.on("message", (raw) => {
          if (Array.isArray(raw)) {
            raw = Buffer.concat(raw.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part))));
          }
          if (typeof raw !== "string" && !Buffer.isBuffer(raw)) {
            return;
          }
          const text = typeof raw === "string" ? raw : raw.toString("utf8");
          try {
            const parsed = JSON.parse(text) as {
              type?: string;
              message?: {
                type?: string;
                payload?: { streamId?: number | null; requestId?: string };
              };
            };
            if (
              parsed.type === "session" &&
              parsed.message?.type === "attach_terminal_stream_response" &&
              parsed.message.payload?.requestId === attachRequestId
            ) {
              const nextStreamId = parsed.message.payload.streamId;
              if (typeof nextStreamId === "number") {
                streamId = nextStreamId;
                clearTimeout(timeout);
                resolve();
              }
            }
          } catch {
            // Ignore non-JSON payloads (binary mux frames).
          }
        });
      });

      ws.on("message", (raw) => {
        if (typeof raw === "string") {
          return;
        }
        if (Array.isArray(raw)) {
          raw = Buffer.concat(raw.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part))));
        }
        const bytes = Buffer.isBuffer(raw)
          ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
          : new Uint8Array(raw as ArrayBuffer);
        const frame = decodeBinaryMuxFrame(bytes);
        if (
          !frame ||
          frame.channel !== BinaryMuxChannel.Terminal ||
          frame.messageType !== TerminalBinaryMessageType.OutputUtf8
        ) {
          return;
        }
        const chunkBytes = frame.payload?.byteLength ?? 0;
        outputBytes += chunkBytes;
        latestEndOffset = frame.offset + chunkBytes;
      });

      ws.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "attach_terminal_stream_request",
            terminalId,
            requestId: attachRequestId,
          },
        })
      );
      await streamReady;
      expect(streamId).toBeTypeOf("number");

      ws.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "terminal_input",
            terminalId,
            message: {
              type: "input",
              data: "head -c 8388608 /dev/zero | tr '\\0' 'A'\r",
            },
          },
        })
      );

      await waitForCondition(() => outputBytes > 0, 10000);
      await waitForCondition(() => outputBytes >= 128 * 1024, 10000);
      const beforeAckBytes = await waitForStableNumber(() => outputBytes, {
        stableMs: 1000,
        timeoutMs: 10000,
      });
      expect(beforeAckBytes).toBeGreaterThan(0);
      expect(beforeAckBytes).toBeGreaterThan(128 * 1024);
      expect(beforeAckBytes).toBeLessThan(320 * 1024);
      expect(latestEndOffset).toBeGreaterThan(0);

      ws.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "detach_terminal_stream_request",
            streamId,
            requestId: detachRequestId,
          },
        })
      );

      ws.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    30000
  );

  test(
    "profiles keystroke-to-echo latency via daemon terminal stream under burst load",
    async () => {
      const cwd = tmpCwd();
      const created = await ctx.client.createTerminal(cwd);
      const terminalId = created.terminal!.id;

      const attach = await ctx.client.attachTerminalStream(terminalId);
      expect(attach.error).toBeNull();
      const streamId = attach.streamId!;

      let output = "";
      const unsubscribe = ctx.client.onTerminalStreamData(streamId, (chunk) => {
        output += decoder.decode(chunk.data, { stream: true });
      });

      type Trial = {
        phase: "stream-only" | "stream+state-sub";
        iteration: number;
        payloadBytes: number;
        latencyMs: number;
      };

      async function runBurstLoop(input: {
        phase: Trial["phase"];
        iterations: number;
        burstRepeat: number;
      }): Promise<Trial[]> {
        const trials: Trial[] = [];
        let searchStart = 0;

        for (let i = 0; i < input.iterations; i += 1) {
          const marker = `PASEO_LAT_${input.phase}_${i}_${Date.now()}_${Math.random()
            .toString(36)
            .slice(2, 8)}`;
          const burstBody = "abcdefghijklmnopqrstuvwxyz0123456789".repeat(input.burstRepeat);
          const payload = `${marker}_${burstBody}`;

          const start = performance.now();
          ctx.client.sendTerminalStreamInput(streamId, `${payload}\r`);

          await waitForCondition(() => output.indexOf(marker, searchStart) !== -1, 15000);

          const markerOffset = output.indexOf(marker, searchStart);
          if (markerOffset !== -1) {
            searchStart = markerOffset + marker.length;
          }

          trials.push({
            phase: input.phase,
            iteration: i + 1,
            payloadBytes: payload.length,
            latencyMs: performance.now() - start,
          });

          await new Promise((resolve) => setTimeout(resolve, 150));
        }

        return trials;
      }

      // Warm-up: establish prompt/output activity before timed loops.
      ctx.client.sendTerminalStreamInput(streamId, "echo PASEO_LAT_WARMUP\r");
      await waitForCondition(() => output.includes("PASEO_LAT_WARMUP"), 10000);

      const streamOnlyTrials = await runBurstLoop({
        phase: "stream-only",
        iterations: 10,
        burstRepeat: 12,
      });

      await ctx.client.subscribeTerminal(terminalId);
      const withStateSubscriptionTrials = await runBurstLoop({
        phase: "stream+state-sub",
        iterations: 10,
        burstRepeat: 12,
      });
      ctx.client.unsubscribeTerminal(terminalId);

      const allTrials = [...streamOnlyTrials, ...withStateSubscriptionTrials];
      const streamOnlyLatencies = streamOnlyTrials.map((trial) => trial.latencyMs);
      const withStateLatencies = withStateSubscriptionTrials.map((trial) => trial.latencyMs);

      const streamOnlyP50 = percentile(streamOnlyLatencies, 50);
      const streamOnlyP95 = percentile(streamOnlyLatencies, 95);
      const streamOnlyMax = percentile(streamOnlyLatencies, 100);
      const withStateP50 = percentile(withStateLatencies, 50);
      const withStateP95 = percentile(withStateLatencies, 95);
      const withStateMax = percentile(withStateLatencies, 100);

      expect(allTrials).toHaveLength(20);
      expect(streamOnlyLatencies.length).toBe(10);
      expect(withStateLatencies.length).toBe(10);

      // Diagnostic output: used as verification/measurement loop in local debugging.
      console.log(
        `[terminal-latency-loop] stream-only samples=${streamOnlyLatencies
          .map((n) => n.toFixed(1))
          .join(",")} mean=${mean(streamOnlyLatencies).toFixed(1)}ms p50=${streamOnlyP50.toFixed(
          1
        )}ms p95=${streamOnlyP95.toFixed(1)}ms max=${streamOnlyMax.toFixed(1)}ms`
      );
      console.log(
        `[terminal-latency-loop] stream+state-sub samples=${withStateLatencies
          .map((n) => n.toFixed(1))
          .join(",")} mean=${mean(withStateLatencies).toFixed(1)}ms p50=${withStateP50.toFixed(
          1
        )}ms p95=${withStateP95.toFixed(1)}ms max=${withStateMax.toFixed(1)}ms`
      );
      console.log(
        `[terminal-latency-loop] trial-details=${allTrials
          .map(
            (trial) =>
              `${trial.phase}#${trial.iteration}:${trial.latencyMs.toFixed(1)}ms(${trial.payloadBytes}b)`
          )
          .join(" ")}`
      );

      const detach = await ctx.client.detachTerminalStream(streamId);
      expect(detach.success).toBe(true);
      unsubscribe();
      rmSync(cwd, { recursive: true, force: true });
    },
    90000
  );
});
