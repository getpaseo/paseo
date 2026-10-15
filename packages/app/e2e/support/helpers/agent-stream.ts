import { expect, type Page } from "@playwright/test";
import { readScrollMetrics, waitForContentGrowth, expectNearBottom } from "./agent-bottom-anchor";

/** Open completed steps before inspecting their messages or tool controls. */
export async function expandCompletedResponses(page: Page): Promise<void> {
  const collapsed = page
    .locator('[data-testid="agent-chat-scroll"]:visible')
    .first()
    .locator('[data-testid="response-fold-toggle"][aria-expanded="false"]:visible');
  for (let count = 0; count < 50 && (await collapsed.count()) > 0; count++) {
    const toggle = await collapsed.first().elementHandle();
    if (!toggle) continue;
    // This is setup for inspecting history. Virtualizer anchoring can move the
    // header between pointer down and up; the folding spec covers pointer clicks.
    await toggle.evaluate((node) => (node as HTMLElement).click());
    await expect
      .poll(() =>
        toggle.evaluate(
          (node) => !node.isConnected || node.getAttribute("aria-expanded") === "true",
        ),
      )
      .toBe(true);
    await toggle.dispose();
  }
  await expect(collapsed).toHaveCount(0);
}

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

export async function expectRunningAgentChrome(page: Page, title: string): Promise<void> {
  const tab = page.getByRole("button", { name: title, exact: true });

  await expect(tab).toBeVisible({ timeout: 30_000 });
  await expect(tab.getByRole("progressbar", { name: "Agent running" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: /stop agent|canceling agent/i })).toBeVisible({
    timeout: 30_000,
  });
  await expectInlineWorkingIndicator(page);
}

export async function expectAgentReadyToInterrupt(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Stop agent", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Canceling agent", exact: true })).toHaveCount(0);
}

export async function expectVisibleAgentSurfacesIdle(page: Page): Promise<void> {
  const visibleAgentTab = page
    .getByTestId(/^workspace-tab-agent_/)
    .filter({ visible: true })
    .first();

  await expect(visibleAgentTab).toBeVisible({ timeout: 30_000 });
  await expect(visibleAgentTab.getByRole("progressbar", { name: "Agent running" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /stop agent|canceling agent/i })).toHaveCount(0);
  await expect(page.getByTestId("turn-working-indicator")).toHaveCount(0);
  await expect(page.getByTestId("turn-working-elapsed")).toHaveCount(0);
}

export async function expectAgentSurfacesIdle(page: Page, title: string): Promise<void> {
  const tab = page.getByRole("button", { name: title, exact: true });

  await expect(tab).toBeVisible({ timeout: 30_000 });
  await expect(tab.getByRole("progressbar", { name: "Agent running" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /stop agent|canceling agent/i })).toHaveCount(0);
  await expect(page.getByTestId("turn-working-indicator")).toHaveCount(0);
  await expect(page.getByTestId("turn-working-elapsed")).toHaveCount(0);
  await expectTurnCopyButton(page);
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
