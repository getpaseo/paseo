import {
  createAgentTab,
  ensureExplorerSidebar,
  openFilesPanel,
} from "../support/helpers/workspace-tabs";
import type { Locator } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { openSettingsSection } from "../support/helpers/settings";

async function expectLightFrame(surface: Locator) {
  await expect(surface).toHaveCSS("border-radius", "20px");
  await expect(surface).toHaveCSS("margin-left", "12px");
  await expect(surface).toHaveCSS("margin-right", "12px");
  await expect(surface).toHaveCSS("margin-top", "6px");
  await expect(surface).toHaveCSS("margin-bottom", "12px");
  await expect(surface).toHaveCSS("background-color", "rgb(252, 252, 253)");
  // Probe the painted containers immediately outside all four card corners.
  expect(
    await surface.evaluate((element) => {
      const r = element.getBoundingClientRect();
      return [
        [r.left - 2, r.top + 2],
        [r.right + 2, r.top + 2],
        [r.left - 2, r.bottom - 2],
        [r.right + 2, r.bottom - 2],
      ].map(([x, y]) => {
        let node = document.elementFromPoint(x, y);
        while (node) {
          const color = getComputedStyle(node).backgroundColor;
          if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") return color;
          node = node.parentElement;
        }
        return null;
      });
    }),
  ).toEqual(Array(4).fill("rgb(239, 240, 243)"));
}

async function expectLightTab(tab: Locator) {
  await expect(tab).toHaveCSS("height", "28px");
  await expect(tab).toHaveCSS("border-radius", "8px");
  await expect(tab).toHaveCSS("border-bottom-width", "0px");
  expect(
    await tab.evaluate((node) => {
      const tabBounds = node.getBoundingClientRect();
      const rail = node.closest('[data-testid="workspace-tabs-row"]')!;
      const railBounds = rail.getBoundingClientRect();
      return Math.abs(tabBounds.y + tabBounds.height / 2 - railBounds.y - railBounds.height / 2);
    }),
  ).toBeLessThanOrEqual(1);
  expect(
    await tab.locator(":scope > div").evaluateAll(
      (nodes) =>
        nodes.filter((node) => {
          const style = getComputedStyle(node);
          return (
            style.position === "absolute" &&
            parseFloat(style.height) > 0 &&
            style.pointerEvents === "none"
          );
        }).length,
    ),
  ).toBe(0);
}

test("applies Light surface tokens on desktop and compact layouts", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.addInitScript(() => {
    if (!localStorage.getItem("@paseo:light-surfaces-seeded")) {
      localStorage.setItem(
        "@paseo:app-settings",
        JSON.stringify({ theme: "light", language: "en" }),
      );
      localStorage.setItem("@paseo:light-surfaces-seeded", "1");
    }
  });
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "paseo-design-",
    title: "Affiner la conversation et vérifier un titre très long dans les onglets du workspace",
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
    await expect(page.getByTestId("left-sidebar-resize-handle").locator("..")).toHaveCSS(
      "border-right-width",
      "0px",
    );
    const surface = page.getByTestId("workspace-surface-main");
    await expect(surface).toHaveCSS("border-radius", "20px");
    await expect(surface).toHaveCSS("margin-bottom", "12px");
    await expect(page.getByTestId("workspace-pane-main")).toHaveCSS(
      "background-color",
      "rgb(239, 240, 243)",
    );
    await expect(surface.getByTestId("message-input-root")).toBeVisible();
    await expectLightFrame(surface);
    const agentTab = page.getByTestId(`workspace-tab-agent_${agent.agentId}`);
    await expect(agentTab).toHaveCSS("background-color", "rgb(252, 252, 253)");
    await expectLightTab(agentTab);
    await createAgentTab(page);
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
    await expectLightFrame(surface);
    await expectLightTab(explorer.getByTestId("workspace-tab-files"));
    await expect(explorer.getByTestId("explorer-shell-tab")).toHaveCSS("height", "28px");
    await expect(explorer.getByTestId("explorer-shell-tab")).toHaveCSS("border-radius", "8px");
    await page.screenshot({ path: testInfo.outputPath("conversation-explorer.png") });
    await page.getByTestId("workspace-explorer-toggle").filter({ visible: true }).first().click();
    await page.getByTestId("workspace-split-pane-menu").first().click();
    await page.getByTestId("workspace-split-pane-right").click();
    const surfaces = page.locator('[data-testid^="workspace-surface-"]').filter({ visible: true });
    await expect(surfaces).toHaveCount(2);
    await expect(surfaces.nth(1)).toHaveCSS("border-radius", "20px");
    await expect(surfaces.nth(1)).toHaveCSS("margin-bottom", "12px");
    await expectLightFrame(surfaces.nth(0));
    await expectLightFrame(surfaces.nth(1));
    await expect(agentTab).toHaveCSS("background-color", "rgb(247, 248, 250)");
    await page.screenshot({ path: testInfo.outputPath("conversation-split.png") });
    const handle = await page.getByTestId("workspace-split-resize-handle").boundingBox();
    if (!handle) throw new Error("Split resize handle must be visible");
    const beforeWidth = await surfaces
      .first()
      .evaluate((node) => node.getBoundingClientRect().width);
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 70, handle.y + handle.height / 2, {
      steps: 10,
    });
    await page.mouse.up();
    await expect
      .poll(() => surfaces.first().evaluate((node) => node.getBoundingClientRect().width))
      .toBeGreaterThan(beforeWidth + 40);
    await expectLightFrame(surfaces.first());
    await expectLightFrame(surfaces.nth(1));
    await page.screenshot({ path: testInfo.outputPath("conversation-resized.png") });
    await page
      .getByTestId(`workspace-tab-agent_${agent.agentId}`)
      .click({ position: { x: 12, y: 13 } });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("message-input-root")).toBeVisible();
    await expect(page.getByTestId("message-input-root")).toBeInViewport();
    await expect(
      page.locator('[data-testid^="workspace-surface-"]').filter({ visible: true }),
    ).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("conversation-compact.png") });
    await page.setViewportSize({ width: 1440, height: 960 });
    const workspaceUrl = page.url();
    await page.goto("/settings");
    await openSettingsSection(page, "appearance");
    await expect(page.getByLabel("Theme: Light", { exact: true })).toBeVisible();
    await page.getByLabel("Theme: Light", { exact: true }).click();
    await page.getByText("Dark", { exact: true }).click();
    await page.goto(workspaceUrl);
    await expect(agentTab).toHaveCSS("height", "35px");
    await expect(agentTab).toHaveCSS("border-radius", "0px");
    await expect(surface).toHaveCSS("margin-left", "0px");
    await page.screenshot({ path: testInfo.outputPath("conversation-dark.png") });
    expect(errors).toEqual([]);
  } finally {
    await agent.cleanup();
  }
});
