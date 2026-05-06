import { performance } from "node:perf_hooks";
import type { Page, TestInfo } from "@playwright/test";
import { test, expect } from "./fixtures";
import { TerminalE2EHarness, type TerminalInstance } from "./helpers/terminal-dsl";
import {
  installTerminalKeystrokeStressProbe,
  readTerminalKeystrokeStressReport,
  resetTerminalKeystrokeStressProbe,
  type LatencyStats,
} from "./helpers/terminal-probes";
import { waitForTerminalContent } from "./helpers/terminal-perf";

const INPUT_TEXT = buildStressText(600);
const BIG_DIFF_BYTES = 256_000;
const SMALL_AGENT_STREAM_UPDATES = 1000;
const STRESS_TIMEOUT_MS = 15_000;
const RUN_MANUAL_TERMINAL_PERF = process.env.PASEO_TERMINAL_PERF_E2E === "1";
const terminalPerfDescribe = RUN_MANUAL_TERMINAL_PERF ? test.describe : test.describe.skip;

interface DaemonEchoReport {
  inputTextLength: number;
  inputFrameCount: number;
  outputEventCount: number;
  echoedBytes: number;
  sendToOutputMs: LatencyStats;
  firstSendAt: number;
  lastOutputAt: number;
}

terminalPerfDescribe("Terminal keystroke stress", () => {
  let harness: TerminalE2EHarness;

  test.beforeAll(async () => {
    harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-key-stress-" });
  });

  test.afterAll(async () => {
    await harness?.cleanup();
  });

  test("logs daemon-only and app keystroke echo latency under burst input", async ({
    page,
  }, testInfo) => {
    test.setTimeout(75_000);

    const daemonTerminal = await harness.createTerminal({ name: "daemon-keystroke-baseline" });
    try {
      const daemonReport = await measureDaemonBurstEcho(harness, daemonTerminal, INPUT_TEXT);
      await attachJson(testInfo, "daemon-keystroke-baseline", daemonReport);
      console.log("[terminal-stress-daemon]", JSON.stringify(daemonReport));

      expect(daemonReport.echoedBytes).toBeGreaterThanOrEqual(INPUT_TEXT.length);
    } finally {
      await harness.killTerminal(daemonTerminal.id);
    }

    await installTerminalKeystrokeStressProbe(page);
    const appBaselineReport = await measureAppBurstEcho({
      page,
      harness,
      terminalName: "app-keystroke-stress",
    });
    await attachJson(testInfo, "app-keystroke-stress", appBaselineReport);
    console.log("[terminal-stress-app]", JSON.stringify(appBaselineReport));

    expect(appBaselineReport.keydownCount).toBeGreaterThanOrEqual(INPUT_TEXT.length);
    expect(appBaselineReport.inputFramePayloadBytes).toBeGreaterThanOrEqual(INPUT_TEXT.length);
    expect(appBaselineReport.outputFramePayloadBytes).toBeGreaterThanOrEqual(INPUT_TEXT.length);
    expect(appBaselineReport.keydownToXtermCommitMs?.count ?? 0).toBeGreaterThan(0);

    const appObserveNodeBurstReport = await measureAppObservingNodeBurstEcho({
      page,
      harness,
      terminalName: "app-observe-node-burst",
    });
    await attachJson(testInfo, "app-observe-node-burst", appObserveNodeBurstReport);
    console.log(
      "[terminal-stress-app-observe-node-burst]",
      JSON.stringify(appObserveNodeBurstReport),
    );

    expect(appObserveNodeBurstReport.outputFramePayloadBytes).toBeGreaterThanOrEqual(
      INPUT_TEXT.length,
    );
    expect(appObserveNodeBurstReport.xtermWriteCount).toBeGreaterThan(0);

    const appSmallChunksReport = await measureAppBurstEcho({
      page,
      harness,
      terminalName: "app-keystroke-stress-small-agent-chunks",
      agentStreamUpdateCount: SMALL_AGENT_STREAM_UPDATES,
    });
    await attachJson(testInfo, "app-keystroke-stress-small-agent-chunks", appSmallChunksReport);
    console.log("[terminal-stress-app-small-agent-chunks]", JSON.stringify(appSmallChunksReport));

    expect(appSmallChunksReport.keydownCount).toBeGreaterThanOrEqual(INPUT_TEXT.length);
    expect(appSmallChunksReport.inputFramePayloadBytes).toBeGreaterThanOrEqual(INPUT_TEXT.length);
    expect(appSmallChunksReport.outputFramePayloadBytes).toBeGreaterThanOrEqual(INPUT_TEXT.length);
    expect(appSmallChunksReport.keydownToXtermCommitMs?.count ?? 0).toBeGreaterThan(0);
    expect(appSmallChunksReport.agentStreamTextMessageCount).toBeGreaterThanOrEqual(
      SMALL_AGENT_STREAM_UPDATES,
    );

    const appBigDiffReport = await measureAppBurstEcho({
      page,
      harness,
      terminalName: "app-keystroke-stress-big-diff",
      bigDiffBytes: BIG_DIFF_BYTES,
    });
    await attachJson(testInfo, "app-keystroke-stress-big-diff", appBigDiffReport);
    console.log("[terminal-stress-app-big-diff]", JSON.stringify(appBigDiffReport));

    expect(appBigDiffReport.keydownCount).toBeGreaterThanOrEqual(INPUT_TEXT.length);
    expect(appBigDiffReport.inputFramePayloadBytes).toBeGreaterThanOrEqual(INPUT_TEXT.length);
    expect(appBigDiffReport.outputFramePayloadBytes).toBeGreaterThanOrEqual(INPUT_TEXT.length);
    expect(appBigDiffReport.keydownToXtermCommitMs?.count ?? 0).toBeGreaterThan(0);
    expect(appBigDiffReport.largeAgentStreamTextMessageCount).toBeGreaterThanOrEqual(1);
    expect(appBigDiffReport.largestAgentStreamTextMessageBytes).toBeGreaterThanOrEqual(
      BIG_DIFF_BYTES,
    );
  });
});

async function measureAppBurstEcho(input: {
  page: Page;
  harness: TerminalE2EHarness;
  terminalName: string;
  bigDiffBytes?: number;
  agentStreamUpdateCount?: number;
}) {
  const appTerminal = await input.harness.createTerminal({ name: input.terminalName });
  try {
    await input.harness.openTerminal(input.page, { terminalId: appTerminal.id });
    await input.harness.setupPrompt(input.page);

    const agent =
      input.bigDiffBytes === undefined && input.agentStreamUpdateCount === undefined
        ? null
        : await input.harness.client.createAgent({
            provider: "mock",
            cwd: input.harness.tempRepo.path,
            title: "Large WebSocket payload",
            modeId: "load-test",
          });

    const bigDiffBytes = input.bigDiffBytes;
    const agentStreamUpdateCount = input.agentStreamUpdateCount;
    const startAgentLoad =
      agent === null
        ? null
        : () => {
            if (bigDiffBytes !== undefined) {
              return emitLargeDiffAgentPayload(input.harness, {
                agentId: agent.id,
                bytes: bigDiffBytes,
              });
            }
            if (agentStreamUpdateCount !== undefined) {
              return emitRapidAgentStreamUpdates(input.harness, {
                agentId: agent.id,
                count: agentStreamUpdateCount,
              });
            }
            return Promise.resolve();
          };

    const terminal = input.harness.terminalSurface(input.page);
    await terminal.press("Control+c");
    await input.page.waitForTimeout(200);
    await resetTerminalKeystrokeStressProbe(input.page);

    const activeAgentLoadPromise = startAgentLoad === null ? Promise.resolve() : startAgentLoad();

    await terminal.pressSequentially(INPUT_TEXT, { delay: 0 });
    await waitForAppStressEcho(input.page, INPUT_TEXT);
    await waitForAppProbePayload(input.page, INPUT_TEXT.length);
    if (input.bigDiffBytes !== undefined) {
      await waitForLargeAgentStreamMessage(input.page, input.bigDiffBytes);
    }
    if (input.agentStreamUpdateCount !== undefined) {
      await waitForAgentStreamMessages(input.page, input.agentStreamUpdateCount);
    }
    await activeAgentLoadPromise;

    return readTerminalKeystrokeStressReport(input.page, INPUT_TEXT);
  } finally {
    await input.harness.killTerminal(appTerminal.id);
  }
}

async function measureAppObservingNodeBurstEcho(input: {
  page: Page;
  harness: TerminalE2EHarness;
  terminalName: string;
}) {
  const appTerminal = await input.harness.createTerminal({ name: input.terminalName });
  try {
    await input.harness.openTerminal(input.page, { terminalId: appTerminal.id });
    await input.harness.setupPrompt(input.page);

    await resetTerminalKeystrokeStressProbe(input.page);

    for (const char of INPUT_TEXT) {
      input.harness.client.sendTerminalInput(appTerminal.id, {
        type: "input",
        data: char,
      });
    }

    await waitForAppStressEcho(input.page, INPUT_TEXT);
    await waitForAppProbePayload(input.page, INPUT_TEXT.length);

    return readTerminalKeystrokeStressReport(input.page, INPUT_TEXT);
  } finally {
    await input.harness.killTerminal(appTerminal.id);
  }
}

async function emitRapidAgentStreamUpdates(
  harness: TerminalE2EHarness,
  input: { agentId: string; count: number },
): Promise<void> {
  await harness.client.sendAgentMessage(input.agentId, `emit ${input.count} agent stream updates`);
}

async function emitLargeDiffAgentPayload(
  harness: TerminalE2EHarness,
  input: { agentId: string; bytes: number },
): Promise<void> {
  await harness.client.sendAgentMessage(
    input.agentId,
    `emit ${input.bytes} byte large diff agent stream update`,
  );
}

async function measureDaemonBurstEcho(
  harness: TerminalE2EHarness,
  terminal: TerminalInstance,
  inputText: string,
): Promise<DaemonEchoReport> {
  await harness.client.subscribeTerminal(terminal.id);

  const outputTimesByByte: number[] = [];
  let outputEventCount = 0;
  let echoedBytes = 0;
  const decoder = new TextDecoder();
  const unsubscribe = harness.client.onTerminalStreamEvent((event) => {
    if (event.terminalId !== terminal.id || event.type !== "output" || !event.data) {
      return;
    }
    outputEventCount += 1;
    const text = decoder.decode(event.data);
    const now = performance.now();
    const previousEchoedBytes = echoedBytes;
    echoedBytes += text.length;
    for (let index = previousEchoedBytes; index < echoedBytes; index += 1) {
      outputTimesByByte[index] = now;
    }
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    echoedBytes = 0;
    outputTimesByByte.length = 0;

    const sendTimes: number[] = [];
    for (const char of inputText) {
      sendTimes.push(performance.now());
      harness.client.sendTerminalInput(terminal.id, {
        type: "input",
        data: char,
      });
    }

    await waitForDaemonEchoBytes({
      getEchoedBytes: () => echoedBytes,
      expectedBytes: inputText.length,
      timeoutMs: STRESS_TIMEOUT_MS,
    });

    const latencies = sendTimes.map((sentAt, index) => outputTimesByByte[index] - sentAt);
    return {
      inputTextLength: inputText.length,
      inputFrameCount: sendTimes.length,
      outputEventCount,
      echoedBytes,
      sendToOutputMs: summarizeLatency(latencies),
      firstSendAt: sendTimes[0] ?? 0,
      lastOutputAt: outputTimesByByte[inputText.length - 1] ?? 0,
    };
  } finally {
    unsubscribe();
  }
}

async function waitForDaemonEchoBytes(input: {
  getEchoedBytes: () => number;
  expectedBytes: number;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (input.getEchoedBytes() >= input.expectedBytes) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for daemon echo bytes: ${input.getEchoedBytes()}/${input.expectedBytes}`,
  );
}

async function waitForAppStressEcho(page: Page, text: string): Promise<void> {
  const tail = text.slice(-80);
  await waitForTerminalContent(page, (content) => content.includes(tail), STRESS_TIMEOUT_MS);
}

async function waitForAppProbePayload(page: Page, expectedBytes: number): Promise<void> {
  const deadline = Date.now() + STRESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const report = await readTerminalKeystrokeStressReport(page, INPUT_TEXT);
    if (report.outputFramePayloadBytes >= expectedBytes) {
      return;
    }
    await page.waitForTimeout(25);
  }
}

async function waitForLargeAgentStreamMessage(page: Page, expectedBytes: number): Promise<void> {
  const deadline = Date.now() + STRESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const report = await readTerminalKeystrokeStressReport(page, INPUT_TEXT);
    if (report.largestAgentStreamTextMessageBytes >= expectedBytes) {
      return;
    }
    await page.waitForTimeout(25);
  }
  const report = await readTerminalKeystrokeStressReport(page, INPUT_TEXT);
  throw new Error(
    `Timed out waiting for large agent_stream message: largest=${report.largestAgentStreamTextMessageBytes}, expected=${expectedBytes}`,
  );
}

async function waitForAgentStreamMessages(page: Page, expectedCount: number): Promise<void> {
  const deadline = Date.now() + STRESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const report = await readTerminalKeystrokeStressReport(page, INPUT_TEXT);
    if (report.agentStreamTextMessageCount >= expectedCount) {
      return;
    }
    await page.waitForTimeout(25);
  }
  const report = await readTerminalKeystrokeStressReport(page, INPUT_TEXT);
  throw new Error(
    `Timed out waiting for agent_stream messages: count=${report.agentStreamTextMessageCount}, expected=${expectedCount}`,
  );
}

async function attachJson(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  await testInfo.attach(name, {
    body: JSON.stringify(value, null, 2),
    contentType: "application/json",
  });
}

function buildStressText(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let output = "";
  while (output.length < length) {
    output += alphabet;
  }
  return output.slice(0, length);
}

function summarizeLatency(values: number[]): LatencyStats {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? 0;
  };
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    minMs: round2(sorted[0] ?? 0),
    p50Ms: round2(percentile(50)),
    p95Ms: round2(percentile(95)),
    maxMs: round2(sorted[sorted.length - 1] ?? 0),
    avgMs: round2(total / values.length),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
