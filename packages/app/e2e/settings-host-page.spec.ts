import { test, expect, type Page } from "./fixtures";
import { gotoAppShell, openSettings } from "./helpers/app";
import { TEST_HOST_LABEL } from "./helpers/daemon-registry";
import { expectSettingsHeader, openSettingsHost } from "./helpers/settings";

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

async function expectHostLabelHeader(page: Page) {
  await expectSettingsHeader(page, TEST_HOST_LABEL);
  await expect(page.getByTestId("host-page-label-edit-button")).toBeVisible();
  await expect(page.getByTestId("host-page-label-input")).toHaveCount(0);
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

    // Label renders in the detail header with a pencil edit affordance; the input is hidden until edit.
    await expectHostLabelHeader(page);

    // Connections is its own section with a "Connections" heading and the seeded endpoint row.
    const connectionsCard = page.getByTestId("host-page-connections-card");
    await expect(connectionsCard).toBeVisible();
    await expect(page.getByText("Connections", { exact: true })).toBeVisible();
    await expect(
      connectionsCard.getByText(new RegExp(`TCP \\((localhost|127\\.0\\.0\\.1):${port}\\)`)),
    ).toBeVisible();

    const injectMcpCard = page.getByTestId("host-page-inject-mcp-card");
    await expect(injectMcpCard).toBeVisible();
    await expect(injectMcpCard.getByRole("switch", { name: "Inject Paseo tools" })).toBeVisible();

    await expect(page.getByTestId("host-page-restart-card")).toBeVisible();
    await expect(page.getByTestId("host-page-restart-button")).toBeVisible();
    await expect(page.getByTestId("host-page-providers-card")).toBeVisible();
    await expect(page.getByTestId("host-page-remove-host-card")).toBeVisible();
    await expect(page.getByTestId("host-page-remove-host-button")).toBeVisible();
  });

  test("clicking the label pencil reveals the inline editor", async ({ page }) => {
    const serverId = getSeededServerId();

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, serverId);

    await expect(page.getByTestId("host-page-label-input")).toHaveCount(0);

    await page.getByTestId("host-page-label-edit-button").click();

    await expect(page.getByTestId("host-page-label-input")).toBeVisible();
    await expect(page.getByTestId("host-page-label-input")).toHaveValue(TEST_HOST_LABEL);
    await expect(page.getByTestId("host-page-label-save")).toBeVisible();
  });

  test("host page does not render pair-device or daemon-lifecycle rows for a remote daemon", async ({
    page,
  }) => {
    const serverId = getSeededServerId();

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, serverId);

    // TODO: add local-daemon fixture for positive Pair/Daemon coverage.
    // Pair-device now lives behind a row that only the local host sees
    // (gated by useIsLocalDaemon); the seeded host is remote, so it must
    // not appear. The daemon-lifecycle card is still local-host only.
    await expect(page.getByTestId("host-page-pair-device-row")).toHaveCount(0);
    await expect(page.getByTestId("host-page-daemon-lifecycle-card")).toHaveCount(0);
  });

  test("settings sidebar does not expose retired top-level sections", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);

    const sidebar = page.getByTestId("settings-sidebar");
    await expect(sidebar).toBeVisible();

    await expect(sidebar.getByRole("button", { name: "Hosts", exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole("button", { name: "Providers", exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole("button", { name: "Pair device", exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole("button", { name: "Daemon", exact: true })).toHaveCount(0);

    await expect(sidebar.getByRole("button", { name: "General", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("button", { name: "Diagnostics", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("button", { name: "About", exact: true })).toBeVisible();
  });

  test("navigating to /settings/hosts/[serverId] directly renders the host page", async ({
    page,
  }) => {
    const serverId = getSeededServerId();

    await gotoAppShell(page);
    await page.goto(`/settings/hosts/${encodeURIComponent(serverId)}`);

    await expect(page.getByTestId(`settings-host-page-${serverId}`)).toBeVisible();
    await expectHostLabelHeader(page);
    await expect(page.getByTestId("host-page-remove-host-card")).toBeVisible();
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

    const sidebar = page.getByTestId("settings-sidebar");
    await expect(sidebar).toBeVisible({ timeout: 15000 });

    const hostEntries = sidebar.locator('[data-testid^="settings-host-entry-"]');
    await expect(hostEntries.first()).toHaveAttribute(
      "data-testid",
      `settings-host-entry-${serverId}`,
    );

    const localHostEntry = page.getByTestId(`settings-host-entry-${serverId}`);
    await expect(localHostEntry.getByTestId("settings-host-local-marker")).toBeVisible();
    await expect(localHostEntry.getByText("Local", { exact: true })).toBeVisible();
  });
});
