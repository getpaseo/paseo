import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { TerminalE2EHarness, withTerminalInApp } from "./helpers/terminal-dsl";
import {
  installTerminalRenderProbe,
  readTerminalRenderProbe,
  resetTerminalRenderProbe,
  startTerminalFrameSampling,
  summarizeTerminalRenderProbe,
} from "./helpers/terminal-probes";
import { getTerminalBufferText, waitForTerminalContent } from "./helpers/terminal-perf";

async function waitForAlternateScreenExit(page: Page, afterAlt: string, timeout: number) {
  let lastBufferText = "";
  let lastProbe = await readTerminalRenderProbe(page);

  try {
    await expect
      .poll(
        async () => {
          lastBufferText = await getTerminalBufferText(page);
          lastProbe = await readTerminalRenderProbe(page);
          return (
            lastProbe.altEnterWrites > 0 &&
            lastProbe.altExitWrites > 0 &&
            lastBufferText.includes(afterAlt)
          );
        },
        {
          intervals: [50],
          message: `wait for alternate-screen exit and ${afterAlt} output`,
          timeout,
        },
      )
      .toBe(true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Timed out waiting for alternate-screen exit: ${message}\n${JSON.stringify(
        {
          afterAlt,
          probe: summarizeTerminalRenderProbe(lastProbe),
          bufferTextTail: lastBufferText.slice(-500),
        },
        null,
        2,
      )}`,
    );
  }

  return lastProbe;
}

test.describe("Terminal alternate-screen transitions", () => {
  let harness: TerminalE2EHarness;

  test.beforeAll(async () => {
    harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-alt-" });
  });

  test.afterAll(async () => {
    await harness?.cleanup();
  });

  test("restores the normal screen after full-screen alternate buffer exit without remounting", async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);

    await installTerminalRenderProbe(page);

    await withTerminalInApp(page, harness, { name: "alternate-screen" }, async () => {
      await harness.setupPrompt(page);

      const terminal = harness.terminalSurface(page);
      const historyReady = `HISTORY_READY_${Date.now()}`;
      await terminal.pressSequentially(
        `for i in $(seq 1 80); do echo HISTORY_$i; done; echo ${historyReady}\n`,
        { delay: 0 },
      );
      await waitForTerminalContent(page, (text) => text.includes(historyReady), 10_000);

      await resetTerminalRenderProbe(page);
      await page.waitForTimeout(500);
      const settledProbe = await readTerminalRenderProbe(page);
      expect(settledProbe.resetWrites, "terminal should be idle before alternate-screen act").toBe(
        0,
      );
      await resetTerminalRenderProbe(page);

      const afterAlt = `AFTER_ALT_${Date.now()}`;
      await startTerminalFrameSampling(page);
      await terminal.pressSequentially(
        `printf '\\033[?1049h\\033[2J\\033[HALT_SCREEN_TOP\\n'; sleep 0.25; printf '\\033[?1049l'; echo ${afterAlt}\n`,
        { delay: 0 },
      );
      const probe = await waitForAlternateScreenExit(page, afterAlt, 10_000);
      const probeSummary = summarizeTerminalRenderProbe(probe);

      await testInfo.attach("alternate-screen-probe", {
        body: JSON.stringify({ summary: probeSummary, probe }, null, 2),
        contentType: "application/json",
      });

      expect(probe.setCount, "terminal instance should not be replaced after attach").toBe(0);
      expect(probe.unsetCount, "terminal instance should not be unset after attach").toBe(0);
      expect(
        probe.altEnterWrites,
        "test command should enter the alternate screen",
      ).toBeGreaterThan(0);
      expect(probe.altExitWrites, "test command should exit the alternate screen").toBeGreaterThan(
        0,
      );
      expect(probe.resetWrites, "alternate-screen exit should not replay a snapshot reset").toBe(0);

      const finalBufferText = await getTerminalBufferText(page);
      expect(finalBufferText).toContain(historyReady);
      expect(finalBufferText).toContain(afterAlt);

      const suspiciousFrames = probe.frames.filter(
        (frame) =>
          frame.text.includes("$") &&
          !frame.text.includes(historyReady) &&
          !frame.text.includes(afterAlt) &&
          frame.nonEmptyRows <= 2 &&
          (frame.firstNonEmptyRow ?? Number.POSITIVE_INFINITY) <= 1,
      );

      expect(
        suspiciousFrames,
        "normal-screen restore should not flash to a mostly blank prompt-at-top frame",
      ).toEqual([]);
    });
  });
});
