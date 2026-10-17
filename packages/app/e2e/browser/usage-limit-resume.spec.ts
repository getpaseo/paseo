import { expect, test } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { submitMessageWithButton as submitMessage } from "../support/helpers/composer";

for (const viewport of [
  { name: "wide", width: 1280, height: 900 },
  { name: "compact", width: 390, height: 844 },
]) {
  test(`usage limit opt-in survives reload and can be cancelled (${viewport.name})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "usage-limit-",
      title: "Interrupted task",
    });
    try {
      await openAgentRoute(page, agent);
      await submitMessage(
        page,
        `Emit synthetic usage limit: ${new Date(Date.now() + 300_000).toISOString()}`,
      );
      const callout = page.getByTestId("usage-limit-callout");
      const toggle = page.getByTestId("usage-limit-auto-resume");
      await expect(callout).toContainText("Retry available at");
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await page.screenshot({ path: testInfo.outputPath(`limit-disabled-${viewport.name}.png`) });
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await expect(callout).toContainText("Will continue at");
      await page.reload();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await expect(callout).toContainText("Will continue at");
      await page.screenshot({ path: testInfo.outputPath(`limit-enabled-${viewport.name}.png`) });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({
        path: testInfo.outputPath(`limit-enabled-${viewport.name}-dark.png`),
      });
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await expect(callout).toContainText("Retry available at");
      await submitMessage(page, "Continue manually");
      await expect(callout).toHaveCount(0);
    } finally {
      await agent.cleanup();
    }
  });
}

test("overdue opt-in continues the same chat once", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "usage-limit-due-",
    title: "Resume this task",
  });
  try {
    await openAgentRoute(page, agent);
    await submitMessage(
      page,
      `Emit synthetic usage limit: ${new Date(Date.now() - 120_000).toISOString()}`,
    );
    const toggle = page.getByTestId("usage-limit-auto-resume");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(page.getByTestId("usage-limit-callout")).toContainText("Enabled for this chat", {
      timeout: 15_000,
    });
    await expect(page.getByText("The usage limit reset.", { exact: false })).toHaveCount(1);
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(page.getByTestId("usage-limit-callout")).toHaveCount(0);
  } finally {
    await agent.cleanup();
  }
});

test("missing reset time leaves manual continuation available", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "usage-limit-unknown-",
    title: "Unknown reset",
  });
  try {
    await openAgentRoute(page, agent);
    await submitMessage(page, "Emit synthetic usage limit: unknown");
    await expect(page.getByTestId("usage-limit-callout")).toContainText(
      "did not report a reset time",
    );
    await expect(page.getByTestId("usage-limit-auto-resume")).toBeDisabled();
    await submitMessage(page, "Continue manually");
    await expect(page.getByTestId("usage-limit-callout")).toHaveCount(0);
  } finally {
    await agent.cleanup();
  }
});
