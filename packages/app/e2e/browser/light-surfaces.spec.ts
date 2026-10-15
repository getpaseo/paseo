import {
  createAgentTabFromMenu,
  ensureExplorerSidebar,
  openFilesPanel,
} from "../support/helpers/workspace-tabs";
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
    const surface = page.getByTestId("workspace-surface-main");
    await expect(surface).toHaveCSS("border-radius", "20px");
    await expect(surface).toHaveCSS("margin-bottom", "12px");
    await expect(page.getByTestId("workspace-pane-main")).toHaveCSS(
      "background-color",
      "rgb(239, 240, 243)",
    );
    await expect(surface.getByTestId("message-input-root")).toBeVisible();
    const agentTab = page.getByTestId(`workspace-tab-agent_${agent.agentId}`);
    await expect(agentTab).toHaveCSS("background-color", "rgb(252, 252, 253)");
    await createAgentTabFromMenu(page);
    const draftTab = page.locator('[data-testid^="workspace-tab-draft"]').filter({ visible: true });
    await expect(draftTab).toHaveCSS("background-color", "rgb(252, 252, 253)");
    await agentTab.click({ position: { x: 12, y: 13 } });
    await page.mouse.move(870, 360);
    await expect(agentTab).toHaveCSS("background-color", "rgb(252, 252, 253)");
    await expect(draftTab).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await page.screenshot({ path: testInfo.outputPath("tabs-active.png") });
    await draftTab.hover({ position: { x: 12, y: 13 } });
    await expect(draftTab).toHaveCSS("background-color", "rgb(247, 248, 250)");
    await expect(agentTab).toHaveCSS("background-color", "rgb(252, 252, 253)");
    await page.screenshot({ path: testInfo.outputPath("tabs-hover.png") });
    await page.mouse.move(870, 360);
    await page.mouse.wheel(0, -10000);
    await page.waitForTimeout(700);
    await page.screenshot({ path: testInfo.outputPath("conversation-desktop.png") });
    const explorer = await ensureExplorerSidebar(page);
    await openFilesPanel(page);
    await expect(explorer).toHaveCSS("background-color", "rgb(239, 240, 243)");
    await expect(explorer.getByTestId("file-explorer-tree-scroll")).toBeVisible();
    await expect(surface).toHaveCSS("border-radius", "20px");
    await page.screenshot({ path: testInfo.outputPath("conversation-explorer.png") });
    await page.getByTestId("workspace-explorer-toggle").filter({ visible: true }).first().click();
    await page.getByTestId("workspace-split-pane-menu").first().click();
    await page.getByTestId("workspace-split-pane-right").click();
    const surfaces = page.locator('[data-testid^="workspace-surface-"]').filter({ visible: true });
    await expect(surfaces).toHaveCount(2);
    await expect(surfaces.nth(1)).toHaveCSS("border-radius", "20px");
    await expect(surfaces.nth(1)).toHaveCSS("margin-bottom", "12px");
    await page.screenshot({ path: testInfo.outputPath("conversation-split.png") });
    await page
      .getByTestId(`workspace-tab-agent_${agent.agentId}`)
      .click({ position: { x: 12, y: 13 } });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("message-input-root")).toBeVisible();
    await expect(page.getByTestId("message-input-root")).toBeInViewport();
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
