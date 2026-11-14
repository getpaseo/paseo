import { expect, type Page } from "@playwright/test";
import { buildCreateAgentPreferences, buildSeededHost, TEST_HOST_LABEL } from "./daemon-registry";
import { getServerId } from "./server-id";
import { expectAppRoute } from "./route-assertions";
import {
  buildSettingsHostSectionRoute,
  buildSettingsRoute,
  buildSettingsSectionRoute,
} from "@/utils/host-routes";

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
  chat: "Chat",
  appearance: "Appearance",
  sidebar: "Sidebar",
  editor: "Editor",
  files: "Files",
  terminal: "Terminal",
  browser: "Browser",
  shortcuts: "Shortcuts",
  integrations: "Integrations",
  permissions: "Permissions",
  diagnostics: "Diagnostics",
  about: "About",
} as const;

export type SettingsSection = keyof typeof SECTION_LABELS;

type HostSection =
  | "projects"
  | "connections"
  | "pair-device"
  | "agents"
  | "metadata"
  | "voice"
  | "workspaces"
  | "providers"
  | "usage"
  | "terminals"
  | "plugins"
  | "host";

export async function openSettingsSection(page: Page, section: SettingsSection): Promise<void> {
  const sidebar = page.getByTestId("settings-sidebar");
  await expect(sidebar).toBeVisible();

  await sidebar.getByRole("button", { name: SECTION_LABELS[section], exact: true }).click();
  await expectAppRoute(page, buildSettingsSectionRoute(section));
}

export async function revealSettingsSidebarSection(
  page: Page,
  section: SettingsSection,
): Promise<number> {
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("button", { name: SECTION_LABELS[section], exact: true })
    .scrollIntoViewIfNeeded();
  const offset = await page
    .getByTestId("settings-sidebar-scroll-body")
    .evaluate((node) => node.scrollTop);
  expect(offset).toBeGreaterThan(0);
  return offset;
}

export async function expectSettingsSidebarScrollSettled(
  page: Page,
  offset: number,
): Promise<void> {
  // RN Web emits its final scroll callback 100 ms after scrolling stops.
  await page.waitForTimeout(200);
  await expectSettingsSidebarScrollOffset(page, offset);
}

export async function selectSettingsHostSectionsRapidly(page: Page): Promise<void> {
  for (let selection = 0; selection < 5; selection += 1) {
    await page
      .getByRole("navigation", { name: "Settings" })
      .getByRole("button", { name: "Providers", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "Settings" })
      .getByRole("button", { name: "Terminals", exact: true })
      .click();
    await expectSettingsHeader(page, "Terminals");
  }
}

export async function scrollSettingsSidebarUp(page: Page, pixels: number): Promise<void> {
  await page.getByTestId("settings-sidebar-scroll-body").hover();
  await page.mouse.wheel(0, -pixels);
}

export async function changeSettingsInterfaceFontSize(page: Page, size: number): Promise<void> {
  const input = page.getByRole("textbox", { name: "Interface font size" });
  await input.fill(String(size));
  await input.press("Tab");
  await expect(input).toHaveValue(String(size));
  await expect(
    page.getByRole("navigation", { name: "Settings" }).getByText("Appearance", { exact: true }),
  ).toHaveCSS("font-size", `${size}px`);
}

export async function changeSettingsInterfaceFontSizeKeepingSidebarPosition(
  page: Page,
  size: number,
): Promise<number> {
  const navigation = page.getByRole("navigation", { name: "Settings" });
  const anchor = navigation.getByRole("button", { name: "About", exact: true });
  const before = await anchor.evaluate((node) => ({
    top: node.getBoundingClientRect().top,
    height: node.getBoundingClientRect().height,
  }));
  await changeSettingsInterfaceFontSize(page, size);
  // Larger fonts reflow rows. Preserve the visible destination, rather than its old pixel offset.
  await expect
    .poll(() =>
      anchor.evaluate((node, top) => Math.abs(node.getBoundingClientRect().top - top), before.top),
    )
    .toBeLessThan(before.height);
  const offset = await page
    .getByTestId("settings-sidebar-scroll-body")
    .evaluate((node) => node.scrollTop);
  expect(offset).toBeGreaterThan(0);
  return offset;
}

export async function scrollSettingsSidebarToEnd(page: Page): Promise<number> {
  const scrollBody = page.locator('[data-testid="settings-sidebar-scroll-body"]:visible');
  await scrollBody.hover();
  await page.mouse.wheel(0, 2000);
  await expect
    .poll(() =>
      scrollBody.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop),
    )
    .toBe(0);
  const offset = await scrollBody.evaluate((node) => node.scrollTop);
  expect(offset).toBeGreaterThan(0);
  return offset;
}

export async function expectSettingsSidebarScrollOffset(page: Page, offset: number): Promise<void> {
  const scrollBody = page.locator('[data-testid="settings-sidebar-scroll-body"]:visible');
  await expect.poll(() => scrollBody.evaluate((node) => node.scrollTop)).toBe(offset);
}

export async function scrollSettingsDetailDown(page: Page): Promise<number> {
  const scrollBody = page.getByTestId("settings-detail-scroll-body");
  await expect
    .poll(() => scrollBody.evaluate((node) => node.scrollHeight - node.clientHeight))
    .toBeGreaterThan(0);
  await scrollBody.hover();
  await page.mouse.wheel(0, 1000);
  await expect.poll(() => scrollBody.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  const offset = await scrollBody.evaluate((node) => node.scrollTop);
  return offset;
}

export async function expectSettingsDetailScrollOffset(page: Page, offset: number): Promise<void> {
  const scrollBody = page.getByTestId("settings-detail-scroll-body");
  await expect.poll(() => scrollBody.evaluate((node) => node.scrollTop)).toBe(offset);
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
  await expectAppRoute(page, buildSettingsHostSectionRoute(serverId, section));
}

export async function expectSettingsHeader(page: Page, title: string): Promise<void> {
  await expect(page.getByTestId("page-title")).toHaveText(title);
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

export async function addDirectHostFromSettings(
  page: Page,
  input: { host: string; port: number; password?: string },
): Promise<void> {
  await openAddHostFlow(page);
  await selectHostConnectionType(page, "direct");
  await page.getByTestId("direct-host-input").fill(input.host);
  await page.getByTestId("direct-port-input").fill(String(input.port));
  if (input.password) {
    await page.getByTestId("direct-password-input").fill(input.password);
  }
  await page.getByTestId("direct-host-submit").click();
  await expect(page.getByTestId("add-host-modal")).toHaveCount(0, { timeout: 30_000 });
}

export async function toggleHostAdvanced(page: Page): Promise<void> {
  await page.getByTestId("direct-host-advanced-toggle").click();
}

export async function openCompactSettings(page: Page, expectedStartRoute: string): Promise<void> {
  await expectAppRoute(page, expectedStartRoute, { timeout: 15_000 });
  await page.getByRole("button", { name: "Open menu", exact: true }).first().click();
  const settingsButton = page.locator('[data-testid="sidebar-settings"]:visible').first();
  await expect(settingsButton).toBeVisible();
  await settingsButton.click();
  await expectAppRoute(page, buildSettingsRoute());
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
  const preferences = buildCreateAgentPreferences();

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
  await page.locator('[data-testid="settings-host-picker"]:visible').click();
  await page.locator(`[data-testid="settings-host-picker-item-${serverId}"]:visible`).click();
}

export async function expectSettingsHostPickerLabel(page: Page, label: string): Promise<void> {
  await expect(
    page.getByTestId("settings-host-picker").getByText(label, { exact: true }),
  ).toBeVisible();
}

export async function expectCompactSettingsList(page: Page): Promise<void> {
  await expectAppRoute(page, buildSettingsRoute());
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
  sections: SettingsSection[],
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
  await expectAppRoute(page, buildSettingsRoute());
}

export async function expectSettingsBackButton(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeVisible();
}

export async function clickSettingsBackToWorkspace(page: Page): Promise<void> {
  await page.getByTestId("settings-back-to-workspace").click();
}

export async function expectHostSettingsUrl(page: Page, serverId: string): Promise<void> {
  await expectAppRoute(page, buildSettingsHostSectionRoute(serverId, "connections"));
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
  await expect(page.getByRole("checkbox", { name: "Use SSL", exact: true })).toBeChecked();
  await expect(page.getByTestId("direct-ssl-toggle-checked")).toBeVisible();
}

export async function fillDirectHostAddress(page: Page, host: string, port: string): Promise<void> {
  await page.getByRole("textbox", { name: "Host", exact: true }).fill(host);
  await page.getByRole("textbox", { name: "Port", exact: true }).fill(port);
}

export async function toggleDirectHostSsl(page: Page): Promise<void> {
  await page.getByRole("checkbox", { name: "Use SSL", exact: true }).click();
}

export async function expectDirectHostSslDisabled(page: Page): Promise<void> {
  await expect(page.getByRole("checkbox", { name: "Use SSL", exact: true })).not.toBeChecked();
  await expect(page.getByTestId("direct-ssl-toggle-checked")).toHaveCount(0);
}

export async function expectDirectHostUriValue(page: Page, uri: string): Promise<void> {
  await expect(page.getByTestId("direct-host-uri-input")).toHaveValue(uri);
}

export async function expectDirectHostUriHidden(page: Page): Promise<void> {
  await expect(page.getByTestId("direct-host-uri-input")).toHaveCount(0);
}

export async function expectDiagnosticsContent(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Run" })).toBeVisible();
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

function idleAgentReleaseSwitch(page: Page) {
  return page
    .getByTestId("host-page-idle-runtime-cleanup-card")
    .getByRole("switch", { name: "Release idle agents" });
}

export async function expectIdleAgentRelease(page: Page, enabled: boolean): Promise<void> {
  const toggle = idleAgentReleaseSwitch(page);
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute("aria-checked", String(enabled));
}

export async function setIdleAgentRelease(page: Page, enabled: boolean): Promise<void> {
  const toggle = idleAgentReleaseSwitch(page);
  await expect(toggle).toHaveAttribute("aria-checked", String(!enabled));
  await toggle.click();
  await expectIdleAgentRelease(page, enabled);
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
  await page.getByRole("button", { name: `Add ${providerName}`, exact: true }).click();
}

export async function expectProviderInstalledInSettings(
  page: Page,
  providerName: string,
): Promise<void> {
  await expect(
    page.getByRole("button", { name: `${providerName} provider details`, exact: true }),
  ).toBeVisible();
}

export async function expectHostNoDaemonLifecycleRow(page: Page): Promise<void> {
  await expect(page.getByTestId("host-page-daemon-lifecycle-card")).toHaveCount(0);
}

export async function expectRetiredSidebarSectionsAbsent(page: Page): Promise<void> {
  const sidebar = page.getByTestId("settings-sidebar");
  await expect(sidebar).toBeVisible();

  // App group rows remain top-level.
  await expect(sidebar.getByRole("button", { name: "General", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Diagnostics", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "About", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Daemon", exact: true })).toHaveCount(0);

  // Host group rows are now flat top-level sections (no drill-in).
  await expect(sidebar.getByTestId("settings-host-section-connections")).toBeVisible();
  await expect(sidebar.getByTestId("settings-host-section-projects")).toBeVisible();
  await expect(sidebar.getByTestId("settings-host-section-agents")).toBeVisible();
  await expect(sidebar.getByTestId("settings-host-section-workspaces")).toBeVisible();
  await expect(sidebar.getByTestId("settings-host-section-providers")).toBeVisible();
  await expect(sidebar.getByTestId("settings-host-section-usage")).toBeVisible();
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
  // open) that surfaces the local host by its label. The per-row connection
  // endpoint only appears on dropdown rows in the multi-host case, which this
  // fixture does not exercise.
  const picker = sidebar.getByTestId("settings-host-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByText(TEST_HOST_LABEL, { exact: true })).toBeVisible();
}

export async function expectHostRejectedWithReAddGuidance(
  page: Page,
  reason: string,
): Promise<void> {
  const error = page.getByTestId("host-connection-error");
  await expect(error).toContainText(reason);
  await expect(error).toContainText(
    "Remove this host and add it again with the password this daemon asks for.",
  );
}

export async function expectNoHostPasswordControls(page: Page): Promise<void> {
  await expect(page.getByText("Password", { exact: true })).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: /password/i })).toHaveCount(0);
}

export async function removeHostFromHostPage(page: Page, serverId: string): Promise<void> {
  await page.getByTestId("host-page-remove-host-button").click();
  await page.getByTestId("remove-host-confirm").click();
  await expect(page).not.toHaveURL(new RegExp(`/settings/hosts/${serverId}`));
}

export async function expectHostOnlineWithoutError(page: Page): Promise<void> {
  await expect(page.getByTestId("host-page-identity")).toContainText("Online");
  await expect(page.getByTestId("host-connection-error")).toHaveCount(0);
}

function restartRecoverySwitch(page: Page) {
  return page.getByRole("switch", { name: "Resume agents after restart", exact: true });
}

function restartRecoveryEditButton(page: Page) {
  return page.getByRole("button", { name: "Edit prompt", exact: true });
}

export async function setRestartRecoveryEnabled(page: Page, enabled: boolean) {
  const toggle = restartRecoverySwitch(page);
  await toggle.click();
  await expectRestartRecoveryEnabled(page, enabled);
}

// The prompt is only editable while restart recovery is on.
export async function expectRestartRecoveryEnabled(page: Page, enabled: boolean) {
  await expect(restartRecoverySwitch(page)).toBeChecked({ checked: enabled });
  await expect(restartRecoveryEditButton(page)).toBeEnabled({ enabled });
}

export async function editRestartRecoveryPrompt(page: Page, prompt: string) {
  await restartRecoveryEditButton(page).click();
  const sheet = page.getByTestId("host-page-restart-recovery-sheet");
  await sheet.getByRole("textbox", { name: "Resume prompt", exact: true }).fill(prompt);
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await expect(sheet).toHaveCount(0);
}

export async function expectRestartRecoveryPrompt(page: Page, prompt: string) {
  await restartRecoveryEditButton(page).click();
  const sheet = page.getByTestId("host-page-restart-recovery-sheet");
  await expect(sheet.getByRole("textbox", { name: "Resume prompt", exact: true })).toHaveValue(
    prompt,
  );
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(sheet).toHaveCount(0);
}

export async function revealSettingsSyntaxTheme(page: Page) {
  await page.getByLabel(/Highlight theme:/).scrollIntoViewIfNeeded();
  const offset = await page
    .getByTestId("settings-detail-scroll-body")
    .evaluate((node) => node.scrollTop);
  expect(offset).toBeGreaterThan(0);
  const keywordColor = await page
    .getByRole("img", { name: "Live preview of content typography, syntax theme, and code font" })
    .getByText("export", { exact: true })
    .first()
    .evaluate((node) => getComputedStyle(node).color);
  return { offset, keywordColor };
}

export async function changeSettingsSyntaxTheme(page: Page, theme: string): Promise<void> {
  await page.getByLabel(/Highlight theme:/).click();
  await page.getByRole("menuitem", { name: theme, exact: true }).click();
  await expect(page.getByLabel(`Highlight theme: ${theme}`, { exact: true })).toBeVisible();
}

export async function expectSettingsSyntaxColorChanged(
  page: Page,
  previousColor: string,
): Promise<void> {
  await expect(
    page
      .getByRole("img", { name: "Live preview of content typography, syntax theme, and code font" })
      .getByText("export", { exact: true })
      .first(),
  ).not.toHaveCSS("color", previousColor);
}

export async function changeSettingsTypography(page: Page): Promise<void> {
  const input = page.getByRole("textbox", { name: "Interface font size", exact: true });
  await input.fill("18");
  await input.press("Enter");
  await expect(input).toHaveValue("18");
  await expect(input).toHaveCSS("font-size", "18px");
  await expect(page.getByText("Code size", { exact: true })).toHaveCSS("font-size", "18px");
  const navigation = page.getByRole("navigation", { name: "Settings" });
  await expect(navigation.getByText("Appearance", { exact: true })).toHaveCSS("font-size", "18px");
  await expect(navigation.getByText("Providers", { exact: true })).toHaveCSS("font-size", "18px");
  await expect(page.getByText("Dracula", { exact: true })).toHaveCSS("font-size", "18px");
  const familyInput = page.getByRole("textbox", { name: "Code font family", exact: true });
  await familyInput.fill("Courier New, Courier, monospace");
  await familyInput.press("Enter");
  const codeInput = page.getByRole("textbox", { name: "Code font size", exact: true });
  await codeInput.fill("16");
  await codeInput.press("Enter");
  await expect(codeInput).toHaveValue("16");
  const preview = page.getByRole("img", {
    name: "Live preview of content typography, syntax theme, and code font",
  });
  await expect(preview.getByText("export", { exact: true }).first()).toHaveCSS("font-size", "16px");
  await expect(preview.getByText("export", { exact: true }).first()).toHaveCSS(
    "line-height",
    "24px",
  );
  await expect(preview.getByText("export", { exact: true }).first()).toHaveCSS(
    "font-family",
    /Courier/,
  );
  const contentInput = page.getByRole("textbox", { name: "Content font size", exact: true });
  await contentInput.fill("20");
  await contentInput.press("Enter");
  await expect(preview.getByText("Readable content and code preview", { exact: true })).toHaveCSS(
    "font-size",
    "20px",
  );
}

export async function normalizeSettingsFontSizes(page: Page): Promise<void> {
  for (const [name, minimum, maximum] of [
    ["Interface font size", "10", "21"],
    ["Content font size", "10", "21"],
    ["Code font size", "9", "22"],
  ] as const) {
    const input = page.getByRole("textbox", { name, exact: true });
    await input.fill("999");
    await input.press("Enter");
    await expect(input).toHaveValue(maximum);
    // Clamp again when the saved value is already at the maximum.
    await input.fill("999");
    await input.press("Tab");
    await expect(input).toHaveValue(maximum);
    await input.fill("");
    await input.press("Enter");
    await expect(input).toHaveValue(maximum);
    await input.fill("1");
    await input.press("Enter");
    await expect(input).toHaveValue(minimum);
    await input.fill("1");
    await input.press("Tab");
    await expect(input).toHaveValue(minimum);
  }
}

/** Sample actual paints, including the first workspace frame after Settings. */
export async function captureCompactSidebarReturn(page: Page, returnAction: () => Promise<void>) {
  await page.evaluate(() => {
    const capture = {
      frames: [] as {
        time: number;
        pathname: string;
        sidebarVisible: boolean;
        settingsVisible: boolean;
        closeX: number | null;
      }[],
      stopped: false,
    };
    Object.assign(window, { __sidebarFrameCapture: capture });
    const start = performance.now();
    function sample() {
      if (capture.stopped) return;
      const close = document.querySelector('[data-testid="sidebar-close"]');
      capture.frames.push({
        time: performance.now() - start,
        pathname: location.pathname,
        settingsVisible:
          document
            .querySelector('[data-testid="settings-sidebar"]')
            ?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ?? false,
        sidebarVisible:
          (close?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ?? false) &&
          close!.getBoundingClientRect().x >= 0 &&
          close!.getBoundingClientRect().right <= innerWidth,
        closeX: close?.getBoundingClientRect().x ?? null,
      });
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
  await returnAction();
  return page.evaluate(async () => {
    const capture = (
      window as typeof window & {
        __sidebarFrameCapture: {
          frames: {
            time: number;
            pathname: string;
            sidebarVisible: boolean;
            settingsVisible: boolean;
            closeX: number | null;
          }[];
          stopped: boolean;
        };
      }
    ).__sidebarFrameCapture;
    await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    capture.stopped = true;
    return capture.frames;
  });
}

export async function captureCompactSidebarContext(page: Page) {
  const sidebar = await page.getByTestId("sidebar-project-workspace-list-scroll").elementHandle();
  if (!sidebar) throw new Error("Open sidebar has no workspace list");
  await expect
    .poll(() => sidebar.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(0);
  const offset = await sidebar.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
  expect(offset).toBeGreaterThan(0);
  return async () => {
    expect(await sidebar.evaluate((el) => el.isConnected)).toBe(true);
    expect(await sidebar.evaluate((el) => el.scrollTop)).toBe(offset);
    await sidebar.dispose();
  };
}

export async function expectCompactSidebarOpen(page: Page) {
  await expect(page.getByRole("button", { name: "Close sidebar", exact: true })).toBeInViewport();
}

export async function closeCompactSidebar(page: Page) {
  await page.getByRole("button", { name: "Close sidebar", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Open menu", exact: true }).first(),
  ).toBeInViewport();
}

export async function openSettingsFromCompactSidebar(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expectAppRoute(page, buildSettingsRoute());
  await expectCompactSettingsList(page);
}
