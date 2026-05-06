import { test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import {
  loadRealDaemonState,
  injectDesktopBridge,
  openDesktopSettings,
  expectUpdateBanner,
  clickInstallUpdate,
  expectInstallInProgress,
  interceptDaemonManagementConfirmDialog,
  toggleDaemonManagement,
  expectDaemonManagementConfirmDialog,
  expectDaemonManagementEnabled,
  expectDaemonManagementDisabled,
  expectDaemonStatusPid,
  expectDaemonStatusLogPath,
  expectDaemonStatusVersion,
} from "./helpers/desktop-updates";

function getSeededServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set (expected from Playwright globalSetup).");
  }
  return serverId;
}

// No Playwright Electron runner exists; we simulate the desktop bridge via
// addInitScript so Electron-gated UI activates without a real Electron process.
test.describe("Desktop updates", () => {
  test("update banner appears in the sidebar when an app update is available", async ({ page }) => {
    await injectDesktopBridge(page, {
      serverId: getSeededServerId(),
      updateAvailable: true,
      latestVersion: "1.2.3",
    });
    await gotoAppShell(page);

    await expectUpdateBanner(page, "1.2.3");
  });

  test("clicking install shows the installing state on the callout", async ({ page }) => {
    await injectDesktopBridge(page, {
      serverId: getSeededServerId(),
      updateAvailable: true,
      latestVersion: "1.2.3",
      slowInstall: true,
    });
    await gotoAppShell(page);

    await expectUpdateBanner(page, "1.2.3");
    await clickInstallUpdate(page);
    await expectInstallInProgress(page);
  });
});

test.describe("Desktop daemon management", () => {
  test("disabling built-in daemon management shows confirm dialog with correct copy", async ({
    page,
  }) => {
    const serverId = getSeededServerId();
    await injectDesktopBridge(page, {
      serverId,
      manageBuiltInDaemon: true,
      confirmShouldAccept: false,
    });
    await gotoAppShell(page);
    await openDesktopSettings(page, serverId);

    const dialogArgs = await interceptDaemonManagementConfirmDialog(page);
    expectDaemonManagementConfirmDialog(dialogArgs);

    await expectDaemonManagementEnabled(page);
  });

  test("cancelling the confirm dialog leaves the daemon management toggle on", async ({ page }) => {
    const serverId = getSeededServerId();
    await injectDesktopBridge(page, {
      serverId,
      manageBuiltInDaemon: true,
      confirmShouldAccept: false,
    });
    await gotoAppShell(page);
    await openDesktopSettings(page, serverId);

    await expectDaemonManagementEnabled(page);
    await toggleDaemonManagement(page, "disable");
    await expectDaemonManagementEnabled(page);
  });

  test("confirming the dialog disables built-in daemon management", async ({ page }) => {
    const serverId = getSeededServerId();
    await injectDesktopBridge(page, {
      serverId,
      manageBuiltInDaemon: true,
      confirmShouldAccept: true,
    });
    await gotoAppShell(page);
    await openDesktopSettings(page, serverId);

    await toggleDaemonManagement(page, "disable");

    await expectDaemonManagementDisabled(page);
  });

  test("daemon status panel renders version, PID, and log path from the real daemon", async ({
    page,
  }) => {
    const serverId = getSeededServerId();
    const realState = await loadRealDaemonState();
    await injectDesktopBridge(page, {
      serverId,
      manageBuiltInDaemon: false,
      daemonPid: realState.pid,
      daemonVersion: realState.version,
      daemonLogPath: realState.logPath,
    });
    await gotoAppShell(page);
    await openDesktopSettings(page, serverId);

    await expectDaemonStatusVersion(page, realState.version);
    await expectDaemonStatusPid(page, realState.pid);
    await expectDaemonStatusLogPath(page, realState.logPath);
  });

  test("stopping and restarting the daemon updates the PID", async ({ page }) => {
    const serverId = getSeededServerId();
    const realState = await loadRealDaemonState();
    await injectDesktopBridge(page, {
      serverId,
      manageBuiltInDaemon: true,
      daemonPid: realState.pid,
      daemonVersion: realState.version,
      daemonLogPath: realState.logPath,
      confirmShouldAccept: true,
    });
    await gotoAppShell(page);
    await openDesktopSettings(page, serverId);

    await expectDaemonStatusPid(page, realState.pid);

    await toggleDaemonManagement(page, "disable");
    await expectDaemonManagementDisabled(page);
    await expectDaemonStatusPid(page, null);

    await toggleDaemonManagement(page, "enable");
    await expectDaemonManagementEnabled(page);
    const newPid = realState.pid !== null ? realState.pid + 1000 : 11000;
    await expectDaemonStatusPid(page, newPid);
  });
});
