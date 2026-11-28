import {
  openGlobalNewWorkspaceComposer,
  fillNewWorkspaceDraft,
  expectNewWorkspaceDraft,
} from "../support/helpers/new-workspace";
import { readFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { TEST_HOST_LABEL } from "../support/helpers/daemon-registry";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { getServerId } from "../support/helpers/server-id";
import {
  expectSettingsHeader,
  expectProviderNotOnHost,
  expectProviderPageLoaded,
  gotoProviderPage,
  openClientHostSettings,
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
  selectSettingsHost,
  expectHostRejectedWithReAddGuidance,
  expectNoHostPasswordControls,
  removeHostFromHostPage,
  addDirectHostFromSettings,
  expectAddHostFieldDrawnAsInput,
  selectHostConnectionType,
  expectHostOnlineWithoutError,
  expectIdleAgentRelease,
  editRestartRecoveryPrompt,
  expectRestartRecoveryEnabled,
  expectRestartRecoveryPrompt,
  setRestartRecoveryEnabled,
  setIdleAgentRelease,
} from "../support/helpers/settings";

test.describe("Settings host page", () => {
  test("visits host settings and opens the label editor", async ({ page }) => {
    const serverId = getServerId();
    const port = getE2EDaemonPort();
    await gotoAppShell(page);
    await openSettings(page);
    await test.step("client host detail shows the seeded connection endpoint and label editor", async () => {
      await openClientHostSettings(page, serverId);
      await expectHostConnectionsCard(page, port);
      await expectHostLabelDisplayed(page);
      await clickEditHostLabel(page);
      await expectHostLabelEditMode(page, TEST_HOST_LABEL);
      await page.keyboard.press("Escape");
    });
    await test.step("tools section shows the inject MCP toggle", async () => {
      await openHostSection(page, serverId, "tools");
      await expectSettingsHeader(page, "Tools & prompts");
      await expectHostInjectMcpCard(page);
    });
    await test.step("providers section shows the providers card", async () => {
      await expectHostProvidersCard(page, serverId);
      await expectSettingsHeader(page, "Providers");
    });
    await test.step("daemon section shows restart and client host shows remove", async () => {
      await openHostSection(page, serverId, "daemon");
      await expectSettingsHeader(page, "Daemon");
      await expectHostActionCards(page, serverId);
    });
    await test.step("daemon section does not render daemon lifecycle controls for a remote daemon", async () => {
      await openHostSection(page, serverId, "daemon");

      await expectHostNoDaemonLifecycleRow(page);
    });
    await test.step("settings sidebar exposes the flat App and Host section rows", async () => {
      await expectRetiredSidebarSectionsAbsent(page);
    });
  });

  test("a failed remote daemon update remains visible in the host UI", async ({
    page,
    outdatedDaemon,
  }) => {
    await seedSavedSettingsHosts(page, [outdatedDaemon]);
    await page.reload();
    await openSettings(page);
    await openSettingsHost(page, outdatedDaemon.serverId);
    await openHostSection(page, outdatedDaemon.serverId, "daemon");

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
      await openClientHostSettings(page, daemon.serverId);

      await test.step("the host page shows the reason and the re-add guidance, with no password UI", async () => {
        await expectHostRejectedWithReAddGuidance(page, "Password required");
        await expectNoHostPasswordControls(page);
      });

      await test.step("removing the host and adding it again with the password brings it online", async () => {
        await removeHostFromHostPage(page, daemon.serverId);
        await addDirectHostFromSettings(page, { host: "127.0.0.1", port: daemon.port, password });
        await openHostSection(page, daemon.serverId, "daemon");
        await expectHostOnlineWithoutError(page);
      });
    } finally {
      await daemon.close();
    }
  });

  test("idle agent release changes live on one host and stays saved without restarting", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const primaryServerId = getServerId();
    const daemon = await startIsolatedHostDaemon("srv_e2e_idle_agent_release");
    const client = await connectDaemonClient<DaemonClient>({
      clientIdPrefix: "idle-release-settings",
      port: daemon.port,
    });
    const originalPid = (await client.getDaemonStatus()).pid;
    const expectLiveSavedSetting = async (enabled: boolean) => {
      const saved = JSON.parse(await readFile(path.join(daemon.paseoHome, "config.json"), "utf8"));
      expect(saved.agents.idleRuntimeCleanup).toBe(enabled);
      expect((await client.getDaemonConfig()).config.idleRuntimeCleanup).toBe(enabled);
      expect((await client.reloadDaemonConfig()).restartRequiredPaths).toEqual([]);
      expect((await client.getDaemonStatus()).pid).toBe(originalPid);
    };
    const hosts = [
      {
        serverId: primaryServerId,
        label: TEST_HOST_LABEL,
        endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
      },
      {
        serverId: daemon.serverId,
        label: "Idle release host",
        endpoint: `127.0.0.1:${daemon.port}`,
      },
    ];
    const openHostAgentsInFreshApp = async (serverId: string) => {
      await seedSavedSettingsHosts(page, hosts);
      await page.reload();
      await openSettings(page);
      await selectSettingsHost(page, serverId);
      await openHostSection(page, serverId, "daemon");
    };
    try {
      await test.step("idle agent release starts on and turns off", async () => {
        await openHostAgentsInFreshApp(daemon.serverId);
        await expectIdleAgentRelease(page, true);
        await setIdleAgentRelease(page, false);
        await expectLiveSavedSetting(false);
      });

      await test.step("a fresh app reads the saved setting from the same running host", async () => {
        await openHostAgentsInFreshApp(daemon.serverId);
        await expectIdleAgentRelease(page, false);
        await expectLiveSavedSetting(false);
        await setIdleAgentRelease(page, true);
        await expectLiveSavedSetting(true);
        await setIdleAgentRelease(page, false);
      });

      await test.step("other hosts keep their own setting", async () => {
        await selectSettingsHost(page, primaryServerId);
        await openHostSection(page, primaryServerId, "daemon");
        await expectIdleAgentRelease(page, true);
        await expectLiveSavedSetting(false);
      });
    } finally {
      await client.close();
      await daemon.close();
    }
  });

  test("a failed idle release save stays visible and retry applies it live", async ({ page }) => {
    const daemon = await startIsolatedHostDaemon("srv_e2e_idle_release_failure");
    const configPath = path.join(daemon.paseoHome, "config.json");
    try {
      await seedSavedSettingsHosts(page, [
        { serverId: daemon.serverId, label: "Failure host", endpoint: `127.0.0.1:${daemon.port}` },
      ]);
      await page.reload();
      await openSettings(page);
      await openHostSection(page, daemon.serverId, "daemon");
      await expectIdleAgentRelease(page, true);
      // A real filesystem failure, with the daemon and RPC path intact.
      await rename(configPath, `${configPath}.saved`);
      await mkdir(configPath);
      await page.getByRole("switch", { name: "Release idle agents" }).click();
      await expect(page.getByTestId("host-page-idle-runtime-cleanup-error")).toContainText(
        "Failed to read",
      );
      await expectIdleAgentRelease(page, true);
      await rm(configPath, { recursive: true });
      await rename(`${configPath}.saved`, configPath);
      await setIdleAgentRelease(page, false);
      await expect(page.getByTestId("host-page-idle-runtime-cleanup-error")).toHaveCount(0);
    } finally {
      await daemon.close();
    }
  });

  test("navigating to /settings/hosts/[serverId] redirects to the daemon section", async ({
    page,
  }) => {
    const serverId = getServerId();

    await gotoAppShell(page);
    await page.goto(`/settings/hosts/${encodeURIComponent(serverId)}`);

    await expectHostPageVisible(page, serverId);
    await expectSettingsHeader(page, "Daemon");
    await expectHostActionCards(page, serverId);
    await expectHostLabelDisplayed(page);
  });
});

test.describe("provider page from its URL", () => {
  test("loads a provider's page on a cold visit", async ({ page }) => {
    await gotoAppShell(page);
    await gotoProviderPage(page, getServerId(), "claude");
    await expectProviderPageLoaded(page, "Claude");
  });

  test("says a provider the host doesn't have isn't on this host", async ({ page }) => {
    await gotoAppShell(page);
    await gotoProviderPage(page, getServerId(), "not-a-provider");
    await expectProviderNotOnHost(page);
  });
});

test("restart recovery defaults off and persists opt-in and custom prompt", async ({ page }) => {
  const serverId = getServerId();
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHost(page, serverId);
  await openHostSection(page, serverId, "daemon");
  await expectRestartRecoveryEnabled(page, false);
  await setRestartRecoveryEnabled(page, true);
  await page.reload();
  await expectRestartRecoveryEnabled(page, true);
  await expectRestartRecoveryPrompt(page, "Resume working.");
  await editRestartRecoveryPrompt(page, "Continue the interrupted work.");
  await setRestartRecoveryEnabled(page, false);
  await page.reload();
  await expectRestartRecoveryEnabled(page, false);
  await setRestartRecoveryEnabled(page, true);
  await expectRestartRecoveryPrompt(page, "Continue the interrupted work.");
  await editRestartRecoveryPrompt(page, "Resume working.");
});

test("sidebar Add host preserves its caller and stays closed after theme changes", async ({
  page,
}) => {
  await gotoAppShell(page);
  await expect(page).toHaveURL(/\/open-project$/);
  const originalUrl = page.url();
  await openSidebarAddHost(page);
  await expect(page).toHaveURL(originalUrl);
  await closeAddHostAndChangeTheme(page);
  await expect(page.getByRole("button", { name: "Direct connection", exact: true })).toBeHidden();
  await expect(page).toHaveURL(originalUrl);
});

async function openSidebarAddHost(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Hosts", exact: true }).click();
  await page.getByRole("button", { name: "Add host", exact: true }).click();
  await expect(page.getByRole("button", { name: "Direct connection", exact: true })).toBeVisible();
}

async function closeAddHostAndChangeTheme(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("button", { name: "Direct connection", exact: true })).toBeHidden();
  await page.keyboard.press("Control+Alt+t");
}

test("Add host draws its text fields as bordered inputs", async ({ page }) => {
  await gotoAppShell(page);

  await test.step("the pairing link field", async () => {
    await openSidebarAddHost(page);
    await selectHostConnectionType(page, "relay");
    await expectAddHostFieldDrawnAsInput(page, "pair-link-input");
    await page.getByTestId("pair-link-cancel").click();
  });

  await test.step("the direct connection fields", async () => {
    await selectHostConnectionType(page, "direct");
    await expectAddHostFieldDrawnAsInput(page, "direct-host-input");
    await expectAddHostFieldDrawnAsInput(page, "direct-port-input");
    await expectAddHostFieldDrawnAsInput(page, "direct-password-input");
  });
});

test("sidebar Add host completes without navigating", async ({ page }) => {
  await gotoAppShell(page);
  await expect(page).toHaveURL(/\/open-project$/);
  const originalUrl = page.url();
  await openSidebarAddHost(page);
  await connectToTestHost(page);
  await expect(page).toHaveURL(originalUrl);
  await expect(page.getByRole("button", { name: "Hosts", exact: true })).toBeVisible();
});

test("Settings Add host opens the saved host detail", async ({ page }) => {
  await gotoAppShell(page);
  await openSettings(page);
  await addDirectHostFromSettings(page, { host: "127.0.0.1", port: Number(getE2EDaemonPort()) });
  await expect(page.getByTestId("host-page-connections-card")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/settings/device-hosts/${getServerId()}$`));
});

test("New workspace Add host preserves the prompt after connecting", async ({ page }) => {
  await gotoAppShell(page);
  await openGlobalNewWorkspaceComposer(page);
  await fillNewWorkspaceDraft(page, "Keep this unfinished prompt while I add a host.");
  const originalUrl = page.url();
  await openNewWorkspaceAddHost(page);
  await expect(page).toHaveURL(originalUrl);
  await connectToTestHost(page);
  await expect(page).toHaveURL(originalUrl);
  await expectNewWorkspaceDraft(page, "Keep this unfinished prompt while I add a host.");
});

async function openNewWorkspaceAddHost(page: import("@playwright/test").Page) {
  await page.getByTestId("host-picker-trigger").click();
  await page.getByRole("button", { name: "Add host", exact: true }).click();
}

async function connectToTestHost(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Direct connection", exact: true }).click();
  await page.getByRole("textbox", { name: "Host", exact: true }).fill("127.0.0.1");
  await page.getByRole("textbox", { name: "Port", exact: true }).fill(String(getE2EDaemonPort()));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByTestId("add-host-modal")).toBeHidden({ timeout: 30_000 });
}
