import { test, expect } from "../support/fixtures";
import {
  buildHostWorkspaceRoute,
  buildOpenProjectRoute,
  buildSettingsHostSectionRoute,
  buildSettingsRoute,
  buildSettingsSectionRoute,
} from "@/utils/host-routes";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import {
  closeCompactSettings,
  openSettingsSection,
  expectSettingsHeader,
  openAddHostFlow,
  selectHostConnectionType,
  toggleHostAdvanced,
  openCompactSettings,
  expectCompactSettingsList,
  expectSettingsSidebarVisible,
  expectSettingsSidebarHidden,
  expectSettingsSidebarSections,
  goBackInSettings,
  expectSettingsBackButton,
  clickSettingsBackToWorkspace,
  verifyLegacyHostSettingsRedirect,
  openCompactSettingsHost,
  expectAddHostMethodOptions,
  fillDirectHostUri,
  expectDirectHostFormValues,
  expectDirectHostSslEnabled,
  expectDirectHostUriValue,
  expectDirectHostUriHidden,
  expectDiagnosticsContent,
  expectAboutContent,
  expectGeneralContent,
  expectAppearanceContent,
  seedSavedSettingsHosts,
  selectSettingsHost,
  expectSettingsHostPickerLabel,
  openSettingsHostSection,
  removeCurrentHostFromSettings,
} from "../support/helpers/settings";
import { getServerId } from "../support/helpers/server-id";
import { expectAppRoute } from "../support/helpers/route-assertions";
import type { Page } from "@playwright/test";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

async function savedSidebarWidth(page: Page) {
  return page.evaluate(() => {
    const stored = localStorage.getItem("panel-state");
    return stored ? (JSON.parse(stored).state.sidebarWidth as number) : 0;
  });
}

async function dragTouchSidebar(page: Page, testID: string, delta: number) {
  const grip = page.getByTestId(`${testID}-grip`);
  await expect(grip).toHaveCSS("opacity", "1");
  await expect(grip).toHaveCSS("width", "20px");
  await expect(grip).toHaveCSS("height", "64px");
  const idleColor = await grip.evaluate((element) => getComputedStyle(element).backgroundColor);
  const box = await page.getByTestId(testID).boundingBox();
  if (!box) throw new Error("Expected the touch resize target to be visible.");
  expect(box.width).toBeGreaterThanOrEqual(44);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  for (const progress of [0.125, 0.375, 0.75, 1]) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + delta * progress, y }],
    });
  }
  await expect(grip).not.toHaveCSS("background-color", idleColor);
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await session.detach();
  await expect(grip).toHaveCSS("opacity", "1");
  await expect(grip).toHaveCSS("background-color", idleColor);
}

async function openWorkspace(
  page: import("@playwright/test").Page,
  workspace: { workspaceId: string },
) {
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
  await expect(page.getByTestId("menu-button")).toBeVisible();
}

test.describe("Settings shared sidebar width on touch tablets", () => {
  test.use({ hasTouch: true, viewport: { width: 1366, height: 1024 } });

  test("touch resizing stays discoverable and settings preserve the saved width", async ({
    page,
  }, testInfo) => {
    await gotoAppShell(page);
    const handle = page.getByTestId("left-sidebar-resize-handle");
    const grip = page.getByTestId("left-sidebar-resize-handle-grip");
    await expect(grip).toHaveCSS("opacity", "1");
    await page.screenshot({ path: testInfo.outputPath("tablet-before-drag.png") });
    await dragTouchSidebar(page, "left-sidebar-resize-handle", 80);
    let savedWidth = await savedSidebarWidth(page);
    expect(savedWidth).toBeGreaterThan(350);

    await openSettings(page);
    const settingsSidebar = page.getByTestId("settings-sidebar");
    await expect(settingsSidebar).toHaveCSS("width", `${savedWidth}px`);
    await dragTouchSidebar(page, "settings-sidebar-resize-handle", 100);
    await expect.poll(() => savedSidebarWidth(page)).toBeGreaterThan(savedWidth + 60);
    savedWidth = await savedSidebarWidth(page);
    await expect(settingsSidebar).toHaveCSS("width", `${savedWidth}px`);
    await page.screenshot({ path: testInfo.outputPath("tablet-settings-wide.png") });
    await page.reload();
    await expect(settingsSidebar).toHaveCSS("width", `${savedWidth}px`);
    await page.setViewportSize({ width: 1000, height: 1024 });
    await expect(handle).toHaveCount(0);
    await expect(settingsSidebar).toHaveCSS("width", `${savedWidth}px`);
    await expectSettingsHeader(page, "General");
    await page.screenshot({ path: testInfo.outputPath("tablet-settings-narrow.png") });
    await page.setViewportSize({ width: 1366, height: 1024 });
    await expect(settingsSidebar).toHaveCSS("width", `${savedWidth}px`);
    await clickSettingsBackToWorkspace(page);
    await expect(handle).toBeVisible();
    await expect(grip).toHaveCSS("opacity", "1");
    const restoredHandle = await handle.boundingBox();
    expect(restoredHandle).not.toBeNull();
    // The touch target sits inside the sidebar's one-pixel border.
    expect(restoredHandle!.x + restoredHandle!.width + 1).toBeCloseTo(savedWidth, 0);
  });

  test("touch resize slider is visible in dark mode", async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await gotoAppShell(page);
    await expect(page.getByTestId("left-sidebar-resize-handle-grip")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: testInfo.outputPath("tablet-slider-dark.png") });
    await openSettings(page);
    const previousWidth = await savedSidebarWidth(page);
    await dragTouchSidebar(page, "settings-sidebar-resize-handle", -80);
    await expect.poll(() => savedSidebarWidth(page)).toBeLessThan(previousWidth);
    await expect(page.getByTestId("settings-sidebar")).toHaveCSS(
      "width",
      `${await savedSidebarWidth(page)}px`,
    );
    await page.screenshot({ path: testInfo.outputPath("settings-slider-dark.png") });
  });
});

test("settings sidebar mouse resizing preserves limits and compact navigation", async ({
  page,
}, testInfo) => {
  await gotoAppShell(page);
  await openSettings(page);
  const sidebar = page.getByTestId("settings-sidebar");
  const handle = page.getByTestId("settings-sidebar-resize-handle");
  await expect(handle).toBeVisible();
  await expect(page.getByTestId("settings-sidebar-resize-handle-grip")).toHaveCount(0);
  const box = await handle.boundingBox();
  if (!box) throw new Error("Expected the pointer resize target to be visible.");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 30, y);
  await page.mouse.move(x + 800, y, { steps: 8 });
  await expect(sidebar).toHaveCSS("width", "600px");
  await page.mouse.up();
  await expect.poll(() => savedSidebarWidth(page)).toBe(600);
  await page.screenshot({ path: testInfo.outputPath("settings-mouse-resized.png") });
  await page.setViewportSize({ width: 720, height: 900 });
  await expect(sidebar).toHaveCSS("width", "320px");
  expect(await savedSidebarWidth(page)).toBe(600);
  await page.setViewportSize({ width: 1366, height: 1024 });
  await expect(sidebar).toHaveCSS("width", "600px");
  await page.reload();
  await expect(sidebar).toHaveCSS("width", "600px");
  const resizedBox = await handle.boundingBox();
  if (!resizedBox) throw new Error("Expected the restored pointer resize target.");
  await page.mouse.move(resizedBox.x + resizedBox.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(resizedBox.x - 30, y);
  await page.mouse.move(0, y, { steps: 8 });
  await expect(sidebar).toHaveCSS("width", "200px");
  await page.mouse.up();
  await expect.poll(() => savedSidebarWidth(page)).toBe(200);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(handle).toHaveCount(0);
  await expectSettingsBackButton(page);
});

test.describe("Settings sidebar navigation", () => {
  test("opening Settings closes the composer model selector until it is opened again", async ({
    page,
    withWorkspace,
  }, testInfo) => {
    const workspace = await withWorkspace({ prefix: "settings-model-selector-" });
    await gotoWorkspace(page, workspace.workspaceId);
    await clickNewChat(page);

    const selector = page.getByTestId("combined-model-selector").filter({ visible: true });
    const popover = page.getByTestId("combobox-desktop-container");
    await selector.click();
    await expect(popover).toBeVisible();

    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+,`);
    await expect(page).toHaveURL(/\/settings\/general$/);
    await page.screenshot({ path: testInfo.outputPath("settings-after-model-selector.png") });
    await expect(popover).toHaveCount(0);

    await clickSettingsBackToWorkspace(page);
    await expect(selector).toBeVisible();
    await expect(popover).toHaveCount(0);

    await selector.click();
    await expect(popover).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
  });

  test("opening Settings closes an existing chat's model selector until it is opened again", async ({
    page,
  }, testInfo) => {
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "settings-existing-model-",
      title: "Settings model selector",
    });
    try {
      await openAgentRoute(page, {
        workspaceId: workspace.workspaceId,
        agentId: workspace.agentId,
      });

      const selector = page.getByTestId("combined-model-selector").filter({ visible: true });
      const popover = page.getByTestId("combobox-desktop-container");
      await selector.click();
      await expect(popover).toBeVisible();

      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await page.keyboard.press(`${modifier}+,`);
      await expect(page).toHaveURL(/\/settings\/general$/);
      await page.screenshot({
        path: testInfo.outputPath("settings-after-existing-model-selector.png"),
      });
      await expect(popover).toHaveCount(0);

      await clickSettingsBackToWorkspace(page);
      await expect(selector).toBeVisible();
      await expect(popover).toHaveCount(0);

      await selector.click();
      await expect(popover).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(popover).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });

  test("clicking a sidebar section updates the URL and renders the section", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);

    await openSettingsSection(page, "diagnostics");
    await expectSettingsHeader(page, "Diagnostics");
    await expectDiagnosticsContent(page);

    await openSettingsSection(page, "about");
    await expectSettingsHeader(page, "About");
    await expectAboutContent(page);

    await openSettingsSection(page, "general");
    await expectSettingsHeader(page, "General");
    await expectGeneralContent(page);

    await openSettingsSection(page, "appearance");
    await expectSettingsHeader(page, "Appearance");
    await expectAppearanceContent(page);

    await clickSettingsBackToWorkspace(page);
    await expect(page).not.toHaveURL(/\/settings(\/|$)/);
  });

  test("/h/[serverId]/settings redirects to the host connections section", async ({ page }) => {
    await gotoAppShell(page);
    await verifyLegacyHostSettingsRedirect(page);
  });

  test("direct connection advanced URI round-trips SSL and password into the form", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await openSettings(page);
    await openAddHostFlow(page);
    await expectAddHostMethodOptions(page);
    await selectHostConnectionType(page, "direct");

    await toggleHostAdvanced(page);
    await fillDirectHostUri(page, "tcp://example.paseo.test:7443?ssl=true&password=shared-secret");
    await toggleHostAdvanced(page);

    await expectDirectHostFormValues(page, {
      host: "example.paseo.test",
      port: "7443",
      password: "shared-secret",
    });
    await expectDirectHostSslEnabled(page);
    await expectDirectHostUriHidden(page);

    await toggleHostAdvanced(page);
    await expectDirectHostUriValue(
      page,
      "tcp://example.paseo.test:7443?ssl=true&password=shared-secret",
    );
    await toggleHostAdvanced(page);
    await expectDirectHostUriHidden(page);
  });

  test("Escape lets settings dropdowns and modals close before leaving settings", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await openSettings(page);

    await test.step("a dropdown owns Escape", async () => {
      await openSettingsSection(page, "appearance");
      await page.getByLabel(/Theme:/).click();
      await expect(page.getByRole("menuitem", { name: "System", exact: true })).toBeVisible();

      await page.keyboard.press("Escape");

      await expect(page.getByRole("menuitem", { name: "System", exact: true })).toHaveCount(0);
      await expect(page).toHaveURL(/\/settings(\/|$)/);
    });

    await test.step("a modal owns Escape", async () => {
      await openAddHostFlow(page);
      await expect(page.getByText("Add connection", { exact: true })).toBeVisible();

      await page.keyboard.press("Escape");

      await expect(page.getByText("Add connection", { exact: true })).toHaveCount(0);
      await expect(page).toHaveURL(/\/settings(\/|$)/);
    });

    await page.keyboard.press("Escape");
    await expect(page).not.toHaveURL(/\/settings(\/|$)/);
  });
});

test.describe("Settings — compact master-detail", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the compact tab switcher reopens after Settings hides its workspace", async ({ page }) => {
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "settings-tab-switcher-",
      title: "Compact tab switcher",
    });
    try {
      await openAgentRoute(page, {
        workspaceId: workspace.workspaceId,
        agentId: workspace.agentId,
      });

      const switcher = page.getByTestId("workspace-tab-switcher-trigger").filter({ visible: true });
      const newAgent = page.getByTestId("workspace-tab-switcher-new-agent");
      await switcher.click();
      await expect(newAgent).toBeInViewport();

      // Navigate without dismissing the sheet through its backdrop first.
      await page
        .getByTestId("menu-button")
        .filter({ visible: true })
        .first()
        .dispatchEvent("click");
      await page.getByTestId("sidebar-settings").first().dispatchEvent("click");
      await expectAppRoute(page, buildSettingsRoute());
      await expect(newAgent).toHaveCount(0);

      await closeCompactSettings(page);
      await expect(switcher).toBeVisible();
      await expect(newAgent).toHaveCount(0);
      await switcher.click();
      await expect(newAgent).toBeInViewport();
    } finally {
      await workspace.cleanup();
    }
  });

  test("opens compact app and host details and returns through the settings list", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await openCompactSettings(page, buildOpenProjectRoute());

    await expectSettingsSidebarSections(page, ["general", "diagnostics", "about"]);
    await expectCompactSettingsList(page);

    await test.step("open app details and return to the list", async () => {
      await openSettingsSection(page, "diagnostics");
      await expectAppRoute(page, buildSettingsSectionRoute("diagnostics"));
      await expectDiagnosticsContent(page);
      await expectSettingsSidebarHidden(page);
      await expectSettingsBackButton(page);
      await goBackInSettings(page);
      await expectCompactSettingsList(page);
    });

    await test.step("open host details and return through the list", async () => {
      await openCompactSettingsHost(page);
      await expectSettingsBackButton(page);
      await expectSettingsSidebarHidden(page);
      await goBackInSettings(page);
      await expectAppRoute(page, buildSettingsRoute());
      await expectSettingsSidebarVisible(page);
      await expectSettingsBackButton(page);
      await goBackInSettings(page);
      await expect(page).not.toHaveURL(/\/settings(\/|$)/);
    });
  });

  test("host picker settings opens Overview and backs through the settings list", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({ prefix: "host-picker-settings-back-" });
    const workspaceRoute = buildHostWorkspaceRoute(getServerId(), workspace.workspaceId);

    await openWorkspace(page, workspace);
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page.getByTestId("sidebar-hosts-trigger").click();
    await page.getByRole("button", { name: /Open .* settings/ }).click();

    await expectAppRoute(page, buildSettingsHostSectionRoute(getServerId(), "host"));
    await expect(page.getByText("Overview", { exact: true })).toBeVisible();

    await goBackInSettings(page);
    await expectCompactSettingsList(page);

    await goBackInSettings(page);
    await expectAppRoute(page, workspaceRoute);
  });

  test("switching the host picker on the settings list scopes host rows without navigating", async ({
    page,
  }) => {
    const primaryServerId = getServerId();
    const secondaryServerId = "srv_e2e_settings_secondary";
    const secondaryHostLabel = "Stable horse";
    const endpoint = `127.0.0.1:${getE2EDaemonPort()}`;

    await seedSavedSettingsHosts(page, [
      { serverId: primaryServerId, label: "First horse", endpoint },
      { serverId: secondaryServerId, label: secondaryHostLabel, endpoint },
    ]);
    await gotoAppShell(page);
    await openCompactSettings(page, buildOpenProjectRoute());

    await selectSettingsHost(page, secondaryServerId);

    await expectAppRoute(page, buildSettingsRoute());
    await expectSettingsSidebarVisible(page);
    await expectSettingsHostPickerLabel(page, secondaryHostLabel);

    await openSettingsHostSection(page, secondaryServerId, "connections");
  });

  test("removing the last active host returns to welcome after settings closes", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({ prefix: "remove-host-compact-" });

    await openWorkspace(page, workspace);
    await openCompactSettings(page, buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
    await openSettingsHostSection(page, getServerId(), "host");
    await removeCurrentHostFromSettings(page);
    await closeCompactSettings(page);

    await expect(page).toHaveURL(/\/welcome$/);
    await expect(page.getByTestId("welcome-direct-connection")).toBeVisible();
  });
});
