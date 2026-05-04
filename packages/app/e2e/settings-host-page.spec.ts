import { test } from "./fixtures";
import { gotoAppShell, openSettings } from "./helpers/app";
import { TEST_HOST_LABEL } from "./helpers/daemon-registry";
import {
  expectSettingsHeader,
  openSettingsHost,
  expectHostLabelDisplayed,
  clickEditHostLabel,
  expectHostLabelEditMode,
  expectHostConnectionsCard,
  expectHostInjectMcpCard,
  expectHostActionCards,
  expectHostNoLocalOnlyRows,
  expectRetiredSidebarSectionsAbsent,
  expectHostPageVisible,
  expectLocalHostEntryFirst,
} from "./helpers/settings";

function getSeededServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set (expected from Playwright globalSetup).");
  }
  return serverId;
}

function getSeededDaemonPort(): string {
  const port = process.env.E2E_DAEMON_PORT;
  if (!port) {
    throw new Error("E2E_DAEMON_PORT is not set (expected from Playwright globalSetup).");
  }
  return port;
}

test.describe("Settings host page", () => {
  test("host page shows seeded label, connection endpoint, inject MCP toggle, and all action rows", async ({
    page,
  }) => {
    const serverId = getSeededServerId();
    const port = getSeededDaemonPort();

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, serverId);

    await expectSettingsHeader(page, TEST_HOST_LABEL);
    await expectHostLabelDisplayed(page);
    await expectHostConnectionsCard(page, port);
    await expectHostInjectMcpCard(page);
    await expectHostActionCards(page);
  });

  test("clicking the label pencil reveals the inline editor", async ({ page }) => {
    const serverId = getSeededServerId();

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, serverId);

    await expectHostLabelDisplayed(page);
    await clickEditHostLabel(page);
    await expectHostLabelEditMode(page, TEST_HOST_LABEL);
  });

  test("host page does not render pair-device or daemon-lifecycle rows for a remote daemon", async ({
    page,
  }) => {
    const serverId = getSeededServerId();

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, serverId);

    // TODO: add local-daemon fixture for positive Pair/Daemon coverage.
    await expectHostNoLocalOnlyRows(page);
  });

  test("settings sidebar does not expose retired top-level sections", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);

    await expectRetiredSidebarSectionsAbsent(page);
  });

  test("navigating to /settings/hosts/[serverId] directly renders the host page", async ({
    page,
  }) => {
    const serverId = getSeededServerId();

    await gotoAppShell(page);
    await page.goto(`/settings/hosts/${encodeURIComponent(serverId)}`);

    await expectHostPageVisible(page, serverId);
    await expectSettingsHeader(page, TEST_HOST_LABEL);
    await expectHostLabelDisplayed(page);
    await expectHostActionCards(page);
  });

  test("sidebar pins the local daemon host first with a Local marker", async ({ page }) => {
    const serverId = getSeededServerId();

    // Simulate the Electron desktop bridge so `useIsLocalDaemon` resolves the
    // seeded host to the local daemon. `manageBuiltInDaemon: false` (returned
    // from get_desktop_settings) bypasses the desktop bootstrap flow so only
    // the sidebar's status query runs against the seeded test daemon.
    await page.addInitScript((localServerId) => {
      (window as unknown as { paseoDesktop: unknown }).paseoDesktop = {
        platform: "darwin",
        invoke: async (command: string) => {
          if (command === "desktop_daemon_status") {
            return {
              serverId: localServerId,
              status: "running",
              listen: null,
              hostname: null,
              pid: null,
              home: "",
              version: null,
              desktopManaged: true,
              error: null,
            };
          }
          if (command === "get_desktop_settings") {
            return {
              releaseChannel: "stable",
              daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: true },
            };
          }
          return null;
        },
        getPendingOpenProject: async () => null,
        events: { on: async () => () => undefined },
      };
    }, serverId);

    await gotoAppShell(page);
    await openSettings(page);
    await expectLocalHostEntryFirst(page, serverId);
  });
});
