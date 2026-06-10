import { expect, type Page } from "@playwright/test";
import { buildCreateAgentPreferences, buildSeededHost, TEST_HOST_LABEL } from "./daemon-registry";
import { escapeRegex } from "./regex";
import { getServerId } from "./server-id";

const DISABLE_DEFAULT_SEED_ONCE_KEY = "@paseo:e2e-disable-default-seed-once";
const SEED_NONCE_KEY = "@paseo:e2e-seed-nonce";
const REGISTRY_KEY = "@paseo:daemon-registry";

interface SavedSettingsHostInput {
  serverId: string;
  label: string;
  endpoint: string;
}

const SECTION_LABELS = {
  general: "General",
  appearance: "Appearance",
  shortcuts: "Shortcuts",
  integrations: "Integrations",
  permissions: "Permissions",
  diagnostics: "Diagnostics",
  about: "About",
} as const;

export type SettingsSection = keyof typeof SECTION_LABELS | "projects";

type HostSection = "connections" | "agents" | "workspaces" | "providers" | "host";

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
  // Host sections are now flat top-level rows under the Host group. Navigate by
  // clicking the Connections section row; the picker only matters when >1 host.
  await page.getByTestId("settings-host-section-connections").click();
  await expectHostSettingsUrl(page, serverId);
  await expect(page.getByTestId("host-page-connections-card")).toBeVisible();
}

export async function openSettingsHostSection(
  page: Page,
  serverId: string,
  section: HostSection,
): Promise<void> {
  await page.getByTestId(`settings-host-section-${section}`).click();
  await expect(page).toHaveURL(
    new RegExp(`/settings/hosts/${escapeRegex(encodeURIComponent(serverId))}/${section}$`),
  );
}

export async function expectSettingsHeader(page: Page, title: string): Promise<void> {
  await expect(page.getByTestId("settings-detail-header-title")).toHaveText(title);
}

export async function openAddHostFlow(page: Page): Promise<void> {
  // "Add host" is now an item inside the host picker (a Combobox); open the
  // picker first, then pick it. The picker renders whenever a host exists.
  await page.getByTestId("settings-host-picker").click();
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

export async function seedSavedSettingsHosts(
  page: Page,
  hosts: SavedSettingsHostInput[],
): Promise<void> {
  await page.goto("/");
  const nowIso = new Date().toISOString();
  const registry = hosts.map((host) =>
    buildSeededHost({
      serverId: host.serverId,
      label: host.label,
      endpoint: host.endpoint,
      nowIso,
    }),
  );
  const firstHost = registry[0];
  if (!firstHost) {
    throw new Error("Expected at least one settings host fixture.");
  }
  const preferences = buildCreateAgentPreferences(firstHost.serverId);

  await page.evaluate(
    ({ keys, storedRegistry, storedPreferences }) => {
      const nonce = localStorage.getItem(keys.seedNonce);
      if (!nonce) {
        throw new Error("Expected e2e seed nonce before overriding settings host registry.");
      }

      localStorage.setItem(keys.registry, JSON.stringify(storedRegistry));
      localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(storedPreferences));
      localStorage.setItem(keys.disableDefaultSeedOnce, nonce);
    },
    {
      keys: {
        disableDefaultSeedOnce: DISABLE_DEFAULT_SEED_ONCE_KEY,
        registry: REGISTRY_KEY,
        seedNonce: SEED_NONCE_KEY,
      },
      storedRegistry: registry,
      storedPreferences: preferences,
    },
  );
}

export async function selectSettingsHost(page: Page, serverId: string): Promise<void> {
  await page.getByTestId("settings-host-picker").click();
  await page.getByTestId(`settings-host-picker-item-${serverId}`).click();
}

export async function expectSettingsHostPickerLabel(page: Page, label: string): Promise<void> {
  await expect(
    page.getByTestId("settings-host-picker").getByText(label, { exact: true }),
  ).toBeVisible();
}

export async function expectCompactSettingsList(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await expect(page.getByText("Theme", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Play test" })).toHaveCount(0);
  await expect(page.getByTestId("host-page-connections-card")).toHaveCount(0);
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

export async function closeCompactSettings(page: Page): Promise<void> {
  await goBackInSettings(page);
  await expect(page).not.toHaveURL(/\/settings(\/|$)/);
}

export async function removeCurrentHostFromSettings(page: Page): Promise<void> {
  await page.getByTestId("host-page-remove-host-button").click();
  await expect(page.getByTestId("remove-host-confirm-modal")).toBeVisible();
  await page.getByTestId("remove-host-confirm").click();
  await expect(page).toHaveURL(/\/settings$/);
}

export async function expectSettingsBackButton(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeVisible();
}

export async function clickSettingsBackToWorkspace(page: Page): Promise<void> {
  await page.getByTestId("settings-back-to-workspace").click();
}

export async function expectHostSettingsUrl(page: Page, serverId: string): Promise<void> {
  await expect(page).toHaveURL(
    new RegExp(`/settings/hosts/${escapeRegex(encodeURIComponent(serverId))}/connections$`),
  );
}

export async function verifyLegacyHostSettingsRedirect(page: Page): Promise<void> {
  const serverId = getServerId();
  await page.goto(`/h/${encodeURIComponent(serverId)}/settings`);
  await expectHostSettingsUrl(page, serverId);
}

export async function openCompactSettingsHost(page: Page): Promise<void> {
  const serverId = getServerId();
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
  await expect(page.getByText("App version", { exact: true }).first()).toBeVisible();
}

export async function expectGeneralContent(page: Page): Promise<void> {
  await expect(page.getByText("Default send", { exact: true }).first()).toBeVisible();
}

export async function expectAppearanceContent(page: Page): Promise<void> {
  await expect(page.getByText("Highlight theme", { exact: true }).first()).toBeVisible();
}

export async function expectHostLabelDisplayed(page: Page): Promise<void> {
  await expect(page.getByTestId("host-page-label-edit-button")).toBeVisible();
  await expect(page.getByTestId("host-page-rename-modal-input")).toHaveCount(0);
}

export async function clickEditHostLabel(page: Page): Promise<void> {
  await page.getByTestId("host-page-label-edit-button").click();
}

export async function expectHostLabelEditMode(page: Page, expectedLabel: string): Promise<void> {
  await expect(page.getByTestId("host-page-rename-modal-input")).toBeVisible();
  await expect(page.getByTestId("host-page-rename-modal-input")).toHaveValue(expectedLabel);
  await expect(page.getByTestId("host-page-rename-modal-submit")).toBeVisible();
}

export async function expectHostConnectionsCard(page: Page, port: string): Promise<void> {
  const card = page.getByTestId("host-page-connections-card");
  await expect(card).toBeVisible();
  // "Connections" appears three times on this page: the sidebar section row, the
  // detail header title, and the SettingsSection heading above the card. Match
  // the first to keep the heading assertion without tripping Playwright strict
  // mode.
  await expect(page.getByText("Connections", { exact: true }).first()).toBeVisible();
  await expect(
    card.getByText(new RegExp(`TCP \\((localhost|127\\.0\\.0\\.1):${port}\\)`)),
  ).toBeVisible();
}

export async function expectHostInjectMcpCard(page: Page): Promise<void> {
  const card = page.getByTestId("host-page-inject-mcp-card");
  await expect(card).toBeVisible();
  await expect(card.getByRole("switch", { name: "Inject Paseo tools" })).toBeVisible();
}

export async function openHostSection(
  page: Page,
  serverId: string,
  section: HostSection,
): Promise<void> {
  await openSettingsHostSection(page, serverId, section);
}

export async function expectHostActionCards(page: Page, serverId: string): Promise<void> {
  // Restart + remove cards live on the Host section; providers moved to its
  // own Providers section (asserted via expectHostProvidersCard).
  await openSettingsHostSection(page, serverId, "host");
  await expect(page.getByTestId("host-page-restart-card")).toBeVisible();
  await expect(page.getByTestId("host-page-restart-button")).toBeVisible();
  await expect(page.getByTestId("host-page-remove-host-card")).toBeVisible();
  await expect(page.getByTestId("host-page-remove-host-button")).toBeVisible();
}

export async function expectHostProvidersCard(page: Page, serverId: string): Promise<void> {
  await openSettingsHostSection(page, serverId, "providers");
  await expect(page.getByTestId("host-page-providers-card")).toBeVisible();
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

export async function openAddProviderArea(page: Page): Promise<void> {
  await page.getByTestId("host-page-add-provider-card").scrollIntoViewIfNeeded();
  await expect(page.getByRole("textbox", { name: "Search providers" })).toBeVisible();
}

export async function findAcpCatalogProvider(page: Page, providerName: string): Promise<void> {
  await page.getByRole("textbox", { name: "Search providers" }).fill(providerName);
  await expect(page.getByText(providerName, { exact: true })).toBeVisible();
}

export async function installAcpCatalogProvider(page: Page, providerName: string): Promise<void> {
  await findAcpCatalogProvider(page, providerName);
  await page.getByRole("button", { name: "Add", exact: true }).click();
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

  // App group rows remain top-level.
  await expect(sidebar.getByRole("button", { name: "General", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Diagnostics", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "About", exact: true })).toBeVisible();

  // Host group rows are now flat top-level sections (no drill-in).
  await expect(sidebar.getByTestId("settings-host-section-connections")).toBeVisible();
  await expect(sidebar.getByTestId("settings-host-section-agents")).toBeVisible();
  await expect(sidebar.getByTestId("settings-host-section-workspaces")).toBeVisible();
  await expect(sidebar.getByTestId("settings-host-section-providers")).toBeVisible();
  await expect(sidebar.getByTestId("settings-host-section-host")).toBeVisible();

  // The old per-host entry rows are replaced by the host picker.
  await expect(sidebar.locator('[data-testid^="settings-host-entry-"]')).toHaveCount(0);
}

export async function expectHostPageVisible(page: Page, _serverId: string): Promise<void> {
  await expect(page.getByTestId("host-page-connections-card")).toBeVisible();
}

export async function expectLocalHostEntryFirst(page: Page, _serverId: string): Promise<void> {
  const sidebar = page.getByTestId("settings-sidebar");
  await expect(sidebar).toBeVisible({ timeout: 15_000 });

  // Single-host fixture: the picker is a non-interactive chip (no dropdown to
  // open) that surfaces the local host by its label. The "Local" marker only
  // appears on dropdown rows in the multi-host case, which this fixture does not
  // exercise.
  const picker = sidebar.getByTestId("settings-host-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByText(TEST_HOST_LABEL, { exact: true })).toBeVisible();
}
