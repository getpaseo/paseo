import { test } from "./fixtures";
import { gotoAppShell, openSettings } from "./helpers/app";
import { getE2EDaemonPort } from "./helpers/daemon-port";
import { TEST_HOST_LABEL } from "./helpers/daemon-registry";
import { getServerId } from "./helpers/server-id";
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
  expectHostNoLocalOnlyRows,
  expectRetiredSidebarSectionsAbsent,
  expectHostPageVisible,
  expectLocalHostEntryFirst,
} from "./helpers/settings";

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
    await expectSettingsHeader(page, "Host");
    await expectHostLabelDisplayed(page);
    await expectHostActionCards(page, serverId);
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

  test("host section does not render pair-device or daemon-lifecycle rows for a remote daemon", async ({
    page,
  }) => {
    const serverId = getServerId();

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, serverId);
    await openHostSection(page, serverId, "host");

    // TODO: add local-daemon fixture for positive Pair/Daemon coverage.
    await expectHostNoLocalOnlyRows(page);
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

  test("sidebar pins the local daemon host first with a Local marker", async ({ page }) => {
    const serverId = getServerId();

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
