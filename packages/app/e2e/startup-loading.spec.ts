import { test } from "./fixtures";
import { getE2EDaemonPort } from "./helpers/daemon-port";
import { getServerId } from "./helpers/server-id";
import { startupScenario } from "./helpers/startup-dsl";

test.describe("Startup loading presentation", () => {
  test("mobile reconnect preserves the saved host shell", async ({ page }) => {
    const startup = await startupScenario(page)
      .withMobileViewport()
      .withSavedHost({
        serverId: "srv_unreachable_mobile",
        label: "Dev",
        endpoint: "127.0.0.1:45678",
      })
      .openRoot();

    await startup.expectsSavedHostShell({ label: "Dev" });
    await startup.expectsNoSavedHostErrorStatus();
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
    const serverId = getServerId();
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
