import { test, expect } from "./fixtures";
import { gotoAppShell, openSettings } from "./helpers/app";
import {
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
} from "./helpers/settings";

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
  });

  test("/h/[serverId]/settings redirects to /settings/hosts/[serverId]", async ({ page }) => {
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
});

test.describe("Settings — compact master-detail", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("/settings renders only the sidebar list (no section content)", async ({ page }) => {
    await gotoAppShell(page);
    await openCompactSettings(page);

    await expectSettingsSidebarSections(page, ["general", "diagnostics", "about"]);
    await expectCompactSettingsList(page);

    await expectSettingsBackButton(page);
    await goBackInSettings(page);
    await expect(page).not.toHaveURL(/\/settings(\/|$)/);
  });

  test("tapping a section pushes /settings/[section] and shows a back button", async ({ page }) => {
    await gotoAppShell(page);
    await openCompactSettings(page);

    await openSettingsSection(page, "diagnostics");
    await expect(page).toHaveURL(/\/settings\/diagnostics$/);
    await expectDiagnosticsContent(page);
    await expectSettingsSidebarHidden(page);
    await expectSettingsBackButton(page);
  });

  test("back from a section detail returns to the /settings list", async ({ page }) => {
    await gotoAppShell(page);
    await openCompactSettings(page);

    await openSettingsSection(page, "about");
    await expect(page).toHaveURL(/\/settings\/about$/);

    await goBackInSettings(page);
    await expectCompactSettingsList(page);
    await expectSettingsBackButton(page);
  });

  test("tapping a host entry pushes /settings/hosts/[serverId]", async ({ page }) => {
    await gotoAppShell(page);
    await openCompactSettings(page);

    await openCompactSettingsHost(page);
    await expectSettingsBackButton(page);
    await expectSettingsSidebarHidden(page);
  });

  test("back from a host detail returns to the /settings list", async ({ page }) => {
    await gotoAppShell(page);
    await openCompactSettings(page);

    await openCompactSettingsHost(page);
    await goBackInSettings(page);
    await expect(page).toHaveURL(/\/settings$/);
    await expectSettingsSidebarVisible(page);
  });
});
