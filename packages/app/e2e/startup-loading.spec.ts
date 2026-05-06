import { test } from "./fixtures";
import { startupScenario } from "./helpers/startup-dsl";

function getE2EDaemonPort(): string {
  const port = process.env.E2E_DAEMON_PORT;
  if (!port) {
    throw new Error("E2E_DAEMON_PORT is not set.");
  }
  return port;
}

function getE2EServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set.");
  }
  return serverId;
}

test.describe("Startup loading presentation", () => {
  test("mobile reconnect keeps connection recovery actions visible", async ({ page }) => {
    const startup = await startupScenario(page)
      .withMobileViewport()
      .withSavedHost({
        serverId: "srv_unreachable_mobile",
        label: "Dev",
        endpoint: "127.0.0.1:45678",
      })
      .openRoot();

    await startup.expectsReconnectWelcome();
    await startup.expectsNoSavedHostStatus({ label: "Dev" });
    await startup.expectsNoLocalServerStartupCopy();
  });

  test("desktop daemon bootstrap keeps the local server startup copy desktop-only", async ({
    page,
  }) => {
    const startup = await startupScenario(page)
      .withPendingDesktopDaemon()
      .withBlockedPort(getE2EDaemonPort())
      .openRoot();

    await startup.expectsDesktopDaemonStartup();
    await startup.expectsSidebarHidden();
    await startup.expectsNoUndefinedRoute();
  });

  test("host-route refresh does not render route chrome around the bootstrap splash", async ({
    page,
  }) => {
    const serverId = getE2EServerId();
    const startup = await startupScenario(page)
      .withPendingDesktopDaemon()
      .withBlockedPort(getE2EDaemonPort())
      .openHostWorkspace({
        serverId,
        workspaceId: "workspace-1",
      });

    await startup.expectsDesktopDaemonStartup();
    await startup.expectsSidebarHidden();
  });
});
