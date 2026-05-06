import { expect, type Page } from "@playwright/test";
import { readScrollMetrics, waitForContentGrowth, expectNearBottom } from "./agent-bottom-anchor";

export async function awaitAssistantMessage(page: Page, hasText?: string | RegExp): Promise<void> {
  const messages = page.getByTestId("assistant-message");
  const target = hasText === undefined ? messages.first() : messages.filter({ hasText }).first();
  await expect(target).toBeVisible({ timeout: 30_000 });
}

export async function awaitToolCall(page: Page, toolName: string | RegExp): Promise<void> {
  await expect(
    page.getByTestId("tool-call-badge").filter({ hasText: toolName }).first(),
  ).toBeVisible({ timeout: 30_000 });
}

export async function expectAgentIdle(page: Page, timeout = 30_000): Promise<void> {
  await expect(page.getByRole("button", { name: /stop|cancel/i })).toHaveCount(0, { timeout });
}

// The working indicator is an animated spinner View — no semantic ARIA role, testId is correct.
export async function expectInlineWorkingIndicator(page: Page): Promise<void> {
  await expect(page.getByTestId("turn-working-indicator")).toBeVisible({ timeout: 30_000 });
}

export async function expectTurnCopyButton(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Copy turn" }).first()).toBeVisible({
    timeout: 30_000,
  });
}

export async function expectScrollFollowsNewContent(page: Page): Promise<void> {
  const { contentHeight } = await readScrollMetrics(page);
  await waitForContentGrowth(page, contentHeight);
  await expectNearBottom(page);
}
