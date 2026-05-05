import { expect, type Page } from "@playwright/test";

export async function openPrPane(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open explorer" }).first().click();
  await expect(page.getByTestId("explorer-tab-pr")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("explorer-tab-pr").click();
  await expect(page.getByTestId("pr-pane")).toBeVisible({ timeout: 15_000 });
}

export async function expectPrPaneTitle(page: Page, title: string): Promise<void> {
  await expect(page.getByTestId("pr-pane-title")).toContainText(title, { timeout: 15_000 });
}

const STATE_LABELS: Record<string, string> = {
  open: "Open",
  merged: "Merged",
  closed: "Closed",
  draft: "Draft",
};

export async function expectPrPaneState(
  page: Page,
  state: "open" | "merged" | "closed" | "draft",
): Promise<void> {
  await expect(page.getByTestId("pr-pane-state")).toHaveText(STATE_LABELS[state], {
    timeout: 15_000,
  });
}

export async function expectPrPaneCheckSummary(
  page: Page,
  counts: { passed: number; failed: number; pending: number },
): Promise<void> {
  if (counts.passed > 0) {
    await expect(page.getByTestId("pr-pane-check-passed")).toContainText(String(counts.passed), {
      timeout: 15_000,
    });
  } else {
    await expect(page.getByTestId("pr-pane-check-passed")).toHaveCount(0);
  }
  if (counts.failed > 0) {
    await expect(page.getByTestId("pr-pane-check-failed")).toContainText(String(counts.failed), {
      timeout: 15_000,
    });
  } else {
    await expect(page.getByTestId("pr-pane-check-failed")).toHaveCount(0);
  }
  if (counts.pending > 0) {
    await expect(page.getByTestId("pr-pane-check-pending")).toContainText(String(counts.pending), {
      timeout: 15_000,
    });
  } else {
    await expect(page.getByTestId("pr-pane-check-pending")).toHaveCount(0);
  }
}

export async function expectPrPaneActivityCount(page: Page, count: number): Promise<void> {
  await expect(page.getByTestId("pr-pane-activity-row")).toHaveCount(count, { timeout: 15_000 });
}
