import { test, expect, type Page } from "./fixtures";
import { gotoAppShell, openSettings } from "./helpers/app";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set (expected from Playwright globalSetup).");
  }
  return serverId;
}

async function clickSidebarSection(page: Page, label: string) {
  const sidebar = page.getByTestId("settings-sidebar");
  await expect(sidebar).toBeVisible();
  await sidebar.getByRole("button", { name: label, exact: true }).click();
}

test.describe("Settings sidebar navigation", () => {
  test("clicking a sidebar section updates the URL and renders the section", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);

    await clickSidebarSection(page, "Diagnostics");
    await expect(page).toHaveURL(/\/settings\/diagnostics$/);
    await expect(page.getByRole("button", { name: "Play test" })).toBeVisible();
    await expect(page.getByTestId("settings-detail-header-title")).toHaveText("Diagnostics");

    await clickSidebarSection(page, "About");
    await expect(page).toHaveURL(/\/settings\/about$/);
    await expect(page.getByText("Version", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("settings-detail-header-title")).toHaveText("About");

    await clickSidebarSection(page, "General");
    await expect(page).toHaveURL(/\/settings\/general$/);
    await expect(page.getByText("Theme", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("settings-detail-header-title")).toHaveText("General");
  });

  test("/h/[serverId]/settings redirects to /settings/hosts/[serverId]", async ({ page }) => {
    const serverId = getServerId();
    await gotoAppShell(page);
    await page.goto(`/h/${encodeURIComponent(serverId)}/settings`);
    await expect(page).toHaveURL(
      new RegExp(`/settings/hosts/${escapeRegex(encodeURIComponent(serverId))}$`),
    );
  });

  test("the + Add host button opens the add-host method modal", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);

    await page.getByTestId("settings-add-host").click();
    await expect(page.getByText("Add connection", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Direct connection" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Paste pairing link" })).toBeVisible();
  });

  test("direct connection advanced URI round-trips SSL and password into the form", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await openSettings(page);

    await page.getByTestId("settings-add-host").click();
    await page.getByRole("button", { name: "Direct connection" }).click();

    await page.getByTestId("direct-host-advanced-toggle").click();
    await page
      .getByTestId("direct-host-uri-input")
      .fill("tcp://example.paseo.test:7443?ssl=true&password=shared-secret");
    await page.getByTestId("direct-host-advanced-toggle").click();

    await expect(page.getByTestId("direct-host-input")).toHaveValue("example.paseo.test");
    await expect(page.getByTestId("direct-port-input")).toHaveValue("7443");
    await expect(page.getByTestId("direct-ssl-toggle-checked")).toBeVisible();
    await expect(page.getByTestId("direct-password-input")).toHaveValue("shared-secret");
    await expect(page.getByTestId("direct-host-uri-input")).toHaveCount(0);

    await page.getByTestId("direct-host-advanced-toggle").click();
    await expect(page.getByTestId("direct-host-uri-input")).toHaveValue(
      "tcp://example.paseo.test:7443?ssl=true&password=shared-secret",
    );
    await page.getByTestId("direct-host-advanced-toggle").click();
    await expect(page.getByTestId("direct-host-uri-input")).toHaveCount(0);
  });

  test("sidebar shows a Back to workspace row that leaves /settings", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);

    const backRow = page.getByTestId("settings-back-to-workspace");
    await expect(backRow).toBeVisible();

    await backRow.click();
    await expect(page).not.toHaveURL(/\/settings(\/|$)/);
  });
});

test.describe("Settings — compact master-detail", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  async function openCompactSettingsRoot(page: Page) {
    await gotoAppShell(page);
    // Wait for bootstrap to settle on a host route so storeReady is true before
    // we navigate into the protected settings stack. A direct page.goto("/settings")
    // on a cold load is eaten by Stack.Protected while bootstrap is still running.
    await expect(page).toHaveURL(/\/h\/|\/welcome/, { timeout: 15000 });

    // Drive navigation the same way a user would: open the mobile drawer and tap
    // the Settings footer icon. This preserves the in-app router state instead of
    // triggering a full reload through Stack.Protected.
    await page.getByRole("button", { name: "Open menu", exact: true }).first().click();
    const sidebarSettingsButton = page.locator('[data-testid="sidebar-settings"]:visible').first();
    await expect(sidebarSettingsButton).toBeVisible();
    await sidebarSettingsButton.click();

    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  }

  async function expectCompactSettingsRootList(page: Page) {
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByTestId("settings-sidebar")).toBeVisible();

    await expect(page.getByText("Theme", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Play test" })).toHaveCount(0);
    await expect(page.locator('[data-testid^="settings-host-page-"]')).toHaveCount(0);
  }

  test("/settings renders only the sidebar list (no section content)", async ({ page }) => {
    await openCompactSettingsRoot(page);

    // Sidebar rows are present.
    await expect(
      page.getByTestId("settings-sidebar").getByRole("button", { name: "General", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByTestId("settings-sidebar")
        .getByRole("button", { name: "Diagnostics", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByTestId("settings-sidebar").getByRole("button", { name: "About", exact: true }),
    ).toBeVisible();

    // Section detail content is NOT rendered at the root.
    await expectCompactSettingsRootList(page);

    const rootBackButton = page.getByRole("button", { name: "Back", exact: true });
    await expect(rootBackButton).toBeVisible();
    await rootBackButton.click();
    await expect(page).not.toHaveURL(/\/settings(\/|$)/);
  });

  test("tapping a section pushes /settings/[section] and shows a back button", async ({ page }) => {
    await openCompactSettingsRoot(page);

    await page
      .getByTestId("settings-sidebar")
      .getByRole("button", { name: "Diagnostics", exact: true })
      .click();
    await expect(page).toHaveURL(/\/settings\/diagnostics$/);
    await expect(page.getByRole("button", { name: "Play test" })).toBeVisible();
    // Sidebar is no longer visible — we are on a detail screen.
    // (Expo Router stack keeps the previous screen in the DOM but hidden; check
    // only visible instances.)
    await expect(page.locator('[data-testid="settings-sidebar"]:visible')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Back", exact: true })).toBeVisible();
  });

  test("back from a section detail returns to the /settings list", async ({ page }) => {
    await openCompactSettingsRoot(page);

    await page
      .getByTestId("settings-sidebar")
      .getByRole("button", { name: "About", exact: true })
      .click();
    await expect(page).toHaveURL(/\/settings\/about$/);

    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expectCompactSettingsRootList(page);
    await expect(page.getByRole("button", { name: "Back", exact: true })).toBeVisible();
  });

  test("tapping a host entry pushes /settings/hosts/[serverId]", async ({ page }) => {
    const serverId = getServerId();
    await openCompactSettingsRoot(page);

    await page.getByTestId(`settings-host-entry-${serverId}`).click();
    await expect(page).toHaveURL(
      new RegExp(`/settings/hosts/${escapeRegex(encodeURIComponent(serverId))}$`),
    );
    await expect(page.getByTestId(`settings-host-page-${serverId}`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Back", exact: true })).toBeVisible();
    await expect(page.locator('[data-testid="settings-sidebar"]:visible')).toHaveCount(0);
  });

  test("back from a host detail returns to the /settings list", async ({ page }) => {
    const serverId = getServerId();
    await openCompactSettingsRoot(page);

    await page.getByTestId(`settings-host-entry-${serverId}`).click();
    await expect(page).toHaveURL(
      new RegExp(`/settings/hosts/${escapeRegex(encodeURIComponent(serverId))}$`),
    );

    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  });
});
