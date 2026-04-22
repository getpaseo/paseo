import type { Page } from "@playwright/test";

export type TerminalRenderProbeSnapshot = {
  setCount: number;
  unsetCount: number;
  writeCount: number;
  resetWrites: number;
  clearScreenWrites: number;
  altEnterWrites: number;
  altExitWrites: number;
  events: TerminalRenderProbeEvent[];
  frames: TerminalFrame[];
};

export type TerminalRenderProbeEvent = {
  at: number;
  type: "set" | "unset" | "reset-write" | "clear-write" | "alt-enter-write" | "alt-exit-write";
  preview?: string;
};

export type TerminalFrame = {
  at: number;
  rowCount: number;
  nonEmptyRows: number;
  firstNonEmptyRow: number | null;
  text: string;
  topText: string;
};

export type TerminalRenderProbeSummary = Omit<TerminalRenderProbeSnapshot, "frames"> & {
  frameCount: number;
};

export type TerminalKeystrokeStressReport = {
  inputTextLength: number;
  keydownCount: number;
  inputFrameCount: number;
  outputFrameCount: number;
  textMessageFrameCount: number;
  textMessagePayloadBytes: number;
  largeTextMessageCount: number;
  largestTextMessageBytes: number;
  agentStreamTextMessageCount: number;
  agentStreamTextMessagePayloadBytes: number;
  largeAgentStreamTextMessageCount: number;
  largestAgentStreamTextMessageBytes: number;
  appEventCount: number;
  appEventCounts: Record<string, number>;
  runtimeMaxQueueDepth: number;
  xtermWriteCount: number;
  inputFramePayloadBytes: number;
  outputFramePayloadBytes: number;
  keydownToInputFrameMs: LatencyStats | null;
  inputFrameToOutputFrameMs: LatencyStats | null;
  appBinaryReceivedToFrameDecodedMs: LatencyStats | null;
  appFrameDecodedToTerminalEmitMs: LatencyStats | null;
  appTerminalEmitListenerDurationMs: LatencyStats | null;
  appTerminalEmitToStreamControllerOutputMs: LatencyStats | null;
  appStreamControllerDecodeToOnOutputMs: LatencyStats | null;
  appStreamControllerToEmulatorWriteMs: LatencyStats | null;
  appEmulatorWriteToRuntimeEnqueuedMs: LatencyStats | null;
  appRuntimeEnqueuedToOperationStartMs: LatencyStats | null;
  appRuntimeOperationStartToXtermWriteMs: LatencyStats | null;
  appRuntimeXtermWriteToCommitMs: LatencyStats | null;
  appBinaryReceivedToRuntimeEnqueuedMs: LatencyStats | null;
  appBinaryReceivedToRuntimeOperationStartMs: LatencyStats | null;
  appBinaryReceivedToXtermCommitMs: LatencyStats | null;
  outputFrameToXtermWriteMs: LatencyStats | null;
  xtermWriteDurationMs: LatencyStats | null;
  keydownToXtermCommitMs: LatencyStats | null;
  firstKeydownAt: number | null;
  lastXtermCommitAt: number | null;
};

export type LatencyStats = {
  count: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  avgMs: number;
};

export async function installTerminalRenderProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type ProbeState = {
      term: any;
      setCount: number;
      unsetCount: number;
      writeCount: number;
      resetWrites: number;
      clearScreenWrites: number;
      altEnterWrites: number;
      altExitWrites: number;
      events: TerminalRenderProbeEvent[];
      frames: TerminalFrame[];
      rafId: number | null;
      sampleUntil: number;
      reset: () => void;
      snapshot: () => TerminalRenderProbeSnapshot;
      startSampling: (durationMs: number) => void;
    };

    const win = window as any;
    const existingDescriptor = Object.getOwnPropertyDescriptor(win, "__paseoTerminal");
    const getExisting = () =>
      existingDescriptor?.get ? existingDescriptor.get.call(win) : existingDescriptor?.value;

    const probe: ProbeState = {
      term: getExisting(),
      setCount: 0,
      unsetCount: 0,
      writeCount: 0,
      resetWrites: 0,
      clearScreenWrites: 0,
      altEnterWrites: 0,
      altExitWrites: 0,
      events: [],
      frames: [],
      rafId: null,
      sampleUntil: 0,
      reset() {
        this.setCount = 0;
        this.unsetCount = 0;
        this.writeCount = 0;
        this.resetWrites = 0;
        this.clearScreenWrites = 0;
        this.altEnterWrites = 0;
        this.altExitWrites = 0;
        this.events = [];
        this.frames = [];
      },
      snapshot() {
        return {
          setCount: this.setCount,
          unsetCount: this.unsetCount,
          writeCount: this.writeCount,
          resetWrites: this.resetWrites,
          clearScreenWrites: this.clearScreenWrites,
          altEnterWrites: this.altEnterWrites,
          altExitWrites: this.altExitWrites,
          events: this.events,
          frames: this.frames,
        };
      },
      startSampling(durationMs: number) {
        this.sampleUntil = performance.now() + durationMs;
        if (this.rafId !== null) {
          cancelAnimationFrame(this.rafId);
        }
        const sample = () => {
          const rows = Array.from(document.querySelectorAll(".xterm-rows > div")).map(
            (row) => row.textContent ?? "",
          );
          const nonEmptyRows = rows.filter((row) => row.trim().length > 0);
          const firstNonEmptyRow = rows.findIndex((row) => row.trim().length > 0);
          this.frames.push({
            at: performance.now(),
            rowCount: rows.length,
            nonEmptyRows: nonEmptyRows.length,
            firstNonEmptyRow: firstNonEmptyRow === -1 ? null : firstNonEmptyRow,
            text: rows.join("\n"),
            topText: rows.slice(0, 3).join("\n"),
          });
          if (performance.now() < this.sampleUntil) {
            this.rafId = requestAnimationFrame(sample);
          } else {
            this.rafId = null;
          }
        };
        this.rafId = requestAnimationFrame(sample);
      },
    };

    Object.defineProperty(win, "__terminalRenderProbe", {
      configurable: true,
      value: probe,
    });

    Object.defineProperty(win, "__paseoTerminal", {
      configurable: true,
      get() {
        return probe.term;
      },
      set(next: any) {
        if (next === undefined) {
          probe.unsetCount += 1;
          probe.events.push({ at: performance.now(), type: "unset" });
          probe.term = next;
          return;
        }

        probe.setCount += 1;
        probe.events.push({ at: performance.now(), type: "set" });
        probe.term = next;

        if (next?.write && !next.__paseoRenderProbeWriteWrapped) {
          const originalWrite = next.write.bind(next);
          next.write = (data: string | Uint8Array, callback?: () => void) => {
            const text =
              typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array);
            probe.writeCount += 1;
            const preview = text
              .replace(/\u001b/g, "\\x1b")
              .replace(/\r/g, "\\r")
              .replace(/\n/g, "\\n")
              .slice(0, 160);
            if (text.includes("\u001bc")) {
              probe.resetWrites += 1;
              probe.events.push({ at: performance.now(), type: "reset-write", preview });
            }
            if (text.includes("\u001b[2J")) {
              probe.clearScreenWrites += 1;
              probe.events.push({ at: performance.now(), type: "clear-write", preview });
            }
            if (text.includes("\u001b[?1049h")) {
              probe.altEnterWrites += 1;
              probe.events.push({ at: performance.now(), type: "alt-enter-write", preview });
            }
            if (text.includes("\u001b[?1049l")) {
              probe.altExitWrites += 1;
              probe.events.push({ at: performance.now(), type: "alt-exit-write", preview });
            }
            return originalWrite(data, callback);
          };
          next.__paseoRenderProbeWriteWrapped = true;
        }
      },
    });
  });
}

export async function resetTerminalRenderProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__terminalRenderProbe.reset();
  });
}

export async function startTerminalFrameSampling(page: Page, durationMs = 2500): Promise<void> {
  await page.evaluate((ms) => {
    (window as any).__terminalRenderProbe.startSampling(ms);
  }, durationMs);
}

export async function readTerminalRenderProbe(page: Page): Promise<TerminalRenderProbeSnapshot> {
  return page.evaluate(() => (window as any).__terminalRenderProbe.snapshot());
}

export async function terminalVisibleText(page: Page): Promise<string> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".xterm-rows > div"))
      .map((row) => row.textContent ?? "")
      .join("\n"),
  );
}

export function summarizeTerminalRenderProbe(
  probe: TerminalRenderProbeSnapshot,
): TerminalRenderProbeSummary {
  return {
    setCount: probe.setCount,
    unsetCount: probe.unsetCount,
    writeCount: probe.writeCount,
    resetWrites: probe.resetWrites,
    clearScreenWrites: probe.clearScreenWrites,
    altEnterWrites: probe.altEnterWrites,
    altExitWrites: probe.altExitWrites,
    events: probe.events,
    frameCount: probe.frames.length,
  };
}

export async function installTerminalKeystrokeStressProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type TimedTextEvent = {
      at: number;
      text: string;
      bytes: number;
    };
    type TimedTextMessageEvent = {
      at: number;
      bytes: number;
      kind: string | null;
    };
    type XtermWriteEvent = {
      at: number;
      committedAt: number | null;
      text: string;
      bytes: number;
    };
    type AppProbeEvent = {
      type: string;
      at: number;
      bytes?: number;
      queueDepth?: number;
    };
    type StressProbeState = {
      keydowns: Array<{ at: number; key: string }>;
      inputFrames: TimedTextEvent[];
      outputFrames: TimedTextEvent[];
      textMessageFrames: TimedTextMessageEvent[];
      xtermWrites: XtermWriteEvent[];
      appEvents: AppProbeEvent[];
      reset: () => void;
      report: (inputText: string) => TerminalKeystrokeStressReport;
    };

    const INPUT_OPCODE = 0x02;
    const OUTPUT_OPCODE = 0x01;
    const decoder = new TextDecoder();

    function bytesFrom(data: unknown): Uint8Array | null {
      if (data instanceof Uint8Array) return data;
      if (data instanceof ArrayBuffer) return new Uint8Array(data);
      if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      }
      return null;
    }

    function eventDataBytes(data: unknown): Promise<Uint8Array | null> {
      const bytes = bytesFrom(data);
      if (bytes) return Promise.resolve(bytes);
      if (typeof Blob !== "undefined" && data instanceof Blob) {
        return data.arrayBuffer().then((buffer) => new Uint8Array(buffer));
      }
      return Promise.resolve(null);
    }

    function frameText(bytes: Uint8Array): string {
      return decoder.decode(bytes.slice(2));
    }

    function eventDataText(data: unknown): Promise<string | null> {
      if (typeof data === "string") {
        return Promise.resolve(data);
      }
      if (typeof Blob !== "undefined" && data instanceof Blob) {
        return data.text();
      }
      return Promise.resolve(null);
    }

    function textMessageKind(text: string): string | null {
      try {
        const parsed = JSON.parse(text) as {
          type?: unknown;
          message?: {
            type?: unknown;
          };
        };
        if (typeof parsed.type !== "string") {
          return null;
        }
        if (typeof parsed.message?.type === "string") {
          return `${parsed.type}:${parsed.message.type}`;
        }
        return parsed.type;
      } catch {
        return null;
      }
    }

    function summarize(values: number[]): LatencyStats | null {
      if (values.length === 0) return null;
      const sorted = [...values].sort((a, b) => a - b);
      const percentile = (p: number) => {
        const index = Math.ceil((p / 100) * sorted.length) - 1;
        return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
      };
      const total = values.reduce((sum, value) => sum + value, 0);
      const round2 = (value: number) => Math.round(value * 100) / 100;
      return {
        count: values.length,
        minMs: round2(sorted[0] ?? 0),
        p50Ms: round2(percentile(50)),
        p95Ms: round2(percentile(95)),
        maxMs: round2(sorted[sorted.length - 1] ?? 0),
        avgMs: round2(total / values.length),
      };
    }

    function firstAtOrAfter<T extends { at: number }>(events: T[], at: number): T | null {
      return events.find((event) => event.at >= at) ?? null;
    }

    function firstCommitAtOrAfter(events: XtermWriteEvent[], at: number): XtermWriteEvent | null {
      return (
        events.find((event) => typeof event.committedAt === "number" && event.committedAt >= at) ??
        null
      );
    }

    function countByType(events: AppProbeEvent[]): Record<string, number> {
      const counts: Record<string, number> = {};
      for (const event of events) {
        counts[event.type] = (counts[event.type] ?? 0) + 1;
      }
      return counts;
    }

    function appEventsOf(type: string, events: AppProbeEvent[]): AppProbeEvent[] {
      return events.filter((event) => event.type === type);
    }

    function latencyByIndex(from: AppProbeEvent[], to: AppProbeEvent[]): number[] {
      const count = Math.min(from.length, to.length);
      const values: number[] = [];
      for (let index = 0; index < count; index += 1) {
        values.push(to[index]!.at - from[index]!.at);
      }
      return values;
    }

    const probe: StressProbeState = {
      keydowns: [],
      inputFrames: [],
      outputFrames: [],
      textMessageFrames: [],
      xtermWrites: [],
      appEvents: [],
      reset() {
        this.keydowns = [];
        this.inputFrames = [];
        this.outputFrames = [];
        this.textMessageFrames = [];
        this.xtermWrites = [];
        this.appEvents = [];
      },
      report(inputText: string) {
        const binaryReceived = appEventsOf("daemon-client-binary-received", this.appEvents);
        const frameDecoded = appEventsOf("daemon-client-frame-decoded", this.appEvents);
        const terminalEmit = appEventsOf("daemon-client-terminal-emit", this.appEvents);
        const terminalEmitted = appEventsOf("daemon-client-terminal-emitted", this.appEvents);
        const streamControllerOutput = appEventsOf("stream-controller-output", this.appEvents);
        const streamControllerOnOutput = appEventsOf("stream-controller-on-output", this.appEvents);
        const emulatorWriteOutput = appEventsOf("terminal-emulator-write-output", this.appEvents);
        const runtimeWriteEnqueued = appEventsOf("runtime-write-enqueued", this.appEvents);
        const runtimeOperationStart = appEventsOf("runtime-operation-start", this.appEvents);
        const runtimeXtermWrite = appEventsOf("runtime-xterm-write", this.appEvents);
        const runtimeXtermCommitted = appEventsOf("runtime-xterm-committed", this.appEvents);
        const keydownToInputFrame = this.keydowns
          .map((keydown) => firstAtOrAfter(this.inputFrames, keydown.at)?.at ?? null)
          .filter((at): at is number => at !== null)
          .map((at, index) => at - this.keydowns[index]!.at);
        const inputFrameToOutputFrame = this.inputFrames
          .map((input) => {
            const output = firstAtOrAfter(this.outputFrames, input.at);
            return output ? output.at - input.at : null;
          })
          .filter((value): value is number => value !== null);
        const outputFrameToXtermWrite = this.outputFrames
          .map((output) => {
            const write = firstAtOrAfter(this.xtermWrites, output.at);
            return write ? write.at - output.at : null;
          })
          .filter((value): value is number => value !== null);
        const xtermWriteDurations = this.xtermWrites
          .map((write) => (write.committedAt === null ? null : write.committedAt - write.at))
          .filter((value): value is number => value !== null);
        const keydownToXtermCommit = this.keydowns
          .map((keydown) => {
            const write = firstCommitAtOrAfter(this.xtermWrites, keydown.at);
            return write?.committedAt ? write.committedAt - keydown.at : null;
          })
          .filter((value): value is number => value !== null);

        return {
          inputTextLength: inputText.length,
          keydownCount: this.keydowns.length,
          inputFrameCount: this.inputFrames.length,
          outputFrameCount: this.outputFrames.length,
          textMessageFrameCount: this.textMessageFrames.length,
          textMessagePayloadBytes: this.textMessageFrames.reduce(
            (sum, frame) => sum + frame.bytes,
            0,
          ),
          largeTextMessageCount: this.textMessageFrames.filter((frame) => frame.bytes >= 50_000)
            .length,
          largestTextMessageBytes: Math.max(
            0,
            ...this.textMessageFrames.map((frame) => frame.bytes),
          ),
          agentStreamTextMessageCount: this.textMessageFrames.filter(
            (frame) => frame.kind === "session:agent_stream",
          ).length,
          agentStreamTextMessagePayloadBytes: this.textMessageFrames
            .filter((frame) => frame.kind === "session:agent_stream")
            .reduce((sum, frame) => sum + frame.bytes, 0),
          largeAgentStreamTextMessageCount: this.textMessageFrames.filter(
            (frame) => frame.kind === "session:agent_stream" && frame.bytes >= 50_000,
          ).length,
          largestAgentStreamTextMessageBytes: Math.max(
            0,
            ...this.textMessageFrames
              .filter((frame) => frame.kind === "session:agent_stream")
              .map((frame) => frame.bytes),
          ),
          appEventCount: this.appEvents.length,
          appEventCounts: countByType(this.appEvents),
          runtimeMaxQueueDepth: Math.max(
            0,
            ...this.appEvents
              .map((event) => event.queueDepth)
              .filter((value): value is number => typeof value === "number"),
          ),
          xtermWriteCount: this.xtermWrites.length,
          inputFramePayloadBytes: this.inputFrames.reduce((sum, frame) => sum + frame.bytes, 0),
          outputFramePayloadBytes: this.outputFrames.reduce((sum, frame) => sum + frame.bytes, 0),
          keydownToInputFrameMs: summarize(keydownToInputFrame),
          inputFrameToOutputFrameMs: summarize(inputFrameToOutputFrame),
          appBinaryReceivedToFrameDecodedMs: summarize(
            latencyByIndex(binaryReceived, frameDecoded),
          ),
          appFrameDecodedToTerminalEmitMs: summarize(latencyByIndex(frameDecoded, terminalEmit)),
          appTerminalEmitListenerDurationMs: summarize(
            latencyByIndex(terminalEmit, terminalEmitted),
          ),
          appTerminalEmitToStreamControllerOutputMs: summarize(
            latencyByIndex(terminalEmit, streamControllerOutput),
          ),
          appStreamControllerDecodeToOnOutputMs: summarize(
            latencyByIndex(streamControllerOutput, streamControllerOnOutput),
          ),
          appStreamControllerToEmulatorWriteMs: summarize(
            latencyByIndex(streamControllerOnOutput, emulatorWriteOutput),
          ),
          appEmulatorWriteToRuntimeEnqueuedMs: summarize(
            latencyByIndex(emulatorWriteOutput, runtimeWriteEnqueued),
          ),
          appRuntimeEnqueuedToOperationStartMs: summarize(
            latencyByIndex(runtimeWriteEnqueued, runtimeOperationStart),
          ),
          appRuntimeOperationStartToXtermWriteMs: summarize(
            latencyByIndex(runtimeOperationStart, runtimeXtermWrite),
          ),
          appRuntimeXtermWriteToCommitMs: summarize(
            latencyByIndex(runtimeXtermWrite, runtimeXtermCommitted),
          ),
          appBinaryReceivedToRuntimeEnqueuedMs: summarize(
            latencyByIndex(binaryReceived, runtimeWriteEnqueued),
          ),
          appBinaryReceivedToRuntimeOperationStartMs: summarize(
            latencyByIndex(binaryReceived, runtimeOperationStart),
          ),
          appBinaryReceivedToXtermCommitMs: summarize(
            latencyByIndex(binaryReceived, runtimeXtermCommitted),
          ),
          outputFrameToXtermWriteMs: summarize(outputFrameToXtermWrite),
          xtermWriteDurationMs: summarize(xtermWriteDurations),
          keydownToXtermCommitMs: summarize(keydownToXtermCommit),
          firstKeydownAt: this.keydowns[0]?.at ?? null,
          lastXtermCommitAt:
            this.xtermWrites
              .map((write) => write.committedAt)
              .filter((at): at is number => typeof at === "number")
              .at(-1) ?? null,
        };
      },
    };

    Object.defineProperty(window, "__terminalKeystrokeStressProbe", {
      configurable: true,
      value: probe,
    });

    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key.length === 1) {
          probe.keydowns.push({ at: performance.now(), key: event.key });
        }
      },
      true,
    );

    const NativeWebSocket = window.WebSocket;
    class InstrumentedWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        if (protocols === undefined) {
          super(url);
        } else {
          super(url, protocols);
        }
        super.addEventListener("message", (event) => {
          void eventDataBytes(event.data).then((bytes) => {
            if (!bytes || bytes.byteLength < 2 || bytes[0] !== OUTPUT_OPCODE) {
              return;
            }
            probe.outputFrames.push({
              at: performance.now(),
              text: frameText(bytes),
              bytes: bytes.byteLength - 2,
            });
          });
          void eventDataText(event.data).then((text) => {
            if (text === null) {
              return;
            }
            probe.textMessageFrames.push({
              at: performance.now(),
              bytes: new TextEncoder().encode(text).byteLength,
              kind: textMessageKind(text),
            });
          });
        });
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        const bytes = bytesFrom(data);
        if (bytes && bytes.byteLength >= 2 && bytes[0] === INPUT_OPCODE) {
          probe.inputFrames.push({
            at: performance.now(),
            text: frameText(bytes),
            bytes: bytes.byteLength - 2,
          });
        }
        super.send(data);
      }
    }

    Object.defineProperty(InstrumentedWebSocket, "CONNECTING", {
      value: NativeWebSocket.CONNECTING,
    });
    Object.defineProperty(InstrumentedWebSocket, "OPEN", { value: NativeWebSocket.OPEN });
    Object.defineProperty(InstrumentedWebSocket, "CLOSING", { value: NativeWebSocket.CLOSING });
    Object.defineProperty(InstrumentedWebSocket, "CLOSED", { value: NativeWebSocket.CLOSED });
    window.WebSocket = InstrumentedWebSocket as typeof WebSocket;

    const existingDescriptor = Object.getOwnPropertyDescriptor(window, "__paseoTerminal");
    const getExisting = () =>
      existingDescriptor?.get ? existingDescriptor.get.call(window) : existingDescriptor?.value;

    let terminal = getExisting();
    Object.defineProperty(window, "__paseoTerminal", {
      configurable: true,
      get() {
        return terminal;
      },
      set(next: any) {
        terminal = next;
        if (next?.write && !next.__paseoKeystrokeProbeWriteWrapped) {
          const originalWrite = next.write.bind(next);
          next.write = (data: string | Uint8Array, callback?: () => void) => {
            const text =
              typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array);
            const event: XtermWriteEvent = {
              at: performance.now(),
              committedAt: null,
              text,
              bytes: text.length,
            };
            probe.xtermWrites.push(event);
            return originalWrite(data, () => {
              event.committedAt = performance.now();
              callback?.();
            });
          };
          next.__paseoKeystrokeProbeWriteWrapped = true;
        }
      },
    });
  });
}

export async function resetTerminalKeystrokeStressProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__terminalKeystrokeStressProbe.reset();
  });
}

export async function readTerminalKeystrokeStressReport(
  page: Page,
  inputText: string,
): Promise<TerminalKeystrokeStressReport> {
  return page.evaluate(
    (text) => (window as any).__terminalKeystrokeStressProbe.report(text),
    inputText,
  );
}
