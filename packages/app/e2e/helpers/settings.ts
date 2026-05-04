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
