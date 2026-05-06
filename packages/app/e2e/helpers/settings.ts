import { expect, type Page } from "@playwright/test";
import { requireServerId } from "./sidebar";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SECTION_LABELS = {
  general: "General",
  shortcuts: "Shortcuts",
  integrations: "Integrations",
  permissions: "Permissions",
  diagnostics: "Diagnostics",
  about: "About",
} as const;

export type SettingsSection = keyof typeof SECTION_LABELS | "projects";

export async function openSettingsSection(page: Page, section: SettingsSection): Promise<void> {
  const sidebar = page.getByTestId("settings-sidebar");
  await expect(sidebar).toBeVisible();

  if (section === "projects") {
    await page.getByTestId("settings-projects").click();
    await expect(page).toHaveURL(/\/settings\/projects$/);
    return;
  }

  await sidebar.getByRole("button", { name: SECTION_LABELS[section], exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/settings/${section}$`));
}

export async function openSettingsHost(page: Page, serverId: string): Promise<void> {
  await page.getByTestId(`settings-host-entry-${serverId}`).click();
  await expect(page.getByTestId(`settings-host-page-${serverId}`)).toBeVisible();
}

export async function expectSettingsHeader(page: Page, title: string): Promise<void> {
  await expect(page.getByTestId("settings-detail-header-title")).toHaveText(title);
}

export async function openAddHostFlow(page: Page): Promise<void> {
  await page.getByTestId("settings-add-host").click();
  await expect(page.getByText("Add connection", { exact: true })).toBeVisible();
}

export async function selectHostConnectionType(
  page: Page,
  type: "direct" | "relay",
): Promise<void> {
  const label = type === "direct" ? "Direct connection" : "Paste pairing link";
  await page.getByRole("button", { name: label }).click();
}

export async function toggleHostAdvanced(page: Page): Promise<void> {
  await page.getByTestId("direct-host-advanced-toggle").click();
}

export async function openCompactSettings(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/h\/|\/welcome/, { timeout: 15000 });
  await page.getByRole("button", { name: "Open menu", exact: true }).first().click();
  const settingsButton = page.locator('[data-testid="sidebar-settings"]:visible').first();
  await expect(settingsButton).toBeVisible();
  await settingsButton.click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
}

export async function expectCompactSettingsList(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await expect(page.getByText("Theme", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Play test" })).toHaveCount(0);
  await expect(page.locator('[data-testid^="settings-host-page-"]')).toHaveCount(0);
}

export async function expectSettingsSidebarVisible(page: Page): Promise<void> {
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
}

export async function expectSettingsSidebarHidden(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="settings-sidebar"]:visible')).toHaveCount(0);
}

export async function expectSettingsSidebarSections(
  page: Page,
  sections: Array<Exclude<SettingsSection, "projects">>,
): Promise<void> {
  const sidebar = page.getByTestId("settings-sidebar");
  for (const section of sections) {
    await expect(
      sidebar.getByRole("button", { name: SECTION_LABELS[section], exact: true }),
    ).toBeVisible();
  }
}

export async function goBackInSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Back", exact: true }).click();
}

export async function expectSettingsBackButton(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeVisible();
}

export async function clickSettingsBackToWorkspace(page: Page): Promise<void> {
  await page.getByTestId("settings-back-to-workspace").click();
}

export async function expectHostSettingsUrl(page: Page, serverId: string): Promise<void> {
  await expect(page).toHaveURL(
    new RegExp(`/settings/hosts/${escapeRegex(encodeURIComponent(serverId))}$`),
  );
}

export async function verifyLegacyHostSettingsRedirect(page: Page): Promise<void> {
  const serverId = requireServerId();
  await page.goto(`/h/${encodeURIComponent(serverId)}/settings`);
  await expectHostSettingsUrl(page, serverId);
}

export async function openCompactSettingsHost(page: Page): Promise<void> {
  const serverId = requireServerId();
  await openSettingsHost(page, serverId);
  await expectHostSettingsUrl(page, serverId);
}

export async function expectAddHostMethodOptions(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Direct connection" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Paste pairing link" })).toBeVisible();
}

export async function fillDirectHostUri(page: Page, uri: string): Promise<void> {
  await page.getByTestId("direct-host-uri-input").fill(uri);
}

export async function expectDirectHostFormValues(
  page: Page,
  fields: { host: string; port: string; password: string },
): Promise<void> {
  await expect(page.getByTestId("direct-host-input")).toHaveValue(fields.host);
  await expect(page.getByTestId("direct-port-input")).toHaveValue(fields.port);
  await expect(page.getByTestId("direct-password-input")).toHaveValue(fields.password);
}

export async function expectDirectHostSslEnabled(page: Page): Promise<void> {
  await expect(page.getByTestId("direct-ssl-toggle-checked")).toBeVisible();
}

export async function expectDirectHostUriValue(page: Page, uri: string): Promise<void> {
  await expect(page.getByTestId("direct-host-uri-input")).toHaveValue(uri);
}

export async function expectDirectHostUriHidden(page: Page): Promise<void> {
  await expect(page.getByTestId("direct-host-uri-input")).toHaveCount(0);
}

export async function expectDiagnosticsContent(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Play test" })).toBeVisible();
}

export async function expectAboutContent(page: Page): Promise<void> {
  await expect(page.getByText("Version", { exact: true }).first()).toBeVisible();
}

export async function expectGeneralContent(page: Page): Promise<void> {
  await expect(page.getByText("Theme", { exact: true }).first()).toBeVisible();
}

export async function expectHostLabelDisplayed(page: Page): Promise<void> {
  await expect(page.getByTestId("host-page-label-edit-button")).toBeVisible();
  await expect(page.getByTestId("host-page-label-input")).toHaveCount(0);
}

export async function clickEditHostLabel(page: Page): Promise<void> {
  await page.getByTestId("host-page-label-edit-button").click();
}

export async function expectHostLabelEditMode(page: Page, expectedLabel: string): Promise<void> {
  await expect(page.getByTestId("host-page-label-input")).toBeVisible();
  await expect(page.getByTestId("host-page-label-input")).toHaveValue(expectedLabel);
  await expect(page.getByTestId("host-page-label-save")).toBeVisible();
}

export async function expectHostConnectionsCard(page: Page, port: string): Promise<void> {
  const card = page.getByTestId("host-page-connections-card");
  await expect(card).toBeVisible();
  await expect(page.getByText("Connections", { exact: true })).toBeVisible();
  await expect(
    card.getByText(new RegExp(`TCP \\((localhost|127\\.0\\.0\\.1):${port}\\)`)),
  ).toBeVisible();
}

export async function expectHostInjectMcpCard(page: Page): Promise<void> {
  const card = page.getByTestId("host-page-inject-mcp-card");
  await expect(card).toBeVisible();
  await expect(card.getByRole("switch", { name: "Inject Paseo tools" })).toBeVisible();
}

export async function expectHostActionCards(page: Page): Promise<void> {
  await expect(page.getByTestId("host-page-restart-card")).toBeVisible();
  await expect(page.getByTestId("host-page-restart-button")).toBeVisible();
  await expect(page.getByTestId("host-page-providers-card")).toBeVisible();
  await expect(page.getByTestId("host-page-remove-host-card")).toBeVisible();
  await expect(page.getByTestId("host-page-remove-host-button")).toBeVisible();
}

export async function serveJson(page: Page, url: string, body: unknown): Promise<void> {
  await page.route(url, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

export async function openAddProviderModal(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Search providers" })).toBeVisible();
}

export async function findAcpCatalogProvider(page: Page, providerName: string): Promise<void> {
  await page.getByRole("textbox", { name: "Search providers" }).fill(providerName);
  await expect(page.getByText(providerName, { exact: true })).toBeVisible();
}

export async function installAcpCatalogProvider(page: Page, providerName: string): Promise<void> {
  await findAcpCatalogProvider(page, providerName);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Search providers" })).toHaveCount(0);
}

export async function expectProviderInstalledInSettings(
  page: Page,
  providerName: string,
): Promise<void> {
  await expect(
    page.getByRole("button", { name: `${providerName} provider details`, exact: true }),
  ).toBeVisible();
}

export async function expectHostNoLocalOnlyRows(page: Page): Promise<void> {
  await expect(page.getByTestId("host-page-pair-device-row")).toHaveCount(0);
  await expect(page.getByTestId("host-page-daemon-lifecycle-card")).toHaveCount(0);
}

export async function expectRetiredSidebarSectionsAbsent(page: Page): Promise<void> {
  const sidebar = page.getByTestId("settings-sidebar");
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Hosts", exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: "Providers", exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: "Pair device", exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: "Daemon", exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: "General", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Diagnostics", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "About", exact: true })).toBeVisible();
}

export async function expectHostPageVisible(page: Page, serverId: string): Promise<void> {
  await expect(page.getByTestId(`settings-host-page-${serverId}`)).toBeVisible();
}

export async function expectLocalHostEntryFirst(page: Page, serverId: string): Promise<void> {
  const sidebar = page.getByTestId("settings-sidebar");
  await expect(sidebar).toBeVisible({ timeout: 15_000 });
  await expect(sidebar.locator('[data-testid^="settings-host-entry-"]').first()).toHaveAttribute(
    "data-testid",
    `settings-host-entry-${serverId}`,
  );
  const localHostEntry = page.getByTestId(`settings-host-entry-${serverId}`);
  await expect(localHostEntry.getByTestId("settings-host-local-marker")).toBeVisible();
  await expect(localHostEntry.getByText("Local", { exact: true })).toBeVisible();
}
