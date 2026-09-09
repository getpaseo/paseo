import { test, expect } from "../support/fixtures";
import { awaitAssistantMessage } from "../support/helpers/agent-stream";
import { startRunningMockAgent } from "../support/helpers/composer";
import {
  sampleStreamFrames,
  summarizeStreamSmoothness,
} from "../support/helpers/stream-smoothness";

/**
 * Streaming smoothness, measured on the path the user actually sees.
 *
 * The mock provider's "bursty-stream" model emits tokens in uneven runs separated
 * by idle gaps, which is how real models arrive. Sampling and the statistics live
 * in ../support/helpers/stream-smoothness.ts, which also documents what the two
 * numbers mean.
 *
 * Budgets are deliberately loose. This spec exists to catch a regression in the
 * shape of the stream, not to pin exact numbers on shared CI hardware. For
 * reference, on a local dev daemon the paced reveal measures a CV around 1.3–1.5
 * against 2.7 when painting deltas as they arrive.
 */

const SAMPLE_WINDOW_MS = 6_000;
const CHARS_PER_FRAME_CV_BUDGET = 2;
const UPDATE_GAP_P95_BUDGET_MS = 250;
const REACT_COMMIT_P95_BUDGET_MS = 12;
const REACT_COMMIT_COUNT_BUDGET = 600;
const RUN_AGENT_STREAM_PERF = process.env.PASEO_AGENT_STREAM_PERF_E2E === "1";
const agentStreamPerfDescribe = RUN_AGENT_STREAM_PERF ? test.describe : test.describe.skip;

interface ReactCommit {
  id: string;
  phase: "mount" | "update" | "nested-update";
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
}

agentStreamPerfDescribe("Agent stream smoothness", () => {
  test("reveals bursty model output at a steady rate", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => {
      Reflect.set(globalThis, "__PASEO_RENDER_PROFILE_ENABLED__", true);
    });

    const agent = await startRunningMockAgent(page, {
      prefix: "stream-smoothness-",
      model: "bursty-stream",
      prompt: "Stream bursty output for smoothness measurement.",
    });
    try {
      await awaitAssistantMessage(page);
      await page.evaluate(() => {
        const reset = Reflect.get(globalThis, "__PASEO_RESET_RENDER_PROFILE__");
        if (typeof reset !== "function") {
          throw new Error("Render profiler did not initialize");
        }
        reset();
      });

      const samples = await sampleStreamFrames(page, { sampleWindowMs: SAMPLE_WINDOW_MS });
      const report = summarizeStreamSmoothness(samples, SAMPLE_WINDOW_MS);
      const reactCommits = await readStreamReactCommits(page);
      const reactReport = summarizeReactCommits(reactCommits);

      await testInfo.attach("agent-stream-smoothness-report", {
        body: JSON.stringify(report, null, 2),
        contentType: "application/json",
      });
      await testInfo.attach("agent-stream-react-profile", {
        body: JSON.stringify(reactReport, null, 2),
        contentType: "application/json",
      });
      console.log(`[perf] Agent stream React: ${JSON.stringify(reactReport)}`);
      console.log(`[perf] Agent stream smoothness: ${JSON.stringify(report)}`);

      expect(
        report.growthFrames,
        "the stream must actually produce text during the sample window",
      ).toBeGreaterThan(20);
      expect(
        report.charsPerFrameCv,
        `characters painted per frame should be steady (cv < ${CHARS_PER_FRAME_CV_BUDGET})`,
      ).toBeLessThan(CHARS_PER_FRAME_CV_BUDGET);
      expect(
        report.updateGapP95Ms,
        `the text should not stall (p95 gap < ${UPDATE_GAP_P95_BUDGET_MS}ms)`,
      ).toBeLessThan(UPDATE_GAP_P95_BUDGET_MS);
      expect(reactReport.count, "streaming should produce measured React commits").toBeGreaterThan(
        20,
      );
      expect(
        reactReport.count,
        `the reveal should cap commits below ${REACT_COMMIT_COUNT_BUDGET} per sample window`,
      ).toBeLessThan(REACT_COMMIT_COUNT_BUDGET);
      expect(
        reactReport.actualDurationP95Ms,
        `React commits should stay below ${REACT_COMMIT_P95_BUDGET_MS}ms at p95`,
      ).toBeLessThan(REACT_COMMIT_P95_BUDGET_MS);
    } finally {
      await agent.cleanup();
    }
  });
});

async function readStreamReactCommits(
  page: Parameters<typeof sampleStreamFrames>[0],
): Promise<ReactCommit[]> {
  return await page.evaluate(() => {
    const samples = Reflect.get(globalThis, "__PASEO_RENDER_PROFILE__");
    if (!Array.isArray(samples)) {
      return [];
    }
    return samples.filter(
      (sample): sample is ReactCommit =>
        typeof sample === "object" &&
        sample !== null &&
        typeof Reflect.get(sample, "id") === "string" &&
        Reflect.get(sample, "id").startsWith("AgentStreamSection:"),
    );
  });
}

function summarizeReactCommits(commits: readonly ReactCommit[]) {
  const durations = commits
    .map((commit) => commit.actualDuration)
    .sort((left, right) => left - right);
  const total = durations.reduce((sum, duration) => sum + duration, 0);
  return {
    count: commits.length,
    actualDurationTotalMs: round2(total),
    actualDurationMeanMs: round2(commits.length > 0 ? total / commits.length : 0),
    actualDurationP50Ms: percentile(durations, 50),
    actualDurationP95Ms: percentile(durations, 95),
    actualDurationMaxMs: durations.at(-1) ?? 0,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentile(sorted: readonly number[], percentileValue: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  return sorted[
    Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * (percentileValue / 100)))
  ];
}
