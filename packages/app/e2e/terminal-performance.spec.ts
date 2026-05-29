import { test, expect } from "./fixtures";
import { TerminalE2EHarness } from "./helpers/terminal-dsl";
import {
  waitForTerminalContent,
  measureKeystrokeLatency,
  computePercentile,
  round2,
  type LatencySample,
} from "./helpers/terminal-perf";

const LINE_COUNT = 50_000;
const THROUGHPUT_BUDGET_MS = 30_000;
const KEYSTROKE_SAMPLE_COUNT = 20;
const KEYSTROKE_P95_BUDGET_MS = 150;
const RUN_MANUAL_TERMINAL_PERF = process.env.PASEO_TERMINAL_PERF_E2E === "1";
const terminalPerfDescribe = RUN_MANUAL_TERMINAL_PERF ? test.describe : test.describe.skip;

terminalPerfDescribe("Terminal wire performance", () => {
  let harness: TerminalE2EHarness;

  test.beforeAll(async () => {
    harness = await TerminalE2EHarness.create({ tempPrefix: "perf-" });
  });

  test.afterAll(async () => {
    await harness?.cleanup();
  });

  test("throughput: bulk terminal output renders within budget", async ({ page }, testInfo) => {
    test.setTimeout(90_000);

    const created = await harness.createTerminal({ name: "throughput" });
    try {
      await harness.openTerminal(page, { terminalId: created.id });
      await harness.setupPrompt(page);

      const sentinel = `PERF_DONE_${Date.now()}`;
      const terminal = harness.terminalSurface(page);
      const startMs = Date.now();

      await terminal.pressSequentially(`seq 1 ${LINE_COUNT}; echo ${sentinel}\n`, { delay: 0 });

      await waitForTerminalContent(
        page,
        (text) => text.includes(sentinel),
        THROUGHPUT_BUDGET_MS + 15_000,
      );

      const elapsedMs = Date.now() - startMs;

      // seq 1 N outputs each number on its own line
      const estimatedBytes = Array.from(
        { length: LINE_COUNT },
        (_, i) => String(i + 1).length + 1,
      ).reduce((a, b) => a + b, 0);
      const throughputMBps = estimatedBytes / (1024 * 1024) / (elapsedMs / 1000);

      const report = {
        lineCount: LINE_COUNT,
        estimatedBytes,
        elapsedMs,
        throughputMBps: round2(throughputMBps),
      };

      await testInfo.attach("throughput-report", {
        body: JSON.stringify(report, null, 2),
        contentType: "application/json",
      });

      console.log(
        `[perf] Throughput: ${report.throughputMBps} MB/s — ${LINE_COUNT} lines in ${elapsedMs}ms`,
      );

      expect(
        elapsedMs,
        `${LINE_COUNT} lines should render within ${THROUGHPUT_BUDGET_MS}ms`,
      ).toBeLessThan(THROUGHPUT_BUDGET_MS);
    } finally {
      await harness.killTerminal(created.id);
    }
  });

  test("keystroke latency: echo round-trip under budget", async ({ page }, testInfo) => {
    test.setTimeout(60_000);

    const created = await harness.createTerminal({ name: "latency" });
    try {
      await harness.openTerminal(page, { terminalId: created.id });
      await harness.setupPrompt(page);

      // Ensure clean prompt state
      const terminal = harness.terminalSurface(page);
      await terminal.press("Control+c");
      await page.waitForTimeout(200);

      const samples: LatencySample[] = [];
      const chars = "abcdefghijklmnopqrst";

      for (let i = 0; i < KEYSTROKE_SAMPLE_COUNT; i++) {
        const char = chars[i % chars.length];
        const latencyMs = await measureKeystrokeLatency(page, char);
        samples.push({ char, latencyMs });
        await page.waitForTimeout(50);
      }

      // Clean up typed characters
      await terminal.press("Control+c");

      const latencies = samples.map((s) => s.latencyMs);
      const p50 = computePercentile(latencies, 50);
      const p95 = computePercentile(latencies, 95);
      const max = Math.max(...latencies);
      const min = Math.min(...latencies);
      const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;

      const report = {
        sampleCount: KEYSTROKE_SAMPLE_COUNT,
        p50Ms: round2(p50),
        p95Ms: round2(p95),
        maxMs: round2(max),
        minMs: round2(min),
        avgMs: round2(avg),
        samples: samples.map((s) => ({
          char: s.char,
          latencyMs: round2(s.latencyMs),
        })),
      };

      await testInfo.attach("latency-report", {
        body: JSON.stringify(report, null, 2),
        contentType: "application/json",
      });

      console.log(
        `[perf] Keystroke latency — p50: ${report.p50Ms}ms, p95: ${report.p95Ms}ms, max: ${report.maxMs}ms`,
      );

      expect(
        p95,
        `Keystroke p95 latency should be under ${KEYSTROKE_P95_BUDGET_MS}ms`,
      ).toBeLessThan(KEYSTROKE_P95_BUDGET_MS);
    } finally {
      await harness.killTerminal(created.id);
    }
  });
});
