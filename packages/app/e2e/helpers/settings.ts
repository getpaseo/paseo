import { expect, type Page } from "@playwright/test";

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
