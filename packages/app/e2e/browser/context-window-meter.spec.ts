import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { UsageReportEntry } from "@getpaseo/protocol/messages";
import { expect, test } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  installUsageReportsFixture,
  type UsageListResponse,
} from "../support/helpers/usage-reports";
import { claudeAndCodexReports, expectUnpinnableRows } from "../support/helpers/usage-sidebar-item";

// Where the progress arc is painted, as its centroid relative to the ring's centre in pixels.
// Reads the rendered pixels, so any rotation that does not reach the screen counts as none.
async function progressArcCentroid(meter: Locator): Promise<{ x: number; y: number }> {
  const ring = meter.locator("svg");
  const progressColor = await ring
    .locator("circle")
    .last()
    .evaluate((circle) => getComputedStyle(circle).stroke);
  const screenshot = await ring.screenshot();
  return ring.evaluate(
    async (_svg, { png, color }) => {
      const image = await createImageBitmap(
        await (await fetch(`data:image/png;base64,${png}`)).blob(),
      );
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);
      const [r, g, b] = color.match(/\d+/g)!.map(Number);
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
          const i = (y * image.width + x) * 4;
          const distance =
            Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b);
          if (distance < 40) {
            sumX += x;
            sumY += y;
            count += 1;
          }
        }
      }
      if (count === 0) {
        throw new Error(`No pixels painted in the progress colour ${color}`);
      }
      return { x: sumX / count - image.width / 2, y: sumY / count - image.height / 2 };
    },
    { png: screenshot.toString("base64"), color: progressColor },
  );
}

test.describe("context window meter", () => {
  test("draws usage clockwise from twelve o'clock", async ({ page }) => {
    test.setTimeout(180_000);
    // 32,000 of the mock's 128,000-token window: a quarter, from twelve to three o'clock.
    const session = await seedMockAgentWorkspace({
      repoPrefix: "context-window-meter-",
      title: "Context window meter e2e",
      initialPrompt: "emit 32000 byte file agent stream payload",
    });
    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      const meter = page.getByTestId("context-window-meter");
      await expect(meter).toHaveAccessibleName(/25%/, { timeout: 30_000 });

      const centroid = await progressArcCentroid(meter);
      expect(centroid.x).toBeGreaterThan(1);
      expect(centroid.y).toBeLessThan(-1);
    } finally {
      await session.cleanup();
    }
  });
});

/** A report on the agent's own login, which is not the host's default one. */
function onWorkLogin(report: UsageReportEntry): UsageReportEntry {
  return {
    ...report,
    id: `${report.sourceId}:work`,
    account: { label: "work@example.com" },
  };
}

function expiredLogin(report: UsageReportEntry): UsageReportEntry {
  return {
    ...report,
    report: {
      status: "unavailable",
      problem: {
        kind: "expired",
        expiresAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
        refreshedBy: "claude",
      },
    },
  };
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Set PASEO_QA_SCREENSHOT_DIR to keep a QA screenshot. */
async function qaScreenshot(page: Page, name: string) {
  const directory = process.env.PASEO_QA_SCREENSHOT_DIR;
  if (!directory) return;
  await page.waitForTimeout(600);
  await page.addStyleTag({ content: ".__expo_fast_refresh { display: none !important; }" });
  await page.screenshot({ path: path.join(directory, `${name}.png`) });
}

const LAYOUTS = {
  desktop: { width: 1440, height: 900 },
  compact: { width: 390, height: 844 },
};

for (const theme of ["light", "dark"] as const) {
  for (const [layout, viewport] of Object.entries(LAYOUTS)) {
    // Wide screens show the details in a tooltip; compact ones in a sheet, which can hold Refresh.
    const surfaceName = layout === "compact" ? "sheet" : "popover";
    test(`context window ${surfaceName} shows the agent's usage (${layout} ${theme})`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      const [claude, codex] = claudeAndCodexReports();
      const session = await seedMockAgentWorkspace({
        repoPrefix: "context-window-usage-",
        title: "Context window usage e2e",
        initialPrompt: "emit 32000 byte file agent stream payload",
      });
      let supported = true;
      // Each open sends one agent request, and each Refresh one report request; each step
      // scripts its answer.
      const agentReports: UsageListResponse[] = [];
      const usage = await installUsageReportsFixture(page, {
        usageSupported: () => supported,
        lists: [
          (request) => {
            if (!request.agentId && !request.reportIds) return claudeAndCodexReports();
            const next = agentReports.shift();
            if (!next) throw new Error("The test scripts every agent usage request.");
            return next;
          },
        ],
      });
      await page.addInitScript((value) => {
        const key = "@paseo:app-settings";
        const current = JSON.parse(localStorage.getItem(key) ?? "{}");
        localStorage.setItem(key, JSON.stringify({ ...current, theme: value }));
      }, theme);
      await page.setViewportSize(viewport);
      const meter = page.locator('[data-testid="context-window-meter"]:visible').first();
      const popover = page.getByTestId(
        layout === "compact" ? "context-window-sheet" : "context-window-meter-tooltip",
      );
      const message = popover.getByTestId("agent-usage-message");
      const openPopover = async () => {
        await expect(meter).toHaveAccessibleName(/25%/, { timeout: 30_000 });
        if (layout === "compact") await meter.click();
        else await meter.hover();
        await expect(popover.getByText("Context window", { exact: true })).toBeVisible();
      };
      const shot = (state: string) =>
        qaScreenshot(page, `${surfaceName}-${layout}-${theme}-${state}`);
      const reopen = async () => {
        await page.reload({ waitUntil: "commit" });
        await expectComposerVisible(page);
        await openPopover();
      };

      try {
        await openAgentRoute(page, session);
        await expectComposerVisible(page);

        await test.step("reports stream in one card at a time, on the agent's login only", async () => {
          const first = gate();
          const second = gate();
          agentReports.push({
            stream: [first.promise, onWorkLogin(claude!), second.promise, onWorkLogin(codex!)],
          });
          await openPopover();
          await expect(message).toHaveText("Loading usage...");
          await shot("loading");

          first.open();
          const claudeCard = popover.getByTestId("usage-report-claude:work");
          await expect(claudeCard.getByText("work@example.com", { exact: true })).toBeVisible();
          await expect(message).toHaveCount(0);
          await expect(popover.getByTestId("usage-report-codex:work")).toHaveCount(0);
          await shot("streaming");

          second.open();
          await expect(
            popover.getByTestId("usage-report-codex:work").getByText("Session", { exact: true }),
          ).toBeVisible();
          await expect(popover.getByText("dev@example.com", { exact: true })).toHaveCount(0);
          await expectUnpinnableRows(popover);
          await expect(popover.getByTestId("usage-freshness")).toHaveCount(2);
          // Only the sheet can be pressed, so only it has Refresh.
          await expect(popover.getByTestId("usage-refresh")).toHaveCount(
            layout === "compact" ? 2 : 0,
          );
          await shot("ready");
          expect(
            usage
              .listRequests()
              .filter((request) => request.agentId)
              .map((request) => request.agentId),
          ).toEqual([session.agentId]);
        });

        if (layout === "compact") {
          await test.step("Refresh in the sheet replaces the card, and the sheet closes", async () => {
            agentReports.push([expiredLogin(onWorkLogin(claude!))]);
            await popover
              .getByTestId("usage-report-claude:work")
              .getByTestId("usage-refresh")
              .click();
            await expect(
              popover.getByText(/^Login expired .*Run claude to refresh it\.$/),
            ).toBeVisible();
            expect(usage.listRequests().at(-1)).toMatchObject({
              forceRefresh: true,
              reportIds: ["claude:work"],
            });

            await popover.getByRole("button", { name: "Close", exact: true }).click();
            await expect(popover).toHaveCount(0);
          });
        }

        await test.step("a report with a problem shows it on the card", async () => {
          agentReports.push([expiredLogin(onWorkLogin(claude!))]);
          await reopen();
          await expect(
            popover.getByText(/^Login expired .*Run claude to refresh it\.$/),
          ).toBeVisible();
          await shot("problem");
        });

        await test.step("a failed request says so in a sentence", async () => {
          agentReports.push({ error: "Unknown agent" });
          await reopen();
          await expect(message).toHaveText("Unable to load usage: Unknown agent");
          await shot("error");
        });

        await test.step("a host without usage reports shows only the context window", async () => {
          supported = false;
          await reopen();
          await expect(popover.getByText(/% used/)).toBeVisible();
          await expect(message).toHaveCount(0);
          await expect(popover.locator('[data-testid^="usage-report-"]')).toHaveCount(0);
          // The three earlier opens; this one sends none.
          expect(usage.listRequests().filter((request) => request.agentId)).toHaveLength(3);
          await shot("unsupported");
        });
      } finally {
        await session.cleanup();
      }
    });
  }
}
