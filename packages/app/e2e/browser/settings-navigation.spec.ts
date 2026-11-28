import { writeFile } from "node:fs/promises";
import { test, expect } from "../support/fixtures";
import {
  buildHostWorkspaceRoute,
  buildOpenProjectRoute,
  buildSettingsHostSectionRoute,
  buildSettingsRoute,
  buildSettingsSectionRoute,
} from "@/utils/host-routes";
import { openCompactSidebar } from "../support/helpers/usage-sidebar-item";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import {
  closeCompactSettings,
  captureCompactSidebarReturn,
  openSettingsFromCompactSidebar,
  captureCompactSidebarContext,
  expectCompactSidebarOpen,
  closeCompactSidebar,
  dragSettingsSidebarResizeHandle,
  scrollSettingsSidebarToEnd,
  revealSettingsSidebarSection,
  expectSettingsSidebarScrollSettled,
  scrollSettingsSidebarUp,
  selectSettingsHostSectionsRapidly,
  expectSettingsSidebarScrollOffset,
  scrollSettingsDetailDown,
  expectSettingsDetailScrollOffset,
  openSettingsSection,
  changeSettingsSyntaxTheme,
  revealSettingsSyntaxTheme,
  expectSettingsSyntaxColorChanged,
  changeSettingsTypography,
  normalizeSettingsFontSizes,
  changeSettingsInterfaceFontSizeKeepingSidebarPosition,
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
  expectDirectHostSslDisabled,
  fillDirectHostAddress,
  toggleDirectHostSsl,
  expectDirectHostUriValue,
  expectDirectHostUriHidden,
  expectDiagnosticsContent,
  expectAboutContent,
  expectGeneralContent,
  expectAppearanceContent,
  seedSavedSettingsHosts,
  selectSettingsHost,
  expectSettingsHostPickerLabel,
  openClientHostSettings,
  openSettingsHostSection,
  removeCurrentHostFromSettings,
  openSidebarHostPicker,
  sidebarHostRowButton,
  activateSidebarHostSettingsWithKeyboard,
  bindCommandCenterToEnter,
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
  const idleOpacity = testID === "left-sidebar-resize-handle" ? "0.5" : "0.15";
  const pressedOpacity = testID === "left-sidebar-resize-handle" ? "1" : "0.3";
  await expect(grip).toHaveCSS("opacity", idleOpacity);
  const box = await page.getByTestId(testID).boundingBox();
  if (!box) throw new Error("Expected the touch resize target to be visible.");
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
  await expect(grip).toHaveCSS("opacity", pressedOpacity);
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await session.detach();
  await expect(grip).toHaveCSS("opacity", idleOpacity);
}

async function cancelSettingsSidebarDrag(page: Page, initialWidth: number) {
  const box = await page.getByTestId("settings-sidebar-resize-handle").boundingBox();
  if (!box) throw new Error("Expected the touch resize target to be visible.");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (const progress of [0.125, 0.375, 0.75, 1]) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + 100 * progress, y }],
    });
  }
  await expect(page.getByTestId("settings-sidebar-resize-handle-grip")).toHaveCSS("opacity", "0.3");
  await expect
    .poll(async () => (await page.getByTestId("settings-sidebar").boundingBox())?.width ?? 0)
    .toBeGreaterThan(initialWidth + 30);
  await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await session.detach();
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

  test("cancelling an active settings resize preserves the saved width", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);
    const before = await savedSidebarWidth(page);
    const sidebar = page.getByTestId("settings-sidebar");
    const initialWidth = await sidebar.evaluate((element) => element.getBoundingClientRect().width);
    await cancelSettingsSidebarDrag(page, initialWidth);
    await expect(sidebar).toHaveCSS("width", `${initialWidth}px`);
    expect(await savedSidebarWidth(page)).toBe(before);
    await page.reload();
    await expect(sidebar).toHaveCSS("width", `${initialWidth}px`);
  });

  test("touch resizing stays discoverable and settings preserve the saved width", async ({
    page,
  }, testInfo) => {
    await gotoAppShell(page);
    const handle = page.getByTestId("left-sidebar-resize-handle");
    const grip = page.getByTestId("left-sidebar-resize-handle-grip");
    await expect(grip).toHaveCSS("opacity", "0.5");
    await expect(grip).toHaveCSS("height", "40px");
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
    await expect(grip).toHaveCSS("opacity", "0.5");
    const restoredHandle = await handle.boundingBox();
    expect(restoredHandle).not.toBeNull();
    // The touch target sits inside the sidebar's one-pixel border.
    expect(restoredHandle!.x + restoredHandle!.width + 1).toBeCloseTo(savedWidth, 0);
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
  await dragSettingsSidebarResizeHandle(page, 2000);
  await expect(sidebar).toHaveCSS("width", "600px");
  await expect.poll(() => savedSidebarWidth(page)).toBe(600);
  await page.screenshot({ path: testInfo.outputPath("settings-mouse-resized.png") });
  await page.setViewportSize({ width: 720, height: 900 });
  await expect(sidebar).toHaveCSS("width", "320px");
  expect(await savedSidebarWidth(page)).toBe(600);
  await page.setViewportSize({ width: 1366, height: 1024 });
  await expect(sidebar).toHaveCSS("width", "600px");
  await page.reload();
  await expect(sidebar).toHaveCSS("width", "600px");
  await dragSettingsSidebarResizeHandle(page, 0);
  await expect(sidebar).toHaveCSS("width", "200px");
  await expect.poll(() => savedSidebarWidth(page)).toBe(200);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(handle).toHaveCount(0);
  await expectSettingsBackButton(page);
});

test("settings fits its available space without overwriting the saved width", async ({ page }) => {
  await gotoAppShell(page);
  await openSettings(page);
  const sidebar = page.getByTestId("settings-sidebar");
  const detail = page.getByTestId("settings-detail-pane");
  const savedWidth = await savedSidebarWidth(page);
  const initialWidth = await sidebar.evaluate((element) => element.getBoundingClientRect().width);
  const row = detail.locator("..");
  await row.evaluate((element) => (element.style.maxWidth = "550px"));
  await expect(sidebar).toHaveCSS("width", "150px");
  await expect(detail).toHaveCSS("width", "400px");
  expect(await savedSidebarWidth(page)).toBe(savedWidth);
  await row.evaluate((element) => (element.style.maxWidth = ""));
  await expect(sidebar).toHaveCSS("width", `${initialWidth}px`);
});

test.describe("Settings sidebar scroll position", () => {
  test.use({ viewport: { width: 1000, height: 500 } });

  test("clamps after resizing and starts a fresh visit at the top", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);
    await scrollSettingsSidebarToEnd(page);
    await page.setViewportSize({ width: 1000, height: 1100 });
    await expectSettingsSidebarScrollOffset(page, 0);
    await page.setViewportSize({ width: 1000, height: 500 });
    await openSettingsSection(page, "appearance");
    await expectSettingsSidebarScrollOffset(page, 0);
    await scrollSettingsSidebarToEnd(page);
    await clickSettingsBackToWorkspace(page);
    await openSettings(page);
    await expectSettingsSidebarScrollOffset(page, 0);
  });

  test("updates appearance without losing the detail scroll or form edits", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsSection(page, "appearance");
    const { offset, keywordColor } = await revealSettingsSyntaxTheme(page);
    await changeSettingsSyntaxTheme(page, "Dracula");
    await expectSettingsDetailScrollOffset(page, offset);
    await expectSettingsSyntaxColorChanged(page, keywordColor);
    await changeSettingsTypography(page);
  });

  test("shows normalized font sizes after committing out-of-range and empty values", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsSection(page, "appearance");
    await normalizeSettingsFontSizes(page);
  });

  test("keeps the sidebar context through interface font changes", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsSection(page, "appearance");
    await scrollSettingsSidebarToEnd(page);
    const offset = await changeSettingsInterfaceFontSizeKeepingSidebarPosition(page, 20);
    await openSettingsHostSection(page, getServerId(), "providers");
    await expectSettingsSidebarScrollOffset(page, offset);
  });

  test("keeps sidebar and detail scrolling independent through section changes", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await openSettings(page);

    await test.step("scrolls the sidebar and detail pane independently", async () => {
      const sidebarOffset = await scrollSettingsSidebarToEnd(page);
      await openSettingsHostSection(page, getServerId(), "providers");
      await expect(page.getByTestId("host-page-providers-card")).toBeVisible();
      const detailOffset = await scrollSettingsDetailDown(page);
      await expectSettingsSidebarScrollOffset(page, sidebarOffset);

      await scrollSettingsSidebarUp(page, 60);
      await expectSettingsSidebarScrollOffset(page, sidebarOffset - 60);
      await expectSettingsDetailScrollOffset(page, detailOffset);
    });

    await test.step("keeps the sidebar position after rapid consecutive selections", async () => {
      const scrollTop = await scrollSettingsSidebarToEnd(page);

      await selectSettingsHostSectionsRapidly(page);
      await expectSettingsSidebarScrollOffset(page, scrollTop);

      await expectSettingsSidebarScrollSettled(page, scrollTop);
    });

    await test.step("keeps the sidebar position when switching between app and host sections", async () => {
      const hostScrollTop = await scrollSettingsSidebarToEnd(page);
      await expect(page.getByTestId("settings-host-section-providers")).toBeInViewport();

      for (const section of [
        "providers",
        "terminals",
        "providers",
        "terminals",
        "providers",
      ] as const) {
        await openSettingsHostSection(page, getServerId(), section);
        await expect(page.getByTestId("page-title")).toHaveText(
          section === "providers" ? "Providers" : "Terminals",
        );
        await expectSettingsSidebarScrollOffset(page, hostScrollTop);
      }

      const sidebar = page.getByTestId("settings-sidebar");
      const appScrollTop = await revealSettingsSidebarSection(page, "about");
      await expect(sidebar.getByRole("button", { name: "About", exact: true })).toBeInViewport();

      await openSettingsSection(page, "about");
      await expectAboutContent(page);
      await expectDiagnosticsContent(page);
      await expectSettingsSidebarScrollOffset(page, appScrollTop);

      await openSettingsSection(page, "shortcuts");
      await expectSettingsSidebarScrollOffset(page, appScrollTop);
    });
  });
});

test.describe("Settings sidebar navigation", () => {
  test("the sidebar host row opens Daemon in one click", async ({ page, withWorkspace }) => {
    const workspace = await withWorkspace({ prefix: "sidebar-host-settings-" });
    await openWorkspace(page, workspace);
    await openSidebarHostPicker(page);
    await sidebarHostRowButton(page).click();

    await expectAppRoute(page, buildSettingsHostSectionRoute(getServerId(), "daemon"));
  });

  test("Enter opens the active sidebar host row", async ({ page, withWorkspace }) => {
    await bindCommandCenterToEnter(page);
    const workspace = await withWorkspace({ prefix: "keyboard-host-settings-" });
    await openWorkspace(page, workspace);
    await openSidebarHostPicker(page);
    await activateSidebarHostSettingsWithKeyboard(page);

    await expectAppRoute(page, buildSettingsHostSectionRoute(getServerId(), "daemon"));
  });

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

    await openSettingsSection(page, "about");
    await expectSettingsHeader(page, "About");
    await expectAboutContent(page);
    await expectDiagnosticsContent(page);

    await openSettingsSection(page, "general");
    await expectSettingsHeader(page, "General");
    await expectGeneralContent(page);

    await openSettingsSection(page, "appearance");
    await expectSettingsHeader(page, "Appearance");
    await expectAppearanceContent(page);

    await clickSettingsBackToWorkspace(page);
    await expect(page).not.toHaveURL(/\/settings(\/|$)/);
  });

  test("host choice survives app sections and host screen replacements", async ({ page }) => {
    const primaryServerId = getServerId();
    const secondaryServerId = "srv_e2e_settings_secondary";
    const endpoint = `127.0.0.1:${getE2EDaemonPort()}`;
    await seedSavedSettingsHosts(page, [
      { serverId: primaryServerId, label: "First horse", endpoint },
      { serverId: secondaryServerId, label: "Stable horse", endpoint },
    ]);
    await gotoAppShell(page);
    await openSettings(page);
    await selectSettingsHost(page, secondaryServerId);
    await openSettingsHostSection(page, secondaryServerId, "daemon");
    await openSettingsSection(page, "appearance");
    await expectSettingsHostPickerLabel(page, "Stable horse");
    await openSettingsSection(page, "general");
    await expectSettingsHostPickerLabel(page, "Stable horse");
    await openSettingsHostSection(page, secondaryServerId, "daemon");
    await selectSettingsHost(page, primaryServerId);
    await openSettingsSection(page, "about");
    await expectSettingsHostPickerLabel(page, "First horse");
  });

  test("/h/[serverId]/settings redirects to the host daemon section", async ({ page }) => {
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

    await fillDirectHostAddress(page, "example.paseo.test", "7443");
    await expectDirectHostSslDisabled(page);
    await toggleDirectHostSsl(page);
    await expectDirectHostSslEnabled(page);
    await toggleHostAdvanced(page);
    await expectDirectHostUriValue(page, "tcp://example.paseo.test:7443?ssl=true");
    await toggleHostAdvanced(page);
    await toggleDirectHostSsl(page);
    await expectDirectHostSslDisabled(page);

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
      await page.getByLabel(/Highlight theme:/).click();
      await expect(page.getByRole("menuitem", { name: "GitHub", exact: true })).toBeVisible();

      await page.keyboard.press("Escape");

      await expect(page.getByRole("menuitem", { name: "GitHub", exact: true })).toHaveCount(0);
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

  test("returning from Settings preserves the open sidebar from the first paint", async ({
    page,
    withWorkspace,
  }, testInfo) => {
    const workspace = await withWorkspace({ prefix: "settings-sidebar-continuity-" });
    for (let i = 0; i < 12; i++) await withWorkspace({ prefix: "settings-sidebar-scroll-" });
    await openWorkspace(page, workspace);
    await openCompactSidebar(page);
    await expectCompactSidebarOpen(page);
    const expectContextPreserved = await captureCompactSidebarContext(page);
    const openingFrames = await captureCompactSidebarReturn(page, () =>
      openSettingsFromCompactSidebar(page),
    );
    await writeFile(
      testInfo.outputPath("sidebar-opening-frames.json"),
      JSON.stringify(openingFrames, null, 2),
    );
    expect(openingFrames.some((frame) => frame.settingsVisible)).toBe(true);
    expect(openingFrames.every((frame) => frame.sidebarVisible || frame.settingsVisible)).toBe(
      true,
    );
    await openSettingsSection(page, "appearance");
    await goBackInSettings(page);
    const frames = await captureCompactSidebarReturn(page, () => closeCompactSettings(page));
    await writeFile(
      testInfo.outputPath("sidebar-return-frames.json"),
      JSON.stringify(frames, null, 2),
    );
    await testInfo.attach("sidebar-return-frames", {
      body: JSON.stringify(frames, null, 2),
      contentType: "application/json",
    });
    const workspaceFrames = frames.filter((frame) => !frame.pathname.startsWith("/settings"));
    expect(workspaceFrames.length).toBeGreaterThan(0);
    expect(workspaceFrames.every((frame) => frame.sidebarVisible)).toBe(true);
    const firstX = workspaceFrames[0]!.closeX;
    expect(
      workspaceFrames.every((frame) => Math.abs((frame.closeX ?? Infinity) - firstX!) < 1),
    ).toBe(true);
    await expectCompactSidebarOpen(page);
    await expectContextPreserved();
    await openSettingsFromCompactSidebar(page);
    const backFrames = await captureCompactSidebarReturn(page, async () => {
      await page.goBack();
    });
    await writeFile(
      testInfo.outputPath("browser-back-frames.json"),
      JSON.stringify(backFrames, null, 2),
    );
    await testInfo.attach("browser-back-frames", {
      body: JSON.stringify(backFrames, null, 2),
      contentType: "application/json",
    });
    const backWorkspaceFrames = backFrames.filter(
      (frame) => !frame.pathname.startsWith("/settings"),
    );
    expect(backWorkspaceFrames.length).toBeGreaterThan(0);
    expect(backWorkspaceFrames.every((frame) => frame.sidebarVisible)).toBe(true);
    await expectCompactSidebarOpen(page);
    await closeCompactSidebar(page);
  });

  test("widening during Settings discards the mobile sidebar return", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({ prefix: "settings-sidebar-resize-" });
    await openWorkspace(page, workspace);
    await openCompactSettings(page, buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
    await page.setViewportSize({ width: 1000, height: 844 });
    await expect(page.getByTestId("settings-detail-pane")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await goBackInSettings(page);
    await expectCompactSettingsList(page);
    await closeCompactSettings(page);
    await expect(page.getByRole("button", { name: "Close sidebar", exact: true })).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Open menu", exact: true }).first(),
    ).toBeInViewport();
  });

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
      await closeCompactSidebar(page);
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

    await expectSettingsSidebarSections(page, ["general", "hosts", "about"]);
    await expectCompactSettingsList(page);

    await test.step("open app details and return to the list", async () => {
      await openSettingsSection(page, "about");
      await expectAppRoute(page, buildSettingsSectionRoute("about"));
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

  test("host picker settings opens Daemon and backs through the settings list", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({ prefix: "host-picker-settings-back-" });
    const workspaceRoute = buildHostWorkspaceRoute(getServerId(), workspace.workspaceId);

    await openWorkspace(page, workspace);
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page.getByTestId("sidebar-hosts-trigger").click();
    await sidebarHostRowButton(page).click();

    await expectAppRoute(page, buildSettingsHostSectionRoute(getServerId(), "daemon"));
    await expect(page.getByText("Daemon", { exact: true }).first()).toBeVisible();

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

    await openSettingsHostSection(page, secondaryServerId, "daemon");
    await goBackInSettings(page);
    await expectSettingsHostPickerLabel(page, secondaryHostLabel);

    await openSettingsSection(page, "appearance");
    await goBackInSettings(page);
    await expectSettingsHostPickerLabel(page, secondaryHostLabel);
    await openSettingsHostSection(page, secondaryServerId, "daemon");
    await goBackInSettings(page);
    await expectSettingsHostPickerLabel(page, secondaryHostLabel);
  });

  test("removing the last active host returns to welcome after settings closes", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({ prefix: "remove-host-compact-" });

    await openWorkspace(page, workspace);
    await openCompactSettings(page, buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
    await openClientHostSettings(page, getServerId());
    await removeCurrentHostFromSettings(page);
    await goBackInSettings(page);
    await closeCompactSettings(page);

    await expect(page).toHaveURL(/\/welcome$/);
    await expect(page.getByTestId("welcome-direct-connection")).toBeVisible();
  });
});

async function measureDockedNavigation(page: import("@playwright/test").Page, width: number) {
  await page.setViewportSize({ width, height: 951 });
  const history = page.getByRole("button", { name: /^History/ }).filter({ visible: true });
  const settings = page
    .getByRole("button", { name: "Settings", exact: true })
    .filter({ visible: true });
  await expect(history).toBeVisible();
  await expect(settings).toBeVisible();
  return {
    width,
    history: await history.evaluate((el) => el.getBoundingClientRect().height),
    settings: await settings.evaluate((el) => el.getBoundingClientRect().height),
  };
}

async function measureSettingsSplit(page: import("@playwright/test").Page, width: number) {
  await page.setViewportSize({ width, height: 951 });
  const sidebar = page.getByTestId("settings-sidebar");
  const detail = page.getByTestId("settings-detail-pane");
  await expect(sidebar).toBeVisible();
  await expect(detail).toBeVisible();
  return {
    width,
    sidebar: await sidebar.evaluate((el) => el.getBoundingClientRect().width),
    detail: await detail.evaluate((el) => el.getBoundingClientRect().width),
  };
}

async function expectConsistentDockedNavigation(page: import("@playwright/test").Page) {
  const wide = await measureDockedNavigation(page, 951);
  for (const width of [600, 669, 719, 720]) {
    const narrow = await measureDockedNavigation(page, width);
    expect
      .soft(narrow.history, `History keeps its wide-layout density at ${width}`)
      .toBeCloseTo(wide.history, 0);
    expect
      .soft(narrow.settings, `Settings keeps its wide-layout density at ${width}`)
      .toBeCloseTo(wide.settings, 0);
  }
}

async function expectSettingsDetailKeepsReadingWidth(page: import("@playwright/test").Page) {
  const reference = await measureSettingsSplit(page, 720);
  for (const width of [600, 669, 719]) {
    const narrow = await measureSettingsSplit(page, width);
    expect
      .soft(narrow.detail, `Settings preserves its detail budget at ${width}`)
      .toBeGreaterThanOrEqual(reference.detail);
    expect
      .soft(narrow.sidebar, `Settings navigation yields width at ${width}`)
      .toBeLessThan(reference.sidebar);
  }
  const wide = await measureSettingsSplit(page, 951);
  expect(wide.sidebar).toBeCloseTo(reference.sidebar, 0);
  expect(wide.detail).toBeGreaterThan(reference.detail);
}

test("docked navigation keeps its density and Settings preserves reading width", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "narrow-wide-layout-" });
  await gotoWorkspace(page, workspace.workspaceId);
  await expectConsistentDockedNavigation(page);
  await openSettings(page);
  await openSettingsSection(page, "appearance");
  await expectAppearanceContent(page);
  await expectSettingsDetailKeepsReadingWidth(page);
  await page.setViewportSize({ width: 599, height: 951 });
  await expectSettingsSidebarHidden(page);
  await expectAppearanceContent(page);
});
