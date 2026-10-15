import { test, expect } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { openSettingsSection } from "../support/helpers/settings";

test("applies Light surface tokens on desktop and compact layouts", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.addInitScript(() => {
    localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: "light" }));
  });
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "paseo-design-",
    title: "Affiner la conversation",
    model: "e2e-fast-stream",
  });
  try {
    await agent.client.sendAgentMessage(
      agent.agentId,
      "Peux-tu examiner le défilement de la conversation et proposer une amélioration ciblée ?",
    );
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await openAgentRoute(page, agent);
    await expect(page.getByTestId("message-input-root")).toBeVisible();
    await expect(page.getByText("Cycle 1", { exact: true })).toBeAttached();
    const bubble = page.getByTestId("user-message").first().locator(":scope > div > div").first();
    const inputSurface = page.getByTestId("message-input-root").locator(":scope > div").first();
    await expect(bubble).toHaveCSS("background-color", "rgb(240, 241, 244)");
    await expect(bubble).toHaveCSS("border-top-right-radius", "22px");
    await expect(inputSurface).toHaveCSS("background-color", "rgb(252, 252, 253)");
    await expect(inputSurface).not.toHaveCSS("box-shadow", "none");
    await page.mouse.move(870, 360);
    await page.mouse.wheel(0, -10000);
    await page.waitForTimeout(700);
    await page.screenshot({ path: testInfo.outputPath("conversation-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("message-input-root")).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: testInfo.outputPath("conversation-compact.png") });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/settings");
    await openSettingsSection(page, "appearance");
    await expect(page.getByLabel("Theme: Light", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("settings-desktop.png") });
    expect(errors).toEqual([]);
  } finally {
    await agent.cleanup();
  }
});
