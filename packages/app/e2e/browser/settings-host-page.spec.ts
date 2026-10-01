import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { TEST_HOST_LABEL } from "../support/helpers/daemon-registry";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
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
  expectHostResourcePolicyCard,
  expectHostActionCards,
  expectHostProvidersCard,
  expectHostNoDaemonLifecycleRow,
  expectRetiredSidebarSectionsAbsent,
  expectHostPageVisible,
  seedSavedSettingsHosts,
  selectSettingsHost,
  expectHostRejectedWithReAddGuidance,
  expectNoHostPasswordControls,
  removeHostFromHostPage,
  addDirectHostFromSettings,
  expectHostOnlineWithoutError,
} from "../support/helpers/settings";

test.describe("Settings host page", () => {
  test("visits host settings and opens the label editor", async ({ page }) => {
    const serverId = getServerId();
    const port = getE2EDaemonPort();
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, serverId);
    await test.step("connections section shows the seeded connection endpoint", async () => {
      await expectSettingsHeader(page, "Connections");
      await expectHostConnectionsCard(page, port);
    });
    await test.step("agents section shows the inject MCP toggle", async () => {
      await openHostSection(page, serverId, "agents");
      await expectSettingsHeader(page, "Agents");
      await expectHostInjectMcpCard(page);
    });
    await test.step("agents section shows the resource policy control", async () => {
      await expectHostResourcePolicyCard(page);
    });
    await test.step("providers section shows the providers card", async () => {
      await expectHostProvidersCard(page, serverId);
      await expectSettingsHeader(page, "Providers");
    });
    await test.step("host section shows the host label and restart/remove action cards", async () => {
      await openHostSection(page, serverId, "host");
      await expectSettingsHeader(page, "Overview");
      await expectHostLabelDisplayed(page);
      await expectHostActionCards(page, serverId);
    });
    await test.step("clicking the label pencil reveals the inline editor", async () => {
      await openHostSection(page, serverId, "host");

      await expectHostLabelDisplayed(page);
      await clickEditHostLabel(page);
      await expectHostLabelEditMode(page, TEST_HOST_LABEL);
      await page.keyboard.press("Escape");
    });
    await test.step("host section does not render daemon lifecycle controls for a remote daemon", async () => {
      await openHostSection(page, serverId, "host");

      await expectHostNoDaemonLifecycleRow(page);
    });
    await test.step("settings sidebar exposes the flat App and Host section rows", async () => {
      await expectRetiredSidebarSectionsAbsent(page);
    });
  });

  test("schedules can be enabled with Economy and remain enabled after reload", async ({
    page,
  }, testInfo) => {
    const serverId = getServerId();
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, serverId);
    await openHostSection(page, serverId, "agents");

    const card = page.getByTestId("host-page-resource-policy-card");
    const economy = card.getByTestId("host-page-resource-policy-economy");
    const schedules = card.getByTestId("host-page-schedule-automation-switch");

    await economy.click();
    await expect(economy).toHaveAttribute("aria-selected", "true");
    await expect(schedules).toHaveAttribute("aria-checked", "false");
    await schedules.click();
    await expect(schedules).toHaveAttribute("aria-checked", "true");

    await page.reload();
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, serverId);
    await openHostSection(page, serverId, "agents");

    const reloadedCard = page.getByTestId("host-page-resource-policy-card");
    await expect(reloadedCard.getByTestId("host-page-resource-policy-economy")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const reloadedSchedules = reloadedCard.getByTestId("host-page-schedule-automation-switch");
    await expect(reloadedSchedules).toHaveAttribute("aria-checked", "true");
    const screenshotPath = testInfo.outputPath("schedules-enabled-under-economy.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach("schedules-enabled-under-economy", {
      path: screenshotPath,
      contentType: "image/png",
    });

    await reloadedCard.getByTestId("host-page-resource-policy-balanced").click();
    await expect(reloadedCard.getByTestId("host-page-resource-policy-balanced")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await reloadedSchedules.click();
    await expect(reloadedSchedules).toHaveAttribute("aria-checked", "false");
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

  test("a host rejected for its password reconnects after being removed and added again with it", async ({
    page,
  }) => {
    const password = "e2e host password";
    const daemon = await startIsolatedHostDaemon("srv_e2e_password_host", {
      environment: { ...process.env, PASEO_PASSWORD: password },
    });
    try {
      await seedSavedSettingsHosts(page, [
        {
          serverId: getServerId(),
          label: TEST_HOST_LABEL,
          endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
        },
        {
          serverId: daemon.serverId,
          label: "Password host",
          endpoint: `127.0.0.1:${daemon.port}`,
        },
      ]);
      await page.reload();
      await openSettings(page);
      await selectSettingsHost(page, daemon.serverId);
      await openHostSection(page, daemon.serverId, "host");

      await test.step("the host page shows the reason and the re-add guidance, with no password UI", async () => {
        await expectHostRejectedWithReAddGuidance(page, "Password required");
        await expectNoHostPasswordControls(page);
      });

      await test.step("removing the host and adding it again with the password brings it online", async () => {
        await removeHostFromHostPage(page, daemon.serverId);
        await addDirectHostFromSettings(page, { host: "127.0.0.1", port: daemon.port, password });
        await openHostSection(page, daemon.serverId, "host");
        await expectHostOnlineWithoutError(page);
      });
    } finally {
      await daemon.close();
    }
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

  test("explains shared System One decisions and Jev browser automation", async ({ page }) => {
    const serverId = getServerId();
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, serverId);

    await openHostSection(page, serverId, "system-one");
    await expectSettingsHeader(page, "System One");
    await expect(page.getByTestId("host-system-one-settings")).toBeVisible();
    await expect(page.getByText("Jev / System One", { exact: true })).toBeVisible();
    await expect(page.getByText("Split decisions", { exact: true })).toBeVisible();
    if (process.env.E2E_SYSTEM_ONE_SCREENSHOT) {
      await page.screenshot({ path: process.env.E2E_SYSTEM_ONE_SCREENSHOT, fullPage: true });
    }

    await openHostSection(page, serverId, "browser");
    await expectSettingsHeader(page, "Browser");
    await expect(page.getByTestId("host-page-browser-tools-card")).toBeVisible();
    await expect(page.getByText("Jev browser goals", { exact: true })).toBeVisible();
    await expect(page.getByText("Start page", { exact: true })).toBeVisible();
    await expect(page.getByText("Import from browser", { exact: true })).toBeVisible();
    if (process.env.E2E_BROWSER_SETTINGS_SCREENSHOT) {
      await page.screenshot({ path: process.env.E2E_BROWSER_SETTINGS_SCREENSHOT, fullPage: true });
    }
  });
});
