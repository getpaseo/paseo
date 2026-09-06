import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { TEST_HOST_LABEL } from "../support/helpers/daemon-registry";
import { getServerId } from "../support/helpers/server-id";
import {
  expectSettingsHeader,
  openSettingsHost,
  openHostSection,
  expectHostLabelDisplayed,
  clickEditHostLabel,
  expectHostLabelEditMode,
  expectHostConnectionsCard,
  expectHostInjectMcpCard,
  expectHostActionCards,
  expectHostProvidersCard,
  expectHostNoDaemonLifecycleRow,
  expectRetiredSidebarSectionsAbsent,
  expectHostPageVisible,
  seedSavedSettingsHosts,
} from "../support/helpers/settings";

test.describe("Settings host page", () => {
  test("connections section shows the seeded connection endpoint", async ({ page }) => {
    const serverId = getServerId();
    const port = getE2EDaemonPort();

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, serverId);

    await expectSettingsHeader(page, "Connections");
    await expectHostConnectionsCard(page, port);
  });

  test("relay settings validate, persist, restart, and reconnect through the GUI", async ({
    page,
    relaySettingsDaemon,
  }) => {
    await seedSavedSettingsHosts(page, [
      {
        serverId: relaySettingsDaemon.serverId,
        label: "relay settings host",
        endpoint: `127.0.0.1:${relaySettingsDaemon.port}`,
      },
    ]);
    await page.reload();
    await openSettings(page);
    await openSettingsHost(page, relaySettingsDaemon.serverId);

    const relayCard = page.getByTestId("host-page-relay-card");
    await expect(relayCard).toContainText("Daemon endpoint: 127.0.0.1:9");
    await expect(relayCard).toContainText("Public endpoint: 127.0.0.1:9");
    await page.getByTestId("host-page-relay-configure-button").click();

    const endpointInput = page.getByTestId("relay-endpoint-input");
    const publicEndpointInput = page.getByTestId("relay-public-endpoint-input");
    const saveButton = page.getByTestId("relay-settings-save-button");
    await endpointInput.fill("relay.example.com/path:443");
    await expect(saveButton).toBeDisabled();

    await endpointInput.fill("127.0.0.1:10");
    await publicEndpointInput.fill("relay.e2e.example:7443");
    await expect(saveButton).toHaveText("Save and restart");
    await saveButton.click();

    await expect(page.getByTestId("relay-settings-modal")).toHaveCount(0, { timeout: 30_000 });
    await expect(relayCard).toContainText("Daemon endpoint: 127.0.0.1:10");
    await expect(relayCard).toContainText("Public endpoint: relay.e2e.example:7443");
  });

  test("relay settings stay unavailable when the daemon lacks endpoint configuration", async ({
    page,
    relayConfigOutdatedDaemon,
  }) => {
    await seedSavedSettingsHosts(page, [relayConfigOutdatedDaemon]);
    await page.reload();
    await openSettings(page);
    await openSettingsHost(page, relayConfigOutdatedDaemon.serverId);

    const relayCard = page.getByTestId("host-page-relay-card");
    await expect(relayCard).toContainText("Update this host to configure relay endpoints");
    await expect(page.getByTestId("host-page-relay-configure-button")).toBeDisabled();
  });

  test("relay settings keep a save failure visible and retryable", async ({
    page,
    relaySettingsDaemon,
  }) => {
    await seedSavedSettingsHosts(page, [
      {
        serverId: relaySettingsDaemon.serverId,
        label: "relay settings failure host",
        endpoint: `127.0.0.1:${relaySettingsDaemon.port}`,
      },
    ]);
    await page.reload();
    await openSettings(page);
    await openSettingsHost(page, relaySettingsDaemon.serverId);
    await page.getByTestId("host-page-relay-configure-button").click();
    await page.getByTestId("relay-endpoint-input").fill("127.0.0.1:11");

    const configPath = path.join(relaySettingsDaemon.paseoHome, "config.json");
    await rename(configPath, `${configPath}.blocked`);
    await mkdir(configPath);
    await page.getByTestId("relay-settings-save-button").click();

    const error = page.getByTestId("relay-settings-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("Unable to save relay settings:");
    await expect(page.getByTestId("relay-settings-save-button")).toBeEnabled();
    await expect(page.getByTestId("relay-settings-modal")).toBeVisible();
  });

  test("agents section shows the inject MCP toggle", async ({ page }) => {
    const serverId = getServerId();

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, serverId);

    await openHostSection(page, serverId, "agents");
    await expectSettingsHeader(page, "Agents");
    await expectHostInjectMcpCard(page);
  });

  test("providers section shows the providers card", async ({ page }) => {
    const serverId = getServerId();

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, serverId);

    await expectHostProvidersCard(page, serverId);
    await expectSettingsHeader(page, "Providers");
  });

  test("host section shows the host label and restart/remove action cards", async ({ page }) => {
    const serverId = getServerId();

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, serverId);

    await openHostSection(page, serverId, "host");
    await expectSettingsHeader(page, "Overview");
    await expectHostLabelDisplayed(page);
    await expectHostActionCards(page, serverId);
  });

  test("a failed remote daemon update remains visible in the host UI", async ({
    page,
    outdatedDaemon,
  }) => {
    await seedSavedSettingsHosts(page, [outdatedDaemon]);
    await page.reload();
    await openSettings(page);
    await openSettingsHost(page, outdatedDaemon.serverId);
    await openHostSection(page, outdatedDaemon.serverId, "host");

    page.once("dialog", (dialog) => dialog.accept());
    const updateButton = page.getByTestId("host-page-update-button");
    await updateButton.click();

    await expect(
      updateButton.filter({ hasText: /Preparing update|Downloading packages|Installing/ }),
    ).toBeDisabled();

    const updateFailure = page.getByTestId("host-page-update-error");
    await expect(updateFailure).toBeVisible();
    await expect(updateFailure).toContainText("Update failed");
    await expect(updateFailure).toContainText("Failed to update the daemon:");
    await expect(updateButton).toBeEnabled();
  });

  test("clicking the label pencil reveals the inline editor", async ({ page }) => {
    const serverId = getServerId();

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, serverId);
    await openHostSection(page, serverId, "host");

    await expectHostLabelDisplayed(page);
    await clickEditHostLabel(page);
    await expectHostLabelEditMode(page, TEST_HOST_LABEL);
  });

  test("host section does not render daemon lifecycle controls for a remote daemon", async ({
    page,
  }) => {
    const serverId = getServerId();

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, serverId);
    await openHostSection(page, serverId, "host");

    // TODO: add a local-daemon fixture for positive daemon lifecycle coverage.
    await expectHostNoDaemonLifecycleRow(page);
  });

  test("settings sidebar exposes the flat App and Host section rows", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);

    await expectRetiredSidebarSectionsAbsent(page);
  });

  test("navigating to /settings/hosts/[serverId] redirects to the connections section", async ({
    page,
  }) => {
    const serverId = getServerId();

    await gotoAppShell(page);
    await page.goto(`/settings/hosts/${encodeURIComponent(serverId)}`);

    await expectHostPageVisible(page, serverId);
    await expectSettingsHeader(page, "Connections");
    await openHostSection(page, serverId, "host");
    await expectHostLabelDisplayed(page);
    await expectHostActionCards(page, serverId);
  });
});
