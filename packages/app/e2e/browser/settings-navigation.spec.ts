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

async function openWorkspace(
  page: import("@playwright/test").Page,
  workspace: { workspaceId: string },
) {
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
  await expect(page.getByTestId("menu-button")).toBeVisible();
}

test.describe("Settings sidebar navigation", () => {
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
  });

  test("/h/[serverId]/settings redirects to the host connections section", async ({ page }) => {
    await gotoAppShell(page);
    await verifyLegacyHostSettingsRedirect(page);
  });

  test("the + Add host button opens the add-host method modal", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);
    await openAddHostFlow(page);
    await expectAddHostMethodOptions(page);
  });

  test("direct connection advanced URI round-trips SSL and password into the form", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await openSettings(page);
    await openAddHostFlow(page);
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

  test("sidebar shows a Back to workspace row that leaves /settings", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);
    await clickSettingsBackToWorkspace(page);
    await expect(page).not.toHaveURL(/\/settings(\/|$)/);
  });

  test("pressing Escape closes settings", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);
    await page.keyboard.press("Escape");
    await expect(page).not.toHaveURL(/\/settings(\/|$)/);
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
  });
});

test.describe("Settings — compact master-detail", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("/settings renders only the sidebar list (no section content)", async ({ page }) => {
    await gotoAppShell(page);
    await openCompactSettings(page, buildOpenProjectRoute());

    await expectSettingsSidebarSections(page, ["general", "diagnostics", "about"]);
    await expectCompactSettingsList(page);

    await expectSettingsBackButton(page);
    await goBackInSettings(page);
    await expect(page).not.toHaveURL(/\/settings(\/|$)/);
  });

  test("tapping a section pushes /settings/[section] and shows a back button", async ({ page }) => {
    await gotoAppShell(page);
    await openCompactSettings(page, buildOpenProjectRoute());

    await openSettingsSection(page, "diagnostics");
    await expectAppRoute(page, buildSettingsSectionRoute("diagnostics"));
    await expectDiagnosticsContent(page);
    await expectSettingsSidebarHidden(page);
    await expectSettingsBackButton(page);
  });

  test("back from a section detail returns to the /settings list", async ({ page }) => {
    await gotoAppShell(page);
    await openCompactSettings(page, buildOpenProjectRoute());

    await openSettingsSection(page, "about");
    await expectAppRoute(page, buildSettingsSectionRoute("about"));

    await goBackInSettings(page);
    await expectCompactSettingsList(page);
    await expectSettingsBackButton(page);
  });

  test("tapping a host section row pushes /settings/hosts/[serverId]/connections", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await openCompactSettings(page, buildOpenProjectRoute());

    await openCompactSettingsHost(page);
    await expectSettingsBackButton(page);
    await expectSettingsSidebarHidden(page);
  });

  test("back from a host detail returns to the /settings list", async ({ page }) => {
    await gotoAppShell(page);
    await openCompactSettings(page, buildOpenProjectRoute());

    await openCompactSettingsHost(page);
    await goBackInSettings(page);
    await expectAppRoute(page, buildSettingsRoute());
    await expectSettingsSidebarVisible(page);
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
