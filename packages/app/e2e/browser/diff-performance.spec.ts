import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { CDPSession } from "@playwright/test";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";
import { test, expect } from "../support/fixtures";
import { getServerId } from "../support/helpers/server-id";
import { connectSeedClient } from "../support/helpers/seed-client";
import { createTempGitRepo } from "../support/helpers/workspace";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

const RUN_DIFF_PERF = process.env.PASEO_DIFF_PERF_E2E === "1";
const diffPerfDescribe = RUN_DIFF_PERF ? test.describe : test.describe.skip;
const LINE_COUNT = 2_400;
const CPU_SLOWDOWN = Number(process.env.PASEO_DIFF_PERF_CPU_SLOWDOWN ?? 6);
const MAX_MOUNTED_CODE_ROWS = 220;
const MAX_EXPANSION_MS = 6_000;
const CHANGES_PREFERENCES_KEY = "@paseo:changes-preferences";

diffPerfDescribe("Diff rendering performance", () => {
  test("large unwrapped diffs keep mounting bounded under CPU slowdown", async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const repo = await createTempGitRepo("diff-perf-", {
      files: [{ path: "src/large.ts", content: "export const baseline = 0;\n" }],
    });
    const client = await connectSeedClient();
    let cdp: CDPSession | null = null;

    try {
      const generatedLines = Array.from(
        { length: LINE_COUNT },
        (_, index) => `export const generated_${index} = "${index}-${"wide".repeat(16)}";`,
      ).join("\n");
      await writeFile(
        path.join(repo.path, "src/large.ts"),
        `export const baseline = 1;\n${generatedLines}\n`,
      );
      const created = await client.createWorkspace({
        source: { kind: "directory", path: repo.path },
      });
      if (!created.workspace) {
        throw new Error(created.error ?? "Failed to create diff performance workspace");
      }

      await page.addInitScript(
        ({ preferencesKey }) => {
          localStorage.setItem(
            preferencesKey,
            JSON.stringify({
              layout: "unified",
              viewMode: "flat",
              wrapLines: false,
              hideWhitespace: false,
            }),
          );
        },
        { preferencesKey: CHANGES_PREFERENCES_KEY },
      );
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(buildHostWorkspaceRoute(getServerId(), created.workspace.id));
      await waitForWorkspaceTabsVisible(page);
      await page.getByRole("button", { name: "Open explorer" }).click();
      const fileHeader = page.getByTestId("diff-file-0");
      await expect(fileHeader).toContainText("large.ts", { timeout: 30_000 });

      cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
      const expansionStart = await page.evaluate(() => performance.now());
      await fileHeader.click();
      await expect(page.getByTestId("diff-file-0-body")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("diff-code-row-0")).toBeVisible({ timeout: 30_000 });
      const expansionMs = (await page.evaluate(() => performance.now())) - expansionStart;

      const scroll = page.getByTestId("git-diff-scroll");
      const initial = await readDiffMountReport(page);
      expect(initial.mountedCodeRows).toBeLessThanOrEqual(MAX_MOUNTED_CODE_ROWS);
      expect(initial.mountedGutterRows).toBe(initial.mountedCodeRows);

      await page.getByTestId("diff-gutter-row-1").hover();
      await page.getByTestId("diff-gutter-action-1").click();
      await expect(page.getByTestId("inline-review-editor")).toBeVisible();
      const withEditor = await readDiffMountReport(page);
      expect(withEditor.mountedCodeRows).toBeLessThanOrEqual(MAX_MOUNTED_CODE_ROWS);
      expect(withEditor.mountedGutterRows).toBe(withEditor.mountedCodeRows);
      expect(await readDiffRowAlignment(page, 2)).toBeCloseTo(0, 0);
      await expect(page.getByTestId("inline-review-editor-input")).toBeFocused();
      await page.getByTestId("inline-review-editor-cancel").click();
      await expect(page.getByTestId("inline-review-editor")).toHaveCount(0);

      await scroll.evaluate((element) => {
        element.scrollTop = element.scrollHeight - element.clientHeight;
        element.dispatchEvent(new Event("scroll", { bubbles: false }));
      });
      await expect
        .poll(async () => (await readDiffMountReport(page)).highestMountedRow)
        .toBeGreaterThan(LINE_COUNT - 100);
      const afterScroll = await readDiffMountReport(page);
      expect(afterScroll.mountedCodeRows).toBeLessThanOrEqual(MAX_MOUNTED_CODE_ROWS);
      expect(afterScroll.mountedGutterRows).toBe(afterScroll.mountedCodeRows);

      const report = {
        cpuSlowdown: CPU_SLOWDOWN,
        sourceLines: LINE_COUNT,
        expansionMs: Math.round(expansionMs),
        initial,
        withEditor,
        afterScroll,
      };
      await testInfo.attach("diff-performance", {
        body: JSON.stringify(report, null, 2),
        contentType: "application/json",
      });
      console.log(`[perf] Diff rendering: ${JSON.stringify(report)}`);
      expect(expansionMs).toBeLessThan(MAX_EXPANSION_MS);

      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      await scroll.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event("scroll", { bubbles: false }));
      });
      await page.getByTestId("changes-toggle-layout").click();
      const oldLine = page.getByText("export const baseline = 0;", { exact: true });
      const newLine = page.getByText("export const baseline = 1;", { exact: true });
      await expect(oldLine).toBeVisible();
      await expect(newLine).toBeVisible();
      const [bodyBox, oldBox, newBox] = await Promise.all([
        page.getByTestId("diff-file-0-body").boundingBox(),
        oldLine.boundingBox(),
        newLine.boundingBox(),
      ]);
      expect(bodyBox).not.toBeNull();
      expect(oldBox).not.toBeNull();
      expect(newBox).not.toBeNull();
      expect(oldBox!.x).toBeLessThan(newBox!.x);
      expect(oldBox!.x).toBeGreaterThanOrEqual(bodyBox!.x);
      expect(newBox!.x).toBeGreaterThan(bodyBox!.x + bodyBox!.width / 2);
      expect(newBox!.x).toBeLessThan(bodyBox!.x + bodyBox!.width);
    } finally {
      await cdp?.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => undefined);
      await cdp?.detach().catch(() => undefined);
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    }
  });
});

async function readDiffRowAlignment(
  page: import("@playwright/test").Page,
  rowIndex: number,
): Promise<number> {
  const gutterTop = await page
    .getByTestId(`diff-gutter-row-${rowIndex}`)
    .evaluate((row) => row.getBoundingClientRect().top);
  const codeTop = await page
    .getByTestId(`diff-code-row-${rowIndex}`)
    .evaluate((row) => row.getBoundingClientRect().top);
  return gutterTop - codeTop;
}

async function readDiffMountReport(page: import("@playwright/test").Page): Promise<{
  mountedCodeRows: number;
  mountedGutterRows: number;
  highestMountedRow: number;
  bodyDomElements: number;
}> {
  return page.getByTestId("diff-file-0-body").evaluate((body) => {
    const codeRows = Array.from(
      body.querySelectorAll<HTMLElement>('[data-testid^="diff-code-row-"]'),
    );
    const gutterRows = body.querySelectorAll('[data-testid^="diff-gutter-row-"]');
    return {
      mountedCodeRows: codeRows.length,
      mountedGutterRows: gutterRows.length,
      highestMountedRow: Math.max(
        -1,
        ...codeRows.map((row) =>
          Number((row.getAttribute("data-testid") ?? "").slice("diff-code-row-".length)),
        ),
      ),
      bodyDomElements: body.querySelectorAll("*").length,
    };
  });
}
